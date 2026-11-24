// Real infrastructure for ts-platform integration tests (PROJECT.md §12: no mocks of Postgres/RabbitMQ).
// - PostgreSQL 18 initialised by the compose init script and migrated by the real migrate image (as in slice 1a);
//   tests connect as the least-privilege runtime role svc_files.
// - RabbitMQ 4 with the contract topology asserted by the topology tool, plus a runtime user that has no configure
//   permission (§5.7.3), so the kit is proven to run without declaring anything.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
