package io.aegispulse.registry.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.registry.domain.PlatformTenant;
import io.aegispulse.registry.service.PlatformAdminBootstrap;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** FR-TEN-09: first PLATFORM_ADMIN bootstrap is idempotent; the platform role is DB-confined. */
class PlatformBootstrapIT extends RegistryIt {
  @Autowired PlatformAdminBootstrap bootstrap;
  @Autowired JdbcClient jdbc;
  @Autowired PlatformTransactionManager transactions;

  @Test
  void FR_TEN_09_firstRunCreatesSecondRunIsNoop() {
    assertThatThrownBy(() -> bootstrap.run("ops@aegispulse.example", "password123456"))
        .isInstanceOf(DomainException.Validation.class);
    assertThat(bootstrap.run("Ops@AegisPulse.example", "violet-Harbor-71-quartz!"))
        .isEqualTo(PlatformAdminBootstrap.Outcome.CREATED);
    assertThat(bootstrap.run("someone.else@aegispulse.example", "violet-Harbor-71-quartz!"))
        .isEqualTo(PlatformAdminBootstrap.Outcome.NOOP);

    TransactionTemplate tx = new TransactionTemplate(transactions);
    Boolean mustChange =
        tx.execute(s -> {
          scope(PlatformTenant.ID);
          return jdbc.sql(
                  "SELECT u.must_change_password FROM registry.users u"
                      + " JOIN registry.user_roles r ON r.user_id = u.id WHERE r.role = 'PLATFORM_ADMIN'"
                      + " AND u.email = 'ops@aegispulse.example'")
              .query(Boolean.class)
              .single();
        });
    assertThat(mustChange).isTrue();
    assertThat(
            awaitEvents(
                e ->
                    e.eventType().equals("registry.user.changed")
                        && PlatformTenant.ID.toString().equals(e.tenantId()),
                1))
        .singleElement()
        .satisfies(e -> assertThat(e.payload()).doesNotContainKey("actorId"));
  }

  @Test
  void FR_TEN_09_platformAdminRoleIsConfinedToThePlatformTenant() {
    UUID tenant = createTenant("confine-it");
    UUID admin = createFirstAdmin(tenant, "admin@confine-it.example");
    TransactionTemplate tx = new TransactionTemplate(transactions);
    assertThatThrownBy(() ->
            tx.executeWithoutResult(s -> {
              scope(tenant);
              jdbc.sql(
                      "INSERT INTO registry.user_roles (tenant_id, user_id, role) VALUES (?, ?, 'PLATFORM_ADMIN')")
                  .params(tenant, admin)
                  .update();
            }))
        .isInstanceOf(DataIntegrityViolationException.class)
        .hasMessageContaining("ck_user_roles_platform");
  }

  private void scope(UUID tenantId) {
    jdbc.sql("SELECT set_config('app.tenant_id', ?, true)")
        .param(tenantId.toString())
        .query()
        .singleValue();
  }
}
