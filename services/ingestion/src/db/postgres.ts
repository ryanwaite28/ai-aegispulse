// PostgreSQL pool for the `ingestion` schema, connected as svc_ingestion (§5.7.2). Repositories live next to it.
import pg from "pg";
import type { Config } from "../config.js";

export function createPostgresPool(config: Config): pg.Pool {
  return new pg.Pool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    database: config.PG_DATABASE,
    user: config.PG_USER,
    password: config.PG_PASSWORD,
    max: 10,
    connectionTimeoutMillis: 5_000,
    application_name: "aegispulse-ingestion",
  });
}
