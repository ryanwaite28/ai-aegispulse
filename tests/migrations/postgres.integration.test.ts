// Phase 1 data foundations (PROJECT.md §11 Phase 1, §5.7.2, §7.0, ADR-0005): applies every PostgreSQL migration with the
// real migrate image to an empty PostgreSQL 18 initialised by the real compose init script, then asserts grants and RLS.
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { GenericContainer, Network, type StartedNetwork, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const schemas = ["ingestion", "files", "registry", "cases", "analytics"] as const;
const MIGRATION_DIRS: Record<(typeof schemas)[number], string> = {
  ingestion: "services/ingestion/db/migrations",
  files: "services/files/db/migrations",
  registry: "services/registry/src/main/resources/db/migration",
  cases: "services/cases/src/main/resources/db/migration",
  analytics: "services/data-intel/db/migrations",
};
/** Highest V{n}__ migration on disk for a schema: the history must end there (assertions follow new migrations). */
const latestVersion = (s: (typeof schemas)[number]): number =>
  Math.max(
    ...readdirSync(join(root, MIGRATION_DIRS[s]))
      .map((f) => /^V(\d+)__/.exec(f)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number),
  );
const secret = (): string => randomBytes(16).toString("hex");
const env: Record<string, string> = { PG_BACKUP_PASSWORD: secret() };
for (const s of schemas) {
  env[`PG_MIG_PASSWORD_${s.toUpperCase()}`] = secret();
  env[`PG_SVC_PASSWORD_${s.toUpperCase()}`] = secret();
}

describe("PostgreSQL migrations + role model (ADR-0005, NFR-06)", () => {
  let network: StartedNetwork;
  let db: StartedPostgreSqlContainer;
  let migrateLogs = "";

  const connect = async (user: string, password: string): Promise<pg.Client> => {
    const c = new pg.Client({ host: db.getHost(), port: db.getPort(), database: "aegispulse", user, password });
    await c.connect();
    return c;
  };
  const svc = (s: (typeof schemas)[number]): Promise<pg.Client> =>
    connect(`svc_${s}`, env[`PG_SVC_PASSWORD_${s.toUpperCase()}`] ?? "");

  beforeAll(async () => {
    network = await new Network().start();
    db = await new PostgreSqlContainer("postgres:18.7-alpine")
      .withNetwork(network)
      .withNetworkAliases("postgres")
      .withDatabase("aegispulse")
      .withUsername("aegis_admin")
      .withPassword(secret())
      .withEnvironment(env)
      .withCopyFilesToContainer([
        {
          source: join(root, "deploy/compose/init/postgres/01-roles-schemas.sh"),
          target: "/docker-entrypoint-initdb.d/01-roles-schemas.sh",
          mode: 0o755,
        },
      ])
      .start();
    const image = await GenericContainer.fromDockerfile(root, "deploy/docker/migrate.Dockerfile").build(
      "aegispulse-migrate:test",
      { deleteOnExit: false },
    );
    const run = await image
      .withNetwork(network)
      .withEnvironment({ ...env, PG_HOST: "postgres", PG_PORT: "5432", PG_DATABASE: "aegispulse" })
      .withWaitStrategy(Wait.forOneShotStartup())
      .withStartupTimeout(180_000)
      .start();
    const logs = await run.logs();
    for await (const chunk of logs) migrateLogs += chunk.toString();
    await run.stop();
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
    await network?.stop();
  });

  it("migrates every schema with the migrate image", () => {
    expect(migrateLogs).toContain("aegis-migrate: done");
    for (const s of schemas) {
      // Flyway pads the type column (e.g. to "Repeatable" when a schema has repeatable migrations).
      for (let v = 1; v <= latestVersion(s); v++) {
        expect(migrateLogs).toMatch(new RegExp(`${s}: \\| Versioned\\s+\\| ${String(v)}\\s.*Success`));
      }
    }
  });

  it.each(schemas)("creates the outbox in %s with a unique event_id", async (s) => {
    const c = await svc(s);
    const r = await c.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = $1 and tablename = 'outbox_events'",
      [s],
    );
    expect(r.rows.map((x) => x.indexname)).toContain("ux_outbox_event_id");
    await c.end();
  });

  it.each(schemas)("lets svc_%s read but never modify its migration history", async (s) => {
    const c = await svc(s);
    const v = await c.query<{ v: string }>(`select max(version) as v from ${s}.flyway_schema_history`);
    expect(v.rows[0]?.v).toBe(String(latestVersion(s)));
    await expect(c.query(`delete from ${s}.flyway_schema_history`)).rejects.toThrow(/permission denied/);
    await c.end();
  });

  it.each(schemas)("denies svc_%s DDL in its own schema", async (s) => {
    const c = await svc(s);
    await expect(c.query(`create table ${s}.rogue(id int)`)).rejects.toThrow(/permission denied/);
    await c.end();
  });

  it("denies every service role access to every other schema", async () => {
    for (const owner of schemas) {
      const c = await svc(owner);
      for (const other of schemas.filter((x) => x !== owner)) {
        await expect(c.query(`select 1 from ${other}.outbox_events limit 1`), `${owner} -> ${other}`).rejects.toThrow(
          /permission denied/,
        );
      }
      await c.end();
    }
  });

  it("enforces tenant RLS on idempotency_records, failing closed without tenant context", async () => {
    const c = await svc("cases");
    const tA = "11111111-1111-1111-1111-111111111111";
    const tB = "22222222-2222-2222-2222-222222222222";
    await c.query("begin");
    await c.query(`set local app.tenant_id = '${tA}'`);
    await c.query(
      "insert into cases.idempotency_records values ($1,'scope','k1','h',null,null,now() + interval '1 day')",
      [tA],
    );
    await c.query("commit");
    await c.query("begin");
    await c.query(`set local app.tenant_id = '${tB}'`);
    expect((await c.query("select * from cases.idempotency_records")).rowCount).toBe(0);
    await expect(
      c.query("insert into cases.idempotency_records values ($1,'scope','k2','h',null,null,now())", [tA]),
    ).rejects.toThrow(/row-level security/);
    await c.query("rollback");
    expect((await c.query("select * from cases.idempotency_records")).rowCount).toBe(0);
    await c.end();
  });

  it("cannot lift RLS with a session setting: app.bypass_rls is ignored (ADR-0016)", async () => {
    const c = await svc("cases");
    const tA = "33333333-3333-3333-3333-333333333333";
    await c.query("begin");
    await c.query(`set local app.tenant_id = '${tA}'`);
    await c.query(
      "insert into cases.idempotency_records values ($1,'scope','k9','h',null,null,now() + interval '1 day')",
      [tA],
    );
    await c.query("commit");
    await c.query("begin");
    await c.query("set local app.bypass_rls = 'on'"); // the old convention: must have no effect now
    expect((await c.query("select * from cases.idempotency_records")).rowCount).toBe(0);
    await expect(
      c.query("insert into cases.idempotency_records values ($1,'scope','k10','h',null,null,now())", [tA]),
    ).rejects.toThrow(/row-level security/);
    await c.query("rollback");
    await expect(c.query("select cases.rls_bypassed()")).rejects.toThrow(/does not exist/);
    await c.end();
  });

  it.each(["ingestion", "files", "registry", "cases"] as const)(
    "exposes cross-tenant purge to svc_%s only as a SECURITY DEFINER function owned by %s_platform",
    async (s) => {
      const c = await svc(s);
      const r = await c.query<{ owner: string; definer: boolean; bypass: boolean; login: boolean }>(
        `select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer, r.rolbypassrls as bypass, r.rolcanlogin as login
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
          where n.nspname = $1 and p.proname = 'purge_expired_idempotency_records'`,
        [s],
      );
      expect(r.rows).toEqual([{ owner: `${s}_platform`, definer: true, bypass: true, login: false }]);
      await expect(c.query(`select ${s}.purge_expired_idempotency_records() as n`)).resolves.toBeDefined();
      // the service role can neither become the platform role nor log in as it
      await expect(c.query(`set role ${s}_platform`)).rejects.toThrow(/permission denied/);
      await c.end();
      const other = await svc(s === "files" ? "cases" : "files");
      await expect(other.query(`select ${s}.purge_expired_idempotency_records()`)).rejects.toThrow(/permission denied/);
      await other.end();
    },
  );

  it("grants backup_reader read-only access across schemas", async () => {
    const c = await connect("backup_reader", env["PG_BACKUP_PASSWORD"] ?? "");
    await expect(c.query("select count(*) from files.outbox_events")).resolves.toBeDefined();
    await expect(c.query("delete from files.outbox_events")).rejects.toThrow(/permission denied/);
    await c.end();
  });
});
