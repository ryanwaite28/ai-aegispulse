// Real infrastructure for ts-platform integration tests (PROJECT.md §12: no mocks of Postgres/RabbitMQ).
// - PostgreSQL 18 initialised by the compose init script and migrated by the real migrate image (as in slice 1a);
//   tests connect as the least-privilege runtime role svc_files.
// - RabbitMQ 4 with the contract topology asserted by the topology tool, plus a runtime user that has no configure
//   permission (§5.7.3), so the kit is proven to run without declaring anything.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoDBContainer } from "@testcontainers/mongodb";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RabbitMQContainer, type StartedRabbitMQContainer } from "@testcontainers/rabbitmq";
import pg from "pg";
import { GenericContainer, Network, Wait, type StartedNetwork } from "testcontainers";
import { assertTopology } from "../../../contracts/scripts/topology-assert.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const SCHEMAS = ["ingestion", "files", "registry", "cases", "analytics"] as const;

export interface PostgresEnv {
  readonly pool: pg.Pool;
  stop(): Promise<void>;
}

/** `role` is the runtime role the pool connects as (default svc_files): RLS and grants apply as in production. */
export async function startPostgres(role: (typeof SCHEMAS)[number] = "files"): Promise<PostgresEnv> {
  const secret = (): string => randomBytes(16).toString("hex");
  const env: Record<string, string> = { PG_BACKUP_PASSWORD: secret() };
  for (const s of SCHEMAS) {
    env[`PG_MIG_PASSWORD_${s.toUpperCase()}`] = secret();
    env[`PG_SVC_PASSWORD_${s.toUpperCase()}`] = secret();
  }
  const network: StartedNetwork = await new Network().start();
  const db: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:18.7-alpine")
    .withNetwork(network)
    .withNetworkAliases("postgres")
    .withDatabase("aegispulse")
    .withUsername("aegis_admin")
    .withPassword(secret())
    .withEnvironment(env)
    .withCopyFilesToContainer([
      {
        source: join(repoRoot, "deploy/compose/init/postgres/01-roles-schemas.sh"),
        target: "/docker-entrypoint-initdb.d/01-roles-schemas.sh",
        mode: 0o755,
      },
    ])
    .start();
  const image = await GenericContainer.fromDockerfile(repoRoot, "deploy/docker/migrate.Dockerfile").build(
    "aegispulse-migrate:test",
    {
      deleteOnExit: false,
    },
  );
  const run = await image
    .withNetwork(network)
    .withEnvironment({ ...env, PG_HOST: "postgres", PG_PORT: "5432", PG_DATABASE: "aegispulse" })
    .withWaitStrategy(Wait.forOneShotStartup())
    .withStartupTimeout(180_000)
    .start();
  let logs = "";
  for await (const chunk of await run.logs()) logs += String(chunk);
  await run.stop();
  if (!logs.includes("aegis-migrate: done")) throw new Error(`migrations failed:\n${logs}`);

  const pool = new pg.Pool({
    host: db.getHost(),
    port: db.getPort(),
    database: "aegispulse",
    user: `svc_${role === "analytics" ? "analytics" : role}`,
    password: env[`PG_SVC_PASSWORD_${role.toUpperCase()}`],
    max: 10,
  });
  // An idle client can receive the server's 57P01 (admin shutdown) while the container stops during teardown; without a
  // listener the pool re-throws it as an uncaught exception that fails an otherwise green run. Anything else surfaces.
  pool.on("error", (error: Error & { code?: string }) => {
    if (error.code !== "57P01") throw error;
  });
  return {
    pool,
    stop: async () => {
      await pool.end();
      await db.stop();
      await network.stop();
    },
  };
}

export interface RuntimeUser {
  readonly name: string;
  readonly write: string;
  readonly read: string;
}

export interface BrokerEnv {
  readonly container: StartedRabbitMQContainer;
  /** Admin URL (topology owner; test-side publishing and inspection). */
  readonly adminUrl: string;
  /** Creates a runtime user with configure '^$' and returns its URL. */
  addRuntimeUser(user: RuntimeUser): Promise<string>;
  ctl(...args: string[]): Promise<string>;
  stop(): Promise<void>;
}

export async function startBroker(): Promise<BrokerEnv> {
  const container = await new RabbitMQContainer("rabbitmq:4.4.1-management-alpine").start();
  const adminUrl = container.getAmqpUrl();
  await assertTopology(adminUrl, false);
  const ctl = async (...args: string[]): Promise<string> => {
    const res = await container.exec(["rabbitmqctl", "-q", ...args], { user: "rabbitmq" });
    if (res.exitCode !== 0) throw new Error(`rabbitmqctl ${args[0] ?? ""} failed: ${res.output}`);
    return res.output;
  };
  return {
    container,
    adminUrl,
    ctl,
    addRuntimeUser: async (user) => {
      const password = randomBytes(12).toString("hex");
      await ctl("add_user", user.name, password);
      await ctl("set_permissions", "-p", "/", user.name, "^$", user.write, user.read);
      const url = new URL(adminUrl);
      url.username = user.name;
      url.password = password;
      return url.toString();
    },
    stop: async () => {
      await container.stop();
    },
  };
}

export interface RedisEnv {
  /** redis:// URL for the given compose ACL user (rendered from deploy/compose/init/redis/redis.conf.tmpl). */
  readonly url: string;
  stop(): Promise<void>;
}

/** Redis 8 with the compose ACL template, so a service connects as its real ACL user (§5.7.3). */
export async function startRedis(aclUser: string, passwordVar: string): Promise<RedisEnv> {
  const { readFileSync } = await import("node:fs");
  const password = randomBytes(16).toString("hex");
  const conf = readFileSync(join(repoRoot, "deploy/compose/init/redis/redis.conf.tmpl"), "utf8")
    .replace(`__${passwordVar}__`, password)
    .replace(/__[A-Z0-9_]+__/g, () => randomBytes(16).toString("hex"))
    .replace("appendonly yes", "appendonly no");
  const container = await new GenericContainer("redis:8.10.3-alpine")
    .withCopyContentToContainer([{ content: conf, target: "/etc/redis/redis.conf" }])
    .withCommand(["redis-server", "/etc/redis/redis.conf"])
    .withExposedPorts(6379)
    .start();
  return {
    url: `redis://${aclUser}:${password}@${container.getHost()}:${String(container.getMappedPort(6379))}/0`,
    stop: async () => {
      await container.stop();
    },
  };
}

export interface ObjectStoreEnv {
  readonly endpoint: string;
  /** Values substituted into s3.json.tmpl, keyed by placeholder name (e.g. S3_INGESTION_ACCESS_KEY). */
  readonly secrets: Readonly<Record<string, string>>;
  stop(): Promise<void>;
}

/**
 * SeaweedFS S3 (the compose image) with the compose identity template (deploy/compose/init/objectstore/s3.json.tmpl),
 * so a service writes as its real, prefix-restricted identity (§5.7.3). Callers create buckets with the admin
 * identity (`secrets.S3_ADMIN_*`) using their own S3 client; the S3 gateway may answer before the filer is ready,
 * so retry the first CreateBucket.
 */
export async function startObjectStore(): Promise<ObjectStoreEnv> {
  const { readFileSync } = await import("node:fs");
  const secrets: Record<string, string> = {};
  const conf = readFileSync(join(repoRoot, "deploy/compose/init/objectstore/s3.json.tmpl"), "utf8").replace(
    /__([A-Z0-9_]+)__/g,
    (_m: string, name: string) => (secrets[name] ??= randomBytes(16).toString("hex")),
  );
  const container = await new GenericContainer("chrislusf/seaweedfs:4.54")
    .withCopyContentToContainer([{ content: conf, target: "/etc/seaweedfs/s3.json" }])
    .withCommand([
      "server",
      "-s3",
      "-s3.config=/etc/seaweedfs/s3.json",
      "-dir=/data",
      "-volume.max=0",
      "-master.volumeSizeLimitMB=64",
    ])
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000)
    .start();
  return {
    endpoint: `http://${container.getHost()}:${String(container.getMappedPort(8333))}`,
    secrets,
    stop: async () => {
      await container.stop();
    },
  };
}

/** Test-side only: an exclusive queue bound to `exchange` with `bindingKey`, declared with the admin user. */
export async function bindTestQueue(adminUrl: string, exchange: string, bindingKey: string): Promise<string> {
  const amqp = (await import("amqplib")).default;
  const conn = await amqp.connect(adminUrl);
  const ch = await conn.createChannel();
  const name = `test.${randomBytes(4).toString("hex")}`;
  await ch.assertQueue(name, { durable: true, autoDelete: false }); // RabbitMQ 4: no transient non-exclusive queues
  await ch.bindQueue(name, exchange, bindingKey);
  await conn.close();
  return name;
}

/** Drains a queue and returns the parsed JSON bodies (test-side inspection). */
export async function drainQueue(adminUrl: string, queue: string): Promise<unknown[]> {
  const amqp = (await import("amqplib")).default;
  const conn = await amqp.connect(adminUrl);
  const ch = await conn.createChannel();
  const out: unknown[] = [];
  for (;;) {
    const m = await ch.get(queue, { noAck: true });
    if (m === false) break;
    out.push(JSON.parse(m.content.toString("utf8")) as unknown);
  }
  await conn.close();
  return out;
}

export interface MongoEnv {
  /** Single-node replica set (multi-document transactions work), `directConnection=true`. */
  readonly uri: string;
  stop(): Promise<void>;
}

/** MongoDB 8 (same image as compose) as a one-member replica set; callers run their own migrations. */
export async function startMongo(): Promise<MongoEnv> {
  const container = await new MongoDBContainer("mongo:8.0.38").withStartupTimeout(120_000).start();
  const base = container.getConnectionString();
  return {
    uri: `${base}${base.includes("?") ? "&" : "?"}directConnection=true`,
    stop: async () => {
      await container.stop();
    },
  };
}
