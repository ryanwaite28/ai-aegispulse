package io.aegispulse.cases.service;

import io.aegispulse.cases.db.CaseRepository;
import io.aegispulse.cases.db.CaseWorkRepository;
import io.aegispulse.cases.domain.CaseRecord;
import io.aegispulse.cases.domain.CaseStatus;
import io.aegispulse.cases.domain.CaseWork;
import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

/**
 * Analyst case work (FR-CASE-05/06/07/08; spec FR-CASE-05-08-case-work). Every write runs in one
 * tenant transaction with its audit entry and events.
 *
 * <ul>
 *   <li>list / get (+ latest policy evaluation) / timeline: VIEWER+ of the tenant.
 *   <li>assign: ANALYST+; {@code expectedVersion} must match (else 409 CASE_CONFLICT).
 *   <li>notes: ANALYST+; ≤ 4,000 chars; immutable (locked_at = created + 15 min, and no edit
 *       action).
 *   <li>dispositions: ANALYST+, rationale ≥ 20 chars, on ESCALATED/CLEARED only.
 *       <ul>
 *         <li>NEEDS_REVIEW keeps the status and records the reviewer (four-eyes).
 *         <li>TRUE_POSITIVE / FALSE_POSITIVE resolve the case. While a NEEDS_REVIEW is pending, the
 *             same analyst gets 409 CASE_FOUR_EYES_REQUIRED.
 *         <li>Idempotent by Idempotency-Key, or by a key derived from case + analyst + disposition
 *             + rationale.
 *         <li>Emits case.disposition.recorded with the model and policy versions in effect.
 *       </ul>
 *   <li>requestReevaluation: ESCALATED/CLEARED → ENRICHING → policy now (no async enrichment source
 *       in this phase).
 *   <li>attachEvidence (sagas): idempotent per (case, type, ref).
 *       <ul>
 *         <li>New evidence on ESCALATED/CLEARED re-evaluates.
 *         <li>On RESOLVED it opens a CORRELATED case linking previousCaseId, holding the evidence.
 *       </ul>
 * </ul>
 */
@Service
public class CaseWorkService {
  private static final Logger log = LoggerFactory.getLogger(CaseWorkService.class);
  private static final int DEFAULT_LIMIT = 25;
  public static final int MIN_RATIONALE = 20;

  private final CaseRepository cases;
  private final CaseWorkRepository work;
  private final CaseService caseService;
  private final PolicyEvaluationService policy;
  private final AuditService audit;
  private final CaseEvents events;
  private final TenantScope scope;
  private final JsonMapper json;
  private final Clock clock;

  public CaseWorkService(
      CaseRepository cases,
      CaseWorkRepository work,
      CaseService caseService,
      PolicyEvaluationService policy,
      AuditService audit,
      CaseEvents events,
      TenantScope scope,
      JsonMapper json,
      Clock clock) {
    this.cases = cases;
    this.work = work;
    this.caseService = caseService;
    this.policy = policy;
    this.audit = audit;
    this.events = events;
    this.scope = scope;
    this.json = json;
    this.clock = clock;
  }

  public record Page(List<CaseRecord> items, @Nullable String nextCursor) {}

  public record Detail(CaseRecord caseRecord, CaseWork.@Nullable PolicyEvaluation latestPolicy) {}

  public record DispositionResult(CaseWork.Disposition disposition, CaseRecord caseRecord) {}

  public record AttachResult(
      UUID caseId,
      int attached,
      int duplicates,
      boolean reevaluationTriggered,
      @Nullable UUID newCaseId) {}

  // ── reads ────────────────────────────────────────────────────────────────────

  @Transactional(readOnly = true)
  public Page list(
      AegisPrincipal p,
      @Nullable UUID acting,
      CaseWork.Filter f,
      @Nullable Integer limit,
      @Nullable String cursor) {
    UUID tenant = enter(p, acting, "readCases");
    int n = limit == null ? DEFAULT_LIMIT : limit;
    OffsetDateTime beforeAt = null;
    UUID beforeId = null;
    if (cursor != null) {
      String[] parts = decode(cursor).split("\\|", 2);
      try {
        beforeAt = OffsetDateTime.parse(parts[0]);
        beforeId = UUID.fromString(parts[1]);
      } catch (RuntimeException e) {
        throw invalid("cursor", "invalid cursor");
      }
    }
    List<UUID> ids = work.listIds(tenant, f, beforeAt, beforeId, n + 1);
    List<CaseRecord> items = new ArrayList<>();
    for (UUID id : ids.subList(0, Math.min(n, ids.size()))) {
      cases.findById(tenant, id).ifPresent(items::add);
    }
    String next = null;
    if (ids.size() > n && !items.isEmpty()) {
      CaseRecord last = items.getLast();
      next = encode(last.createdAt() + "|" + last.id());
    }
    return new Page(items, next);
  }

  @Transactional(readOnly = true)
  public Detail get(AegisPrincipal p, @Nullable UUID acting, UUID caseId) {
    UUID tenant = enter(p, acting, "readCases");
    CaseRecord c = load(tenant, caseId);
    return new Detail(c, work.latestPolicy(caseId).orElse(null));
  }

  @Transactional(readOnly = true)
  public CaseWork.Timeline timeline(AegisPrincipal p, @Nullable UUID acting, UUID caseId) {
    UUID tenant = enter(p, acting, "readCases");
    load(tenant, caseId);
    return work.timeline(caseId);
  }

  // ── writes ───────────────────────────────────────────────────────────────────

  @Transactional
  public CaseRecord assign(
      AegisPrincipal p,
      @Nullable UUID acting,
      UUID caseId,
      @Nullable UUID assignee,
      int expectedVersion) {
    UUID tenant = enter(p, acting, "workCases");
    UUID actor = userId(p);
    CaseRecord before = load(tenant, caseId);
    if (before.version() != expectedVersion
        || !work.assign(tenant, caseId, expectedVersion, assignee)) {
      throw new DomainException.Conflict(
          "CASE_CONFLICT", "the case changed (version " + before.version() + "); reload and retry");
    }
    CaseRecord after = load(tenant, caseId);
    audit.append(
        entry(
            after,
            actorOf(p, actor),
            "CASE_ASSIGNED",
            CaseService.state(before),
            CaseService.state(after)));
    return after;
  }

  @Transactional
  public CaseWork.Note addNote(AegisPrincipal p, @Nullable UUID acting, UUID caseId, String body) {
    UUID tenant = enter(p, acting, "workCases");
    UUID actor = userId(p);
    CaseRecord c = load(tenant, caseId);
    CaseWork.Note note = work.insertNote(tenant, caseId, actor, body);
    audit.append(
        entry(
            c,
            actorOf(p, actor),
            "CASE_NOTE_ADDED",
            null,
            Map.of("noteId", note.id().toString(), "length", body.length())));
    return note;
  }

  @Transactional
  public DispositionResult recordDisposition(
      AegisPrincipal p,
      @Nullable UUID acting,
      @Nullable String idempotencyKey,
      UUID caseId,
      String disposition,
      String rationale) {
    UUID tenant = enter(p, acting, "workCases");
    UUID analyst = userId(p);
    if (rationale.strip().length() < MIN_RATIONALE) {
      throw invalid("rationale", "at least " + MIN_RATIONALE + " characters");
    }
    String key =
        idempotencyKey != null
            ? "idem:" + idempotencyKey
            : "derived:"
                + sha256(caseId + "|" + analyst + "|" + disposition + "|" + rationale.strip());
    Optional<CaseWork.Disposition> existing = work.findDisposition(tenant, key);
    if (existing.isPresent()) {
      return new DispositionResult(existing.get(), load(tenant, caseId));
    }
    CaseRecord c = load(tenant, caseId);
    if (c.status() != CaseStatus.ESCALATED && c.status() != CaseStatus.CLEARED) {
      throw new DomainException.Conflict(
          "CASE_INVALID_TRANSITION",
          "dispositions apply to ESCALATED or CLEARED cases (case is " + c.status() + ")");
    }
    boolean final_ = !"NEEDS_REVIEW".equals(disposition);
    if (final_
        && "NEEDS_REVIEW".equals(c.pendingDisposition())
        && analyst.equals(pendingReviewer(tenant, caseId))) {
      throw new DomainException.Conflict(
          "CASE_FOUR_EYES_REQUIRED", "a different analyst must record the final disposition");
    }
    List<String> models = work.modelVersions(caseId);
    List<String> rules = work.ruleVersions(caseId);
    CaseWork.Disposition d =
        work.insertDisposition(
            tenant,
            caseId,
            disposition,
            rationale.strip(),
            analyst,
            models,
            rules,
            c.policyVersion(),
            key);
    Actor actor = actorOf(p, analyst);
    CaseRecord after;
    if (final_) {
      if (c.pendingDisposition() != null
          && !work.setPending(tenant, caseId, c.version(), null, null)) {
        throw new DomainException.Conflict("CASE_CONFLICT", "the case changed concurrently; retry");
      }
      after =
          caseService.transition(
              tenant, caseId, CaseStatus.RESOLVED, "disposition:" + d.id(), actor, null);
    } else {
      if (!work.setPending(tenant, caseId, c.version(), "NEEDS_REVIEW", analyst)) {
        throw new DomainException.Conflict("CASE_CONFLICT", "the case changed concurrently; retry");
      }
      after = load(tenant, caseId);
    }
    Map<String, @Nullable Object> recorded = new LinkedHashMap<>();
    recorded.put("dispositionId", d.id().toString());
    recorded.put("disposition", disposition);
    recorded.put("status", after.status().name());
    audit.append(entry(after, actor, "CASE_DISPOSITION_RECORDED", CaseService.state(c), recorded));
    events.dispositionRecorded(after, d);
    log.atInfo()
        .addKeyValue("tenantId", tenant)
        .addKeyValue("caseId", caseId)
        .addKeyValue("disposition", disposition)
        .addKeyValue("status", after.status())
        .log("case.disposition.recorded");
    return new DispositionResult(d, after);
  }

  @Transactional
  public CaseRecord requestReevaluation(
      AegisPrincipal p,
      @Nullable UUID acting,
      @Nullable String idempotencyKey,
      UUID caseId,
      String reason) {
    UUID tenant = enter(p, acting, "workCases");
    UUID actor = userId(p);
    CaseRecord c = load(tenant, caseId);
    String key = "reeval:" + (idempotencyKey != null ? idempotencyKey : actor + ":" + c.version());
    caseService.transition(
        tenant,
        caseId,
        CaseStatus.ENRICHING,
        key,
        actorOf(p, actor),
        OffsetDateTime.now(clock).plus(CaseService.ENRICHMENT_TIMEOUT));
    audit.append(
        entry(
            load(tenant, caseId),
            actorOf(p, actor),
            "CASE_REEVALUATION_REQUESTED",
            null,
            Map.of("reason", reason)));
    return policy.evaluate(tenant, caseId, actorOf(p, actor));
  }

  @Transactional
  public AttachResult attachEvidence(
      AegisPrincipal p, UUID tenantId, UUID caseId, List<CaseWork.EvidenceItem> items) {
    if (!(p instanceof AegisPrincipal.Service)) {
      throw new DomainException.Forbidden("FORBIDDEN", "attachEvidence is called by sagas only");
    }
    scope.apply(tenantId);
    CaseRecord c = load(tenantId, caseId);
    Actor actor = Actor.of(p);
    UUID target = caseId;
    UUID newCase = null;
    if (c.status() == CaseStatus.RESOLVED) {
      CaseService.Opened opened =
          caseService.open(
              new CaseService.NewCase(
                  tenantId,
                  "CORRELATED",
                  c.severity(),
                  c.triggerEventId(),
                  c.triggerFileId(),
                  c.primaryEntityIds(),
                  "correlated:"
                      + caseId
                      + ":"
                      + items.getFirst().evidenceType()
                      + ":"
                      + items.getFirst().evidenceRef(),
                  caseId,
                  null),
              actor);
      target = opened.caseRow().id();
      newCase = target;
    }
    int attached = 0;
    for (CaseWork.EvidenceItem i : items) {
      if (cases.insertEvidence(
          tenantId,
          target,
          i.evidenceType(),
          i.evidenceRef(),
          i.finalSeverity(),
          json.writeValueAsString(i.summary() == null ? Map.of() : i.summary()),
          actor.id())) {
        attached++;
        events.evidenceAttached(load(tenantId, target), i.evidenceType(), i.evidenceRef());
      }
    }
    boolean reevaluated = false;
    CaseRecord now = load(tenantId, target);
    if (attached > 0
        && (now.status() == CaseStatus.ESCALATED || now.status() == CaseStatus.CLEARED)) {
      caseService.transition(
          tenantId,
          target,
          CaseStatus.ENRICHING,
          "evidence:v" + now.version(),
          actor,
          OffsetDateTime.now(clock).plus(CaseService.ENRICHMENT_TIMEOUT));
      policy.evaluate(tenantId, target, actor);
      reevaluated = true;
    } else if (attached > 0 && now.status() == CaseStatus.ENRICHING && newCase != null) {
      policy.evaluate(tenantId, target, actor);
      reevaluated = true;
    }
    return new AttachResult(target, attached, items.size() - attached, reevaluated, newCase);
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private UUID enter(AegisPrincipal p, @Nullable UUID acting, String action) {
    UUID tenant = RiskEvaluationService.tenantFor(p, acting, action);
    scope.apply(tenant);
    return tenant;
  }

  private CaseRecord load(UUID tenant, UUID caseId) {
    return cases
        .findById(tenant, caseId)
        .orElseThrow(() -> new DomainException.NotFound("CASE_NOT_FOUND", "case not found"));
  }

  private @Nullable UUID pendingReviewer(UUID tenant, UUID caseId) {
    return cases.pendingReviewer(tenant, caseId);
  }

  private static UUID userId(AegisPrincipal p) {
    if (p instanceof AegisPrincipal.User u) {
      return UUID.fromString(u.userId());
    }
    throw new DomainException.Forbidden("FORBIDDEN", "case work is done by people");
  }

  private static Actor actorOf(AegisPrincipal p, UUID userId) {
    boolean pa = p instanceof AegisPrincipal.User u && u.roles().contains("PLATFORM_ADMIN");
    return new Actor("USER", userId.toString(), pa ? "PLATFORM_ADMIN" : null);
  }

  private AuditService.Entry entry(
      CaseRecord c,
      Actor actor,
      String action,
      @Nullable Map<String, @Nullable Object> before,
      @Nullable Map<String, ?> after) {
    Map<String, @Nullable Object> a = after == null ? null : new LinkedHashMap<>(after);
    return new AuditService.Entry(
        c.tenantId(),
        Instant.now(clock),
        actor,
        action,
        "CASE",
        c.id().toString(),
        c.triggerEventId(),
        c.triggerFileId(),
        null,
        c.policyVersion(),
        before,
        a,
        null);
  }

  private static DomainException.Validation invalid(String field, String issue) {
    return new DomainException.Validation(
        "VALIDATION_ERROR",
        "request failed validation",
        List.of(new DomainException.ErrorDetail(field, issue)));
  }

  private static String encode(String s) {
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(s.getBytes(StandardCharsets.UTF_8));
  }

  private static String decode(String s) {
    try {
      return new String(Base64.getUrlDecoder().decode(s), StandardCharsets.UTF_8);
    } catch (IllegalArgumentException e) {
      throw invalid("cursor", "invalid cursor");
    }
  }

  private static String sha256(String s) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }
}
