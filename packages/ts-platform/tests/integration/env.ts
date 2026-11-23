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

export async function startPostgres(): Promise<PostgresEnv> {
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
    user: "svc_files",
    password: env["PG_SVC_PASSWORD_FILES"],
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
