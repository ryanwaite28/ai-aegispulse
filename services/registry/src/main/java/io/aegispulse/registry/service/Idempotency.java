package io.aegispulse.registry.service;

import io.aegispulse.platform.idempotency.IdempotencyRepository;
import java.util.function.Supplier;
import org.jspecify.annotations.Nullable;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/**
 * Idempotency-Key handling for registry mutations (NFR-02, §2.0): call inside the transaction,
 * after TenantScope.apply (the store is under RLS). A replay returns the stored response.
 */
@Component
class Idempotency {
  private final IdempotencyRepository store;
  private final JsonMapper json;

  Idempotency(IdempotencyRepository store, JsonMapper json) {
    this.store = store;
    this.json = json;
  }

  <T> T run(
      java.util.UUID tenantId,
      String scope,
      @Nullable String key,
      Object fingerprint,
      int status,
      Class<T> type,
      Supplier<T> work) {
    if (key == null) {
      return work.get();
    }
    String sha = IdempotencyRepository.sha256Hex(json.writeValueAsString(fingerprint));
    IdempotencyRepository.Decision decision = store.begin(tenantId, scope, key, sha);
    if (decision instanceof IdempotencyRepository.Decision.Replay replay
        && replay.bodyJson() != null) {
      return json.readValue(replay.bodyJson(), type);
    }
    T result = work.get();
    store.complete(tenantId, scope, key, status, json.writeValueAsString(result));
    return result;
  }

  /**
   * For responses carrying one-time secrets (FR-TEN-06): the key de-duplicates but is never
   * replayed, and only {@code storedId} is persisted, never the response.
   */
  <T> T runOnce(
      java.util.UUID tenantId,
      String scope,
      @Nullable String key,
      Object fingerprint,
      int status,
      java.util.function.Function<T, String> storedId,
      Supplier<T> work) {
    if (key == null) {
      return work.get();
    }
    String sha = IdempotencyRepository.sha256Hex(json.writeValueAsString(fingerprint));
    if (store.begin(tenantId, scope, key, sha) instanceof IdempotencyRepository.Decision.Replay) {
      throw new io.aegispulse.platform.errors.DomainException.Conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "the secret was already issued for this key; rotate to get a new one");
    }
    T result = work.get();
    store.complete(
        tenantId,
        scope,
        key,
        status,
        json.writeValueAsString(java.util.Map.of("id", storedId.apply(result))));
    return result;
  }
}
