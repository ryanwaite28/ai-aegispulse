package io.aegispulse.cases.adapters.http;

import io.aegispulse.cases.domain.AuditEntry;
import io.aegispulse.cases.domain.AuditFilter;
import io.aegispulse.cases.domain.ChainVerification;
import io.aegispulse.cases.service.AuditLogService;
import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.platform.security.ServiceActionAuthorizer;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Internal audit actions (FR-AUD-03): listAuditEntries, verifyAuditChain. Transport only. */
@RestController
@RequestMapping("/internal/v1")
class AuditController {
  private final ServiceActionAuthorizer authorizer;
  private final AuditLogService audit;

  AuditController(ServiceActionAuthorizer authorizer, AuditLogService audit) {
    this.authorizer = authorizer;
    this.audit = audit;
  }

  record ListAudit(
      @Nullable @Min(1) @Max(100) Integer limit,
      @Nullable @Size(max = 1024) @Pattern(regexp = "^[A-Za-z0-9_-]+$") String cursor,
      @Nullable @Size(max = 100) String subjectType,
      @Nullable @Size(max = 200) String subjectId,
      @Nullable @Size(max = 200) String actorId,
      @Nullable @Size(max = 100) String action,
      @Nullable OffsetDateTime from,
      @Nullable OffsetDateTime to) {}

  record VerifyChain(
      @Nullable UUID tenantId, @Nullable @Min(1) Long fromSeq, @Nullable @Min(1) Long toSeq) {}

  record Listed(List<Map<String, @Nullable Object>> data, Success.Meta meta) {}

  @PostMapping("/listAuditEntries")
  Listed list(
      @Nullable Authentication auth,
      @RequestHeader(value = "X-Aegis-Tenant", required = false) @Nullable String acting,
      @Valid @RequestBody ListAudit body) {
    AegisPrincipal p = authorizer.requireAction(auth, "cases.listAuditEntries");
    AuditLogService.Page page =
        audit.list(
            p,
            CasesController.actingTenant(acting),
            new AuditFilter(
                body.subjectType(),
                body.subjectId(),
                body.actorId(),
                body.action(),
                body.from(),
                body.to()),
            body.limit(),
            body.cursor());
    Success<?> meta = Success.of(List.of());
    return new Listed(
        page.items().stream().map(AuditController::view).toList(),
        new Success.Meta(meta.meta().requestId(), meta.meta().correlationId(), page.nextCursor()));
  }

  @PostMapping("/verifyAuditChain")
  Success<Map<String, @Nullable Object>> verify(
      @Nullable Authentication auth,
      @RequestHeader(value = "X-Aegis-Tenant", required = false) @Nullable String acting,
      @Valid @RequestBody VerifyChain body) {
    AegisPrincipal p = authorizer.requireAction(auth, "cases.verifyAuditChain");
    ChainVerification v =
        audit.verify(
            p, CasesController.actingTenant(acting), body.tenantId(), body.fromSeq(), body.toSeq());
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("valid", v.valid());
    m.put("checked", v.checked());
    if (!v.valid()) {
      m.put("firstBrokenSeq", v.firstBrokenSeq());
      m.put("code", "AUDIT_CHAIN_BROKEN");
    }
    return Success.of(m);
  }

  /** Contract AuditEntry. */
  static Map<String, @Nullable Object> view(AuditEntry e) {
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("id", e.id().toString());
    m.put("seq", e.seq());
    m.put("occurredAt", e.occurredAt().toInstant().toString());
    m.put("actorType", e.actorType());
    m.put("actorId", e.actorId());
    m.put("actingAs", e.actingAs());
    m.put("action", e.action());
    m.put("subjectType", e.subjectType());
    m.put("subjectId", e.subjectId());
    m.put("triggerEventId", e.triggerEventId() == null ? null : e.triggerEventId().toString());
    m.put("triggerFileId", e.triggerFileId() == null ? null : e.triggerFileId().toString());
    m.put("modelVersion", e.modelVersion());
    m.put("ruleVersion", e.ruleVersion());
    m.put("before", e.before());
    m.put("after", e.after());
    m.put("prevHash", e.prevHash());
    m.put("hash", e.hash());
    return m;
  }
}
