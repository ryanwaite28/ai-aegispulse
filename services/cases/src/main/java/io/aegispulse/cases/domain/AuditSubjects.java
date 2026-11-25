package io.aegispulse.cases.domain;

import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import org.jspecify.annotations.Nullable;

/**
 * FR-AUD-02: how an audit-worthy event from another service becomes an audit entry: the action
 * (event type in upper snake case), the subject (type + id field per event family) and the actor
 * (payload actorId when present, otherwise the producing service). Pure.
 */
public final class AuditSubjects {
  /**
   * Event type (or family prefix ending in '.') → subject type and the payload field holding its
   * id.
   */
  private static final Map<String, String[]> SUBJECTS =
      Map.ofEntries(
          Map.entry("registry.user.", new String[] {"USER", "userId"}),
          Map.entry("registry.auth.", new String[] {"USER", "userId"}),
          Map.entry("registry.tenant.", new String[] {"TENANT", "tenantId"}),
          Map.entry(
              "registry.service_account.", new String[] {"SERVICE_ACCOUNT", "serviceAccountId"}),
          Map.entry("registry.watchlist.", new String[] {"WATCHLIST", "watchlistId"}),
          Map.entry("registry.entity.", new String[] {"ENTITY", "entityId"}),
          Map.entry("classification.overridden", new String[] {"EVENT", "eventId"}),
          Map.entry("ops.audit.file_deleted", new String[] {"FILE", "fileId"}),
          Map.entry("ops.audit.quarantine_download", new String[] {"FILE", "fileId"}),
          Map.entry("ops.audit.dead_letter_resolved", new String[] {"DEAD_LETTER", "deadLetterId"}),
          Map.entry("ops.audit.source_trust_changed", new String[] {"WEBHOOK_SOURCE", "sourceId"}),
          Map.entry("ops.replay.", new String[] {"REPLAY_JOB", "jobId"}));

  private AuditSubjects() {}

  public record Mapped(
      String action, String subjectType, String subjectId, String actorType, String actorId) {}

  /** Empty when the event is not audit-worthy (the queue's bindings should not deliver those). */
  public static Optional<Mapped> map(
      String eventType, Map<String, @Nullable Object> payload, String producer) {
    String[] subject = null;
    for (Map.Entry<String, String[]> e : SUBJECTS.entrySet()) {
      String key = e.getKey();
      if (key.endsWith(".") ? eventType.startsWith(key) : eventType.equals(key)) {
        subject = e.getValue();
        break;
      }
    }
    if (subject == null) {
      return Optional.empty();
    }
    Object id = payload.get(subject[1]);
    Object actor = payload.get("actorId");
    String service =
        producer.contains("@") ? producer.substring(0, producer.indexOf('@')) : producer;
    return Optional.of(
        new Mapped(
            eventType.replace('.', '_').toUpperCase(Locale.ROOT),
            subject[0],
            id == null ? "unknown" : id.toString(),
            actor == null ? "SERVICE" : "USER",
            actor == null ? service : actor.toString()));
  }
}
