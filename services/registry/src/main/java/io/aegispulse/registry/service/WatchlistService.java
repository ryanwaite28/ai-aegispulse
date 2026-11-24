package io.aegispulse.registry.service;

import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.registry.db.EntityRepository;
import io.aegispulse.registry.db.TenantRepository;
import io.aegispulse.registry.db.WatchlistRepository;
import io.aegispulse.registry.domain.Entity;
import io.aegispulse.registry.domain.Tenant;
import io.aegispulse.registry.domain.Watchlist;
import io.aegispulse.registry.domain.WatchlistEntry;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Watchlists and watchlist checks (FR-ENT-04/05). */
@Service
public class WatchlistService {
  private static final Logger log = LoggerFactory.getLogger(WatchlistService.class);
  static final int DEFAULT_LIMIT = 25;

  private final WatchlistRepository watchlists;
  private final EntityRepository entities;
  private final EntityService entityService;
  private final TenantRepository tenants;
  private final TenantScope scope;
  private final Idempotency idempotency;
  private final RegistryEvents events;

  public WatchlistService(
      WatchlistRepository watchlists,
      EntityRepository entities,
      EntityService entityService,
      TenantRepository tenants,
      TenantScope scope,
      Idempotency idempotency,
      RegistryEvents events) {
    this.watchlists = watchlists;
    this.entities = entities;
    this.entityService = entityService;
    this.tenants = tenants;
    this.scope = scope;
    this.idempotency = idempotency;
    this.events = events;
  }

  /** A WatchlistHit (counterpartyId set when the hit came from a counterparty ref). */
  public record Hit(
      UUID watchlistId,
      String watchlistName,
      String severityFloor,
      UUID entityId,
      @Nullable String counterpartyId) {}

  @Transactional
  public Watchlist create(
      AegisPrincipal principal,
      @Nullable UUID actingTenant,
      @Nullable String idempotencyKey,
      Commands.CreateWatchlist cmd) {
    TenantAccess access = TenantAccess.forTenantAction("createWatchlist", principal, actingTenant);
    Tenant tenant = enter(access);
    return idempotency.run(
        access.tenantId(),
        "createWatchlist",
        idempotencyKey,
        cmd,
        201,
        Watchlist.class,
        () -> {
          UUID id =
              watchlists.insert(
                  access.tenantId(),
                  cmd.name().strip(),
                  cmd.reason(),
                  cmd.severityFloor() == null ? "HIGH" : cmd.severityFloor(),
                  cmd.status() == null ? Watchlist.Status.ACTIVE : cmd.status(),
                  access.actingAsPlatformAdmin() ? null : access.actorId());
          audit(tenant, id, List.of("created"), access);
          return watchlists.findActive(id).orElseThrow();
        });
  }

  @Transactional(readOnly = true)
  public Page<Watchlist> list(
      AegisPrincipal principal, @Nullable UUID actingTenant, Commands.ListWatchlists query) {
    TenantAccess access = TenantAccess.forTenantAction("listWatchlists", principal, actingTenant);
    enter(access);
    int limit = query.limit() == null ? DEFAULT_LIMIT : query.limit();
    WatchlistRepository.Position after =
        query.cursor() == null
            ? null
            : EntityService.Cursors.decode(
                query.cursor(), (at, id) -> new WatchlistRepository.Position(at, id));
    List<Watchlist> rows = watchlists.list(after, limit + 1);
    if (rows.size() <= limit) {
      return new Page<>(rows, null);
    }
    Watchlist last = rows.get(limit - 1);
    return new Page<>(
        List.copyOf(rows.subList(0, limit)),
        EntityService.Cursors.encode(last.createdAt(), last.id()));
  }

  @Transactional
  public Watchlist update(
      AegisPrincipal principal,
      @Nullable UUID actingTenant,
      @Nullable String idempotencyKey,
      Commands.UpdateWatchlist cmd) {
    TenantAccess access = TenantAccess.forTenantAction("updateWatchlist", principal, actingTenant);
    Tenant tenant = enter(access);
    return idempotency.run(
        access.tenantId(),
        "updateWatchlist",
        idempotencyKey,
        cmd,
        200,
        Watchlist.class,
        () -> {
          if (!watchlists.lockActive(cmd.watchlistId())) {
            throw notFound();
          }
          Watchlist current =
              watchlists.findActive(cmd.watchlistId()).orElseThrow(WatchlistService::notFound);
          String name = cmd.name() == null ? current.name() : cmd.name().strip();
          String reason = cmd.reason() == null ? current.reason() : cmd.reason();
          String floor =
              cmd.severityFloor() == null ? current.severityFloor() : cmd.severityFloor();
          Watchlist.Status status = cmd.status() == null ? current.status() : cmd.status();
          List<String> changed = new ArrayList<>();
          if (!name.equals(current.name())) {
            changed.add("name");
          }
          if (!reason.equals(current.reason())) {
            changed.add("reason");
          }
          if (!floor.equals(current.severityFloor())) {
            changed.add("severityFloor");
          }
          if (status != current.status()) {
            changed.add("status");
          }
          if (changed.isEmpty()) {
            return current;
          }
          watchlists.update(current.id(), name, reason, floor, status);
          audit(tenant, current.id(), List.copyOf(changed), access);
          return watchlists.findActive(current.id()).orElseThrow();
        });
  }

  /** FR-ENT-04 soft delete (TENANT_ADMIN). */
  @Transactional
  public void delete(AegisPrincipal principal, @Nullable UUID actingTenant, UUID watchlistId) {
    TenantAccess access = TenantAccess.forTenantAction("deleteWatchlist", principal, actingTenant);
    Tenant tenant = enter(access);
    if (!watchlists.lockActive(watchlistId)) {
      throw notFound();
    }
    watchlists.softDelete(watchlistId);
    audit(tenant, watchlistId, List.of("deleted"), access);
  }

  @Transactional
  public WatchlistEntry addEntry(
      AegisPrincipal principal,
      @Nullable UUID actingTenant,
      @Nullable String idempotencyKey,
      Commands.AddWatchlistEntry cmd) {
    TenantAccess access =
        TenantAccess.forTenantAction("addWatchlistEntry", principal, actingTenant);
    Tenant tenant = enter(access);
    return idempotency.run(
        access.tenantId(),
        "addWatchlistEntry",
        idempotencyKey,
        cmd,
        201,
        WatchlistEntry.class,
        () -> {
          if (!watchlists.lockActive(cmd.watchlistId())) {
            throw notFound();
          }
          Entity entity = entities.findById(cmd.entityId()).orElseThrow(EntityService::notFound);
          if (entity.archivedAt() != null) {
            throw EntityService.notFound();
          }
          WatchlistEntry entry =
              watchlists.upsertEntry(
                  access.tenantId(),
                  cmd.watchlistId(),
                  entity.id(),
                  cmd.note(),
                  access.actingAsPlatformAdmin() ? null : access.actorId());
          audit(tenant, cmd.watchlistId(), List.of("entries"), access);
          return entry;
        });
  }

  @Transactional
  public void removeEntry(
      AegisPrincipal principal, @Nullable UUID actingTenant, Commands.RemoveWatchlistEntry cmd) {
    TenantAccess access =
        TenantAccess.forTenantAction("removeWatchlistEntry", principal, actingTenant);
    Tenant tenant = enter(access);
    if (!watchlists.lockActive(cmd.watchlistId())
        || watchlists.removeEntry(cmd.watchlistId(), cmd.entityId()) == 0) {
      throw new DomainException.NotFound("NOT_FOUND", "watchlist entry not found");
    }
    audit(tenant, cmd.watchlistId(), List.of("entries"), access);
  }

  /**
   * FR-ENT-05 (SERVICE callers with registry.checkWatchlists): hits on ACTIVE watchlists for the
   * given entities and for counterparty refs resolved through FR-ENT-03.
   */
  @Transactional(readOnly = true)
  public List<Hit> check(AegisPrincipal principal, Commands.CheckWatchlists cmd) {
    EntityService.requireService(principal);
    if ((cmd.entityIds() == null || cmd.entityIds().isEmpty())
        && (cmd.counterpartyRefs() == null || cmd.counterpartyRefs().isEmpty())) {
      throw new DomainException.Validation(
          "VALIDATION_ERROR",
          "request failed validation",
          List.of(
              new DomainException.ErrorDetail(
                  "body", "entityIds or counterpartyRefs is required")));
    }
    scope.apply(cmd.tenantId());
    List<Hit> out = new ArrayList<>();
    if (cmd.entityIds() != null && !cmd.entityIds().isEmpty()) {
      for (WatchlistRepository.Hit h :
          watchlists.hits(List.copyOf(new LinkedHashSet<>(cmd.entityIds())))) {
        out.add(new Hit(h.watchlistId(), h.watchlistName(), h.severityFloor(), h.entityId(), null));
      }
    }
    if (cmd.counterpartyRefs() != null && !cmd.counterpartyRefs().isEmpty()) {
      List<String> mentions = new ArrayList<>();
      for (Commands.CounterpartyRef ref : cmd.counterpartyRefs()) {
        mentions.add(
            ref.counterpartyName() != null ? ref.counterpartyName() : ref.counterpartyId());
      }
      List<EntityService.Resolution> resolved = entityService.resolveInScope(mentions, List.of());
      Map<UUID, List<String>> refsByEntity = new LinkedHashMap<>();
      for (int i = 0; i < resolved.size(); i++) {
        UUID entityId = resolved.get(i).entityId();
        if (entityId != null) {
          refsByEntity
              .computeIfAbsent(entityId, k -> new ArrayList<>())
              .add(cmd.counterpartyRefs().get(i).counterpartyId());
        }
      }
      for (WatchlistRepository.Hit h : watchlists.hits(List.copyOf(refsByEntity.keySet()))) {
        for (String counterpartyId : refsByEntity.getOrDefault(h.entityId(), List.of())) {
          out.add(
              new Hit(
                  h.watchlistId(),
                  h.watchlistName(),
                  h.severityFloor(),
                  h.entityId(),
                  counterpartyId));
        }
      }
    }
    return out;
  }

  private void audit(Tenant tenant, UUID watchlistId, List<String> changed, TenantAccess access) {
    events.watchlistChanged(
        tenant.id(),
        tenant.slug(),
        watchlistId,
        changed,
        access.actorId(),
        access.actingAsPlatformAdmin());
    log.info(
        "watchlist.changed tenantId={} watchlistId={} changed={} actorId={}",
        tenant.id(),
        watchlistId,
        changed,
        access.actorId());
  }

  private Tenant enter(TenantAccess access) {
    Tenant tenant =
        tenants
            .findById(access.tenantId())
            .orElseThrow(() -> new DomainException.NotFound("NOT_FOUND", "tenant not found"));
    scope.apply(access.tenantId());
    return tenant;
  }

  static DomainException notFound() {
    return new DomainException.NotFound("NOT_FOUND", "watchlist not found");
  }
}
