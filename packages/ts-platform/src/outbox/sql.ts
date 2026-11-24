// Minimal SQL executor port. A `pg` Pool or PoolClient satisfies it directly; a Kysely transaction can be adapted
// with `CompiledQuery.raw(text, values)`. Repositories take the caller's transaction-bound executor, so outbox
// inserts and dedup marks commit atomically with the service's state change (ADR-0004).
export interface SqlResult<R> {
  readonly rows: R[];
  readonly rowCount: number | null;
}

export interface SqlExecutor {
  query<R = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlResult<R>>;
}

/** A pooled connection that must be released (pg PoolClient shape). */
export interface SqlClient extends SqlExecutor {
  release(error?: Error | boolean): void;
}

export interface SqlPool extends SqlExecutor {
  connect(): Promise<SqlClient>;
}

const SCHEMA_NAME = /^[a-z][a-z_]*$/;

/** Validates and quotes a schema identifier (schemas are fixed per service, never user input). */
export function quoteSchema(schema: string): string {
  if (!SCHEMA_NAME.test(schema)) throw new TypeError(`invalid schema name ${JSON.stringify(schema)}`);
  return `"${schema}"`;
}

/**
 * Runs `fn` in a transaction on a dedicated client (no tenant context: tenant tables fail closed under RLS).
 * There is deliberately no "bypass" variant: cross-tenant work calls the migration-defined SECURITY DEFINER
 * functions owned by `{schema}_platform` (PROJECT.md §7.0, ADR-0016).
 */
export function withTransaction<T>(pool: SqlPool, fn: (tx: SqlClient) => Promise<T>): Promise<T> {
  return runTransaction(pool, [], fn);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tenant-scoped transaction (§7.0, NFR-06): `SET LOCAL app.tenant_id` first, so RLS admits only that tenant's rows.
 * Every request- or message-driven unit of work on tenant tables uses this.
 */
export function withTenantTransaction<T>(
  pool: SqlPool,
  tenantId: string,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) throw new TypeError("tenantId must be a UUID");
  return runTransaction(pool, [["SELECT set_config('app.tenant_id', $1, true)", [tenantId]]], fn);
}

async function runTransaction<T>(
  pool: SqlPool,
  setup: ReadonlyArray<readonly [string, readonly unknown[]]>,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [text, values] of setup) await client.query(text, values);
    const result = await fn(client);
    await client.query("COMMIT");
    client.release();
    return result;
  } catch (error: unknown) {
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch (rollbackError: unknown) {
      // A connection that can't roll back is discarded from the pool.
      client.release(rollbackError instanceof Error ? rollbackError : true);
    }
    throw error;
  }
}
