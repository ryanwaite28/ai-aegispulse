package io.aegispulse.cases.adapters.http;

import io.aegispulse.cases.domain.CaseRecord;
import io.aegispulse.cases.domain.CaseWork;
import io.aegispulse.cases.service.CaseWorkService;
import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.platform.security.ServiceActionAuthorizer;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Internal case-work actions (FR-CASE-05..08). Transport only. */
@RestController
@RequestMapping("/internal/v1")
class CaseWorkController {
  private final ServiceActionAuthorizer authorizer;
  private final CaseWorkService work;

  CaseWorkController(ServiceActionAuthorizer authorizer, CaseWorkService work) {
    this.authorizer = authorizer;
    this.work = work;
  }

  static final String STATUS = "OPEN|ENRICHING|POLICY_EVALUATED|ESCALATED|CLEARED|RESOLVED";
  static final String TYPE = "TRANSACTION_RISK|DOCUMENT_RISK|EXTRACTION_REVIEW|CORRELATED";
  static final String SEVERITY = "LOW|MEDIUM|HIGH|CRITICAL";

  record ListCases(
      @Nullable @Min(1) @Max(100) Integer limit,
      @Nullable @Size(max = 1024) @Pattern(regexp = "^[A-Za-z0-9_-]+$") String cursor,
      @Nullable @Pattern(regexp = STATUS) String status,
      @Nullable @Pattern(regexp = TYPE) String caseType,
      @Nullable @Pattern(regexp = SEVERITY) String severity,
      @Nullable UUID assigneeUserId,
      @Nullable UUID entityId) {}

  record CaseRef(@NotNull UUID caseId) {}

  record Assign(
      @NotNull UUID caseId,
      @Nullable UUID assigneeUserId,
      @NotNull @Min(0) Integer expectedVersion) {}

  record AddNote(@NotNull UUID caseId, @NotBlank @Size(max = 4000) String body) {}

  record RecordDisposition(
      @NotNull UUID caseId,
      @NotNull @Pattern(regexp = "TRUE_POSITIVE|FALSE_POSITIVE|NEEDS_REVIEW") String disposition,
      @NotNull @Size(min = 20, max = 4000) String rationale) {}

  record Reevaluate(@NotNull UUID caseId, @NotBlank @Size(max = 2000) String reason) {}

  record Item(
      @NotNull @Pattern(regexp = "EVENT|FILE|EXTRACTION|RISK_EVALUATION|WATCHLIST_HIT")
          String evidenceType,
      @NotBlank @Size(max = 200) String evidenceRef,
      @Nullable @Pattern(regexp = "INFO|LOW|MEDIUM|HIGH|CRITICAL") String finalSeverity,
      @Nullable Map<String, @Nullable Object> summary) {}

  record Attach(
      @NotNull UUID tenantId,
      @NotNull UUID caseId,
      @NotEmpty @Size(max = 50) List<@Valid Item> items) {}

  record Listed(List<Map<String, @Nullable Object>> data, Success.Meta meta) {}

  @PostMapping("/listCases")
  Listed list(
      @Nullable Authentication auth,
      @RequestHeader(value = "X-Aegis-Tenant", required = false) @Nullable String acting,
      @Valid @RequestBody ListCases b) {
    AegisPrincipal p = authorizer.requireAction(auth, "cases.listCases");
    CaseWorkService.Page page =
        work.list(
            p,
            CasesController.actingTenant(acting),
            new CaseWork.Filter(
                b.status(), b.caseType(), b.severity(), b.assigneeUserId(), b.entityId()),
            b.limit(),
            b.cursor());
    Success<?> s = Success.of(List.of());
    return new Listed(
        page.items().stream().map(CasesController::view).toList(),
        new Success.Meta(s.meta().requestId(), s.meta().correlationId(), page.nextCursor()));
  }

  @PostMapping("/getCase")
  Success<Map<String, @Nullable Object>> get(
      @Nullable Authentication auth,
      @RequestHeader(value = "X-Aegis-Tenant", required = false) @Nullable String acting,
      @Valid @RequestBody CaseRef b) {
    CaseWorkService.Detail d =
        work.get(
            authorizer.requireAction(auth, "cases.getCase"),
            CasesController.actingTenant(acting),
            b.caseId());
    Map<String, @Nullable Object> m = CasesController.view(d.caseRecord());
    m.put("latestPolicyEvaluation", d.latestPolicy() == null ? null : policy(d.latestPolicy()));
    return Success.of(m);
  }

  @PostMapping("/getCaseTimeline")
  Success<Map<String, @Nullable Object>> timeline(
      @Nullable Authentication auth,
      @RequestHeader(value = "X-Aegis-Tenant", required = false) @Nullable String acting,
      @Valid @RequestBody CaseRef b) {
    CaseWork.Timeline t =
        work.timeline(
            authorizer.requireAction(auth, "cases.getCaseTimeline"),
            CasesController.actingTenant(acting),
            b.caseId());
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("caseId", t.caseId().toString());
    m.put("transitions", t.transitions().stream().map(CaseWorkController::transition).toList());
    m.put("evidence", t.evidence().stream().map(CaseWorkController::evidence).toList());
    m.put("notes", t.notes().stream().map(CaseWorkController::note).toList());
    m.put("dispositions", t.dispositions().stream().map(CaseWorkController::disposition).toList());
    return Success.of(m);
  }

  @PostMapping("/assignCase")
  Success<Map<String, @Nullable Object>> assign(
      @Nullable Authentication auth,
      @RequestHeader(value = "X-Aegis-Tenant", required = false) @Nullable String acting,
      @Valid @RequestBody Assign b) {
    CaseRecord c =
        work.assign(
            authorizer.requireAction(auth, "cases.assignCase"),
            CasesController.actingTenant(acting),
            b.caseId(),
            b.assigneeUserId(),
            b.expectedVersion());
    return Success.of(CasesController.view(c));
  }

  @PostMapping("/addCaseNote")
  ResponseEntity<Success<Map<String, @Nullable Object>>> addNote(
      @Nullable Authentication auth,
      @RequestHeader(value = "X-Aegis-Tenant", required = false) @Nullable String acting,
      @Valid @RequestBody AddNote b) {
    CaseWork.Note n =
        work.addNote(
            authorizer.requireAction(auth, "cases.addCaseNote"),
            CasesController.actingTenant(acting),
            b.caseId(),
            b.body());
    return ResponseEntity.status(201).body(Success.of(note(n)));
  }

  @PostMapping("/recordDisposition")
  ResponseEntity<Success<Map<String, @Nullable Object>>> disposition(
      @Nullable Authentication auth,
      @RequestHeader(value = "X-Aegis-Tenant", required = false) @Nullable String acting,
      @RequestHeader(value = "Idempotency-Key", required = false) @Nullable String key,
      @Valid @RequestBody RecordDisposition b) {
    CaseWorkService.DispositionResult r =
        work.recordDisposition(
            authorizer.requireAction(auth, "cases.recordDisposition"),
            CasesController.actingTenant(acting),
            key,
            b.caseId(),
            b.disposition(),
            b.rationale());
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("disposition", disposition(r.disposition()));
    m.put("case", CasesController.view(r.caseRecord()));
    return ResponseEntity.status(201).body(Success.of(m));
  }

  @PostMapping("/requestReevaluation")
  Success<Map<String, @Nullable Object>> reevaluate(
      @Nullable Authentication auth,
      @RequestHeader(value = "X-Aegis-Tenant", required = false) @Nullable String acting,
      @RequestHeader(value = "Idempotency-Key", required = false) @Nullable String key,
      @Valid @RequestBody Reevaluate b) {
    CaseRecord c =
        work.requestReevaluation(
            authorizer.requireAction(auth, "cases.requestReevaluation"),
            CasesController.actingTenant(acting),
            key,
            b.caseId(),
            b.reason());
    return Success.of(CasesController.view(c));
  }

  @PostMapping("/attachEvidence")
  Success<Map<String, @Nullable Object>> attach(
      @Nullable Authentication auth, @Valid @RequestBody Attach b) {
    List<CaseWork.EvidenceItem> items = new ArrayList<>();
    for (Item i : b.items()) {
      items.add(
          new CaseWork.EvidenceItem(
              i.evidenceType(), i.evidenceRef(), i.finalSeverity(), i.summary()));
    }
    CaseWorkService.AttachResult r =
        work.attachEvidence(
            authorizer.requireAction(auth, "cases.attachEvidence"),
            b.tenantId(),
            b.caseId(),
            items);
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("caseId", r.caseId().toString());
    m.put("attached", r.attached());
    m.put("duplicates", r.duplicates());
    m.put("reevaluationTriggered", r.reevaluationTriggered());
    m.put("newCaseId", r.newCaseId() == null ? null : r.newCaseId().toString());
    return Success.of(m);
  }

  static Map<String, @Nullable Object> policy(CaseWork.PolicyEvaluation e) {
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("id", e.id().toString());
    m.put("revision", e.revision());
    m.put("policyVersion", e.policyVersion());
    m.put("policyScore", e.policyScore());
    m.put("outcome", e.outcome());
    List<Map<String, @Nullable Object>> factors = new ArrayList<>();
    e.factors()
        .forEach((name, v) -> {
          Map<String, @Nullable Object> f = new LinkedHashMap<>();
          f.put("name", name);
          f.put("contribution", v instanceof Map<?, ?> vm ? vm.get("contribution") : null);
          f.put("value", v instanceof Map<?, ?> vm ? vm.get("value") : null);
          factors.add(f);
        });
    m.put("factors", factors);
    m.put("createdAt", e.createdAt().toInstant().toString());
    return m;
  }

  static Map<String, @Nullable Object> transition(CaseWork.Transition t) {
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("id", t.id().toString());
    m.put("fromStatus", t.fromStatus());
    m.put("toStatus", t.toStatus());
    m.put("triggerType", t.triggerType());
    m.put("triggerRef", t.triggerRef());
    m.put("caseVersion", t.caseVersion());
    m.put("createdAt", t.createdAt().toInstant().toString());
    return m;
  }

  static Map<String, @Nullable Object> evidence(CaseWork.Evidence e) {
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("id", e.id().toString());
    m.put("evidenceType", e.evidenceType());
    m.put("evidenceRef", e.evidenceRef());
    m.put("finalSeverity", e.finalSeverity());
    m.put("summary", e.summary());
    m.put("attachedBy", e.attachedBy());
    m.put("createdAt", e.createdAt().toInstant().toString());
    return m;
  }

  static Map<String, @Nullable Object> note(CaseWork.Note n) {
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("id", n.id().toString());
    m.put("caseId", n.caseId().toString());
    m.put("authorId", n.authorId().toString());
    m.put("body", n.body());
    m.put("lockedAt", n.lockedAt().toInstant().toString());
    m.put("createdAt", n.createdAt().toInstant().toString());
    return m;
  }

  static Map<String, @Nullable Object> disposition(CaseWork.Disposition d) {
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("id", d.id().toString());
    m.put("caseId", d.caseId().toString());
    m.put("disposition", d.disposition());
    m.put("rationale", d.rationale());
    m.put("analystId", d.analystId().toString());
    m.put("modelVersions", d.modelVersions());
    m.put("ruleVersions", d.ruleVersions());
    m.put("policyVersion", d.policyVersion());
    m.put("createdAt", d.createdAt().toInstant().toString());
    return m;
  }
}
