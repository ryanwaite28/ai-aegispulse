package io.aegispulse.registry.adapters.http;

import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.platform.security.ServiceActionAuthorizer;
import io.aegispulse.registry.domain.Entity;
import io.aegispulse.registry.domain.WatchlistMembership;
import io.aegispulse.registry.service.Commands;
import io.aegispulse.registry.service.EntityService;
import io.aegispulse.registry.service.Page;
import jakarta.validation.Valid;
import java.time.OffsetDateTime;
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

/** Internal entity actions (FR-ENT-01/02/03): parse → one service call → map. */
@RestController
@RequestMapping("/internal/v1")
class EntityController {
  private final ServiceActionAuthorizer authorizer;
  private final EntityService entities;

  EntityController(ServiceActionAuthorizer authorizer, EntityService entities) {
    this.authorizer = authorizer;
    this.entities = entities;
  }

  /** Contract EntityDetail: entity fields + watchlists. */
  record EntityDetailView(
      UUID id,
      UUID tenantId,
      String name,
      String normalizedName,
      Entity.Type entityType,
      @Nullable String ticker,
      @Nullable String lei,
      @Nullable String country,
      List<String> aliases,
      @Nullable OffsetDateTime archivedAt,
      OffsetDateTime createdAt,
      OffsetDateTime updatedAt,
      List<WatchlistMembership> watchlists) {
    static EntityDetailView of(EntityService.Detail d) {
      Entity e = d.entity();
      return new EntityDetailView(
          e.id(),
          e.tenantId(),
          e.name(),
          e.normalizedName(),
          e.entityType(),
          e.ticker(),
          e.lei(),
          e.country(),
          e.aliases(),
          e.archivedAt(),
          e.createdAt(),
          e.updatedAt(),
          d.watchlists());
    }
  }

  @PostMapping("/createEntity")
  ResponseEntity<Success<Entity>> create(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @RequestHeader(value = Headers.IDEMPOTENCY_KEY, required = false) @Nullable String key,
      @Valid @RequestBody Commands.CreateEntity body) {
    AegisPrincipal p = authorizer.requireAction(auth, "registry.createEntity");
    return ResponseEntity.status(201)
        .body(Success.of(entities.create(p, Headers.actingTenant(acting), key, body)));
  }

  @PostMapping("/getEntity")
  Success<EntityDetailView> get(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @Valid @RequestBody Commands.EntityRef body) {
    AegisPrincipal p = authorizer.requireAction(auth, "registry.getEntity");
    return Success.of(
        EntityDetailView.of(entities.get(p, Headers.actingTenant(acting), body.entityId())));
  }

  @PostMapping("/listEntities")
  Success<List<Entity>> list(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @Valid @RequestBody Commands.ListEntities body) {
    AegisPrincipal p = authorizer.requireAction(auth, "registry.listEntities");
    Page<Entity> page = entities.list(p, Headers.actingTenant(acting), body);
    return Success.of(page.items(), page.nextCursor());
  }

  @PostMapping("/updateEntity")
  Success<Entity> update(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @RequestHeader(value = Headers.IDEMPOTENCY_KEY, required = false) @Nullable String key,
      @Valid @RequestBody Commands.UpdateEntity body) {
    AegisPrincipal p = authorizer.requireAction(auth, "registry.updateEntity");
    return Success.of(entities.update(p, Headers.actingTenant(acting), key, body));
  }

  @PostMapping("/archiveEntity")
  Success<Entity> archive(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @Valid @RequestBody Commands.EntityRef body) {
    AegisPrincipal p = authorizer.requireAction(auth, "registry.archiveEntity");
    return Success.of(entities.archive(p, Headers.actingTenant(acting), body.entityId()));
  }

  @PostMapping("/resolveEntities")
  Success<Map<String, List<EntityService.Resolution>>> resolve(
      @Nullable Authentication auth, @Valid @RequestBody Commands.ResolveEntities body) {
    AegisPrincipal p = authorizer.requireAction(auth, "registry.resolveEntities");
    return Success.of(Map.of("matches", entities.resolve(p, body)));
  }
}
