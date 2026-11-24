package io.aegispulse.registry.service;

import io.aegispulse.contracts.envelope.CanonicalEnvelope;
import io.aegispulse.contracts.envelope.Classification;
import io.aegispulse.contracts.envelope.ClassificationStatus;
import io.aegispulse.contracts.envelope.Sensitivity;
import io.aegispulse.contracts.events.RegistryTenantCreatedPayload;
import io.aegispulse.contracts.events.RegistryTenantDeactivatedPayload;
import io.aegispulse.contracts.events.RegistryTenantRestoredPayload;
import io.aegispulse.contracts.events.RegistryTenantSuspendedPayload;
import io.aegispulse.contracts.events.RegistryUserChangedPayload;
import io.aegispulse.contracts.topology.ExchangeName;
import io.aegispulse.platform.config.AegisPlatformProperties;
import io.aegispulse.platform.ids.UuidV7;
import io.aegispulse.platform.logging.LogContext;
import io.aegispulse.platform.outbox.OutboxMessage;
import io.aegispulse.platform.outbox.OutboxRepository;
import io.aegispulse.registry.domain.Tenant;
import io.aegispulse.registry.domain.TenantStateMachine.Transition;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * registry.* domain events written to the outbox in the caller's transaction (ADR-0004, §6.7).
 * Payloads carry ids and changed field names only, never secrets or password data. They are also
 * the audit records cases chains (FR-AUD-02).
 */
@Component
public class RegistryEvents {
  private static final TypeReference<Map<String, @Nullable Object>> MAP = new TypeReference<>() {};
  private static final Classification CLASSIFICATION =
      new Classification(
          null,
          null,
          null,
          Classification.ClassificationSource.PRODUCER,
          null,
          null,
          null,
          null,
          Sensitivity.INTERNAL,
          ClassificationStatus.INGESTED);

  private final OutboxRepository outbox;
  private final JsonMapper json;
  private final String producer;

  public RegistryEvents(OutboxRepository outbox, JsonMapper json, AegisPlatformProperties props) {
    this.outbox = outbox;
    this.json = json;
    this.producer = producer(props.service(), props.version());
  }

  /**
   * §6.4 producer {@code aegispulse-{runtime}@{git sha}}; runs outside an image build (version
   * "dev") use the all-zero sha so envelopes stay schema-valid.
   */
  static String producer(String service, String version) {
    String sha = version.matches("^[0-9a-f]{7,40}$") ? version : "0000000";
    return "aegispulse-" + service + "@" + sha;
  }

  public void tenantCreated(Tenant t, UUID actorId) {
    publish(
        "registry.tenant.created",
        t,
        new RegistryTenantCreatedPayload(
            null,
            actorId.toString(),
            List.of(
                "slug",
                "displayName",
                "highValueThresholdUsd",
                "highRiskCountries",
                "retentionDays",
                "demoMode",
                "status"),
            t.slug(),
            t.id().toString()));
  }

  /** SUSPENDED → .suspended, RESTORED → .restored, DEACTIVATED → .deactivated (FR-TEN-02/03). */
  public void tenantStatusChanged(Tenant t, Transition transition, String reason, UUID actorId) {
    switch (transition) {
      case SUSPENDED ->
          publish(
              "registry.tenant.suspended",
              t,
              new RegistryTenantSuspendedPayload(
                  null, actorId.toString(), List.of("status"), reason, t.id().toString()));
      case RESTORED ->
          publish(
              "registry.tenant.restored",
              t,
              new RegistryTenantRestoredPayload(
                  null, actorId.toString(), List.of("status"), reason, t.id().toString()));
      case DEACTIVATED ->
          publish(
              "registry.tenant.deactivated",
              t,
              new RegistryTenantDeactivatedPayload(
                  null, actorId.toString(), List.of("status"), reason, t.id().toString()));
    }
  }

  public void userChanged(
      UUID tenantId,
      @Nullable String tenantSlug,
      UUID userId,
      List<String> changedFields,
      @Nullable UUID actorId,
      boolean actingAsPlatformAdmin) {
    publish(
        "registry.user.changed",
        tenantId,
        tenantSlug,
        new RegistryUserChangedPayload(
            actingAsPlatformAdmin ? RegistryUserChangedPayload.ActingAs.PLATFORM_ADMIN : null,
            actorId == null ? null : actorId.toString(),
            changedFields,
            userId.toString()));
  }

  /**
   * Optional payload fields are omitted rather than sent as JSON null: the event schemas type them
   * (uuid, enum) without allowing null.
   */
  Map<String, @Nullable Object> payloadMap(Object payload) {
    Map<String, @Nullable Object> map =
        new java.util.LinkedHashMap<>(json.convertValue(payload, MAP));
    map.values().removeIf(java.util.Objects::isNull);
    return map;
  }

  private void publish(String eventType, Tenant t, Object payload) {
    publish(eventType, t.id(), t.slug(), payload);
  }

  private void publish(
      String eventType, UUID tenantId, @Nullable String tenantSlug, Object payload) {
    String eventId = UuidV7.next().toString();
    OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
    String correlationId = MDC.get(LogContext.CORRELATION_ID);
    CanonicalEnvelope envelope =
        new CanonicalEnvelope(
            null,
            CLASSIFICATION,
            correlationId != null && correlationId.startsWith("corr-")
                ? correlationId
                : "corr-" + eventId,
            eventId,
            eventType,
            eventType + ":" + eventId,
            now,
            now,
            payloadMap(payload),
            producer,
            "1.0.0",
            "service:registry",
            tenantId.toString(),
            tenantSlug);
    outbox.enqueue(
        new OutboxMessage(ExchangeName.AEGISPULSE_DOMAIN.wireName(), eventType, envelope));
  }
}
