package io.aegispulse.cases.service;

import io.aegispulse.cases.domain.CaseRecord;
import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * openCase (FR-CASE-01) for the orchestrator: one tenant transaction around {@link
 * CaseService#open}.
 */
@Service
public class CaseOpening {
  private final CaseService cases;
  private final TenantScope scope;

  public CaseOpening(CaseService cases, TenantScope scope) {
    this.cases = cases;
    this.scope = scope;
  }

  @Transactional
  public CaseRecord open(AegisPrincipal principal, Commands.OpenCase cmd) {
    if (!(principal instanceof AegisPrincipal.Service)) {
      throw new DomainException.Forbidden("FORBIDDEN", "openCase is called by sagas only");
    }
    scope.apply(cmd.tenantId());
    return cases
        .open(
            new CaseService.NewCase(
                cmd.tenantId(),
                cmd.caseType(),
                cmd.severity(),
                cmd.triggerEventId(),
                cmd.triggerFileId(),
                cmd.primaryEntityIds() == null ? List.of() : List.copyOf(cmd.primaryEntityIds()),
                cmd.openIdempotencyKey(),
                cmd.previousCaseId(),
                null),
            Actor.of(principal))
        .caseRow();
  }
}
