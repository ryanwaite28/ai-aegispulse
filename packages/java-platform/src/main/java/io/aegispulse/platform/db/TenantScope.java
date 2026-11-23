package io.aegispulse.platform.db;

import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Row-level security context (§7.0, NFR-06): call first inside a transaction to {@code SET LOCAL
 * app.tenant_id}. There is no bypass: cross-tenant work calls the migration-defined SECURITY
 * DEFINER functions owned by {@code {schema}_platform} (ADR-0016). Outside a transaction the
 * setting would leak to the pooled connection, so that is refused.
 */
public final class TenantScope {
  private final JdbcClient jdbc;

  public TenantScope(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public void apply(UUID tenantId) {
    requireTransaction();
    jdbc.sql("SELECT set_config('app.tenant_id', ?, true)")
        .param(tenantId.toString())
        .query()
        .singleValue();
  }

  private static void requireTransaction() {
    if (!TransactionSynchronizationManager.isActualTransactionActive()) {
      throw new IllegalStateException("TenantScope requires an active transaction (SET LOCAL)");
    }
  }
}
