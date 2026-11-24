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
}
