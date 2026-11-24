package io.aegispulse.registry.service;

import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.registry.db.EntityRepository;
import io.aegispulse.registry.db.TenantRepository;
import io.aegispulse.registry.db.WatchlistRepository;
import io.aegispulse.registry.domain.Entity;
import io.aegispulse.registry.domain.EntityNames;
import io.aegispulse.registry.domain.Tenant;
import io.aegispulse.registry.domain.WatchlistMembership;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Tracked entities and resolution (FR-ENT-01/02/03). */
@Service
public class EntityService {
  private static final Logger log = LoggerFactory.getLogger(EntityService.class);
  static final double TRIGRAM_THRESHOLD = 0.85;
  static final int DEFAULT_LIMIT = 25;

  private final EntityRepository entities;
  private final WatchlistRepository watchlists;
  private final TenantRepository tenants;
  private final TenantScope scope;
  private final Idempotency idempotency;
  private final RegistryEvents events;

  public EntityService(
      EntityRepository entities,
      WatchlistRepository watchlists,
      TenantRepository tenants,
      TenantScope scope,
      Idempotency idempotency,
      RegistryEvents events) {
    this.entities = entities;
    this.watchlists = watchlists;
    this.tenants = tenants;
    this.scope = scope;
    this.idempotency = idempotency;
    this.events = events;
  }

  /** Entity + the watchlists that contain it (contract EntityDetail). */
  public record Detail(Entity entity, List<WatchlistMembership> watchlists) {}

  /** One FR-ENT-03 resolution. */
  public record Resolution(
      String mention,
      @Nullable UUID entityId,
      Entity.@Nullable MatchType matchType,
      @Nullable Double similarity) {}

  @Transactional
  public Entity create(
      AegisPrincipal principal,
      @Nullable UUID actingTenant,
      @Nullable String idempotencyKey,
      Commands.CreateEntity cmd) {
    TenantAccess access = TenantAccess.forTenantAction("createEntity", principal, actingTenant);
    Tenant tenant = enter(access);
    return idempotency.run(
        access.tenantId(),
        "createEntity",
        idempotencyKey,
        cmd,
        201,
        Entity.class,
        () -> {
          String name = cmd.name().strip();
          String normalized = requireNormalized(name, "name");
          UUID id =
              entities.insert(
                  access.tenantId(),
                  name,
                  normalized,
                  cmd.entityType(),
                  cmd.ticker(),
                  cmd.lei(),
                  cmd.country());
          for (String alias : distinct(cmd.aliases())) {
            entities.addAlias(access.tenantId(), id, alias, requireNormalized(alias, "aliases"));
          }
          events.entityChanged(
              tenant.id(),
              tenant.slug(),
              id,
              List.of("created"),
              access.actorId(),
              access.actingAsPlatformAdmin());
          log.info("entity.created tenantId={} entityId={}", tenant.id(), id);
          return entities.findById(id).orElseThrow();
        });
  }

  @Transactional(readOnly = true)
  public Detail get(AegisPrincipal principal, @Nullable UUID actingTenant, UUID entityId) {
    TenantAccess access = TenantAccess.forTenantAction("getEntity", principal, actingTenant);
    enter(access);
    Entity entity = entities.findById(entityId).orElseThrow(EntityService::notFound);
    return new Detail(entity, watchlists.memberships(entity.id()));
  }

  @Transactional(readOnly = true)
  public Page<Entity> list(
      AegisPrincipal principal, @Nullable UUID actingTenant, Commands.ListEntities query) {
    TenantAccess access = TenantAccess.forTenantAction("listEntities", principal, actingTenant);
    enter(access);
    int limit = query.limit() == null ? DEFAULT_LIMIT : query.limit();
    if (query.q() != null) {
      String normalized = EntityNames.normalize(query.q());
      return new Page<>(
          normalized.isEmpty()
              ? List.of()
              : entities.search(normalized, query.entityType(), query.watchlistId(), limit),
          null);
    }
    EntityRepository.Position after =
        query.cursor() == null
            ? null
            : Cursors.decode(query.cursor(), (at, id) -> new EntityRepository.Position(at, id));
    List<Entity> rows = entities.list(query.entityType(), query.watchlistId(), after, limit + 1);
    if (rows.size() <= limit) {
      return new Page<>(rows, null);
    }
    Entity last = rows.get(limit - 1);
    return new Page<>(
        List.copyOf(rows.subList(0, limit)), Cursors.encode(last.createdAt(), last.id()));
  }

  @Transactional
  public Entity update(
      AegisPrincipal principal,
      @Nullable UUID actingTenant,
      @Nullable String idempotencyKey,
      Commands.UpdateEntity cmd) {
    TenantAccess access = TenantAccess.forTenantAction("updateEntity", principal, actingTenant);
    Tenant tenant = enter(access);
    return idempotency.run(
        access.tenantId(),
        "updateEntity",
        idempotencyKey,
        cmd,
        200,
        Entity.class,
        () -> {
          Entity current = entities.lockById(cmd.entityId()).orElseThrow(EntityService::notFound);
          if (current.archivedAt() != null) {
            throw new DomainException.Conflict("CONFLICT", "archived entities cannot be changed");
          }
          String name = cmd.name() == null ? current.name() : cmd.name().strip();
          String normalized =
              cmd.name() == null ? current.normalizedName() : requireNormalized(name, "name");
          Entity.Type type = cmd.entityType() == null ? current.entityType() : cmd.entityType();
          String ticker = merge(cmd.ticker(), current.ticker());
          String lei = merge(cmd.lei(), current.lei());
          String country = merge(cmd.country(), current.country());
          List<String> changed = new ArrayList<>();
          if (!name.equals(current.name())) {
            changed.add("name");
          }
          if (type != current.entityType()) {
            changed.add("entityType");
          }
          if (!Objects.equals(ticker, current.ticker())) {
            changed.add("ticker");
          }
          if (!Objects.equals(lei, current.lei())) {
            changed.add("lei");
          }
          if (!Objects.equals(country, current.country())) {
            changed.add("country");
          }
          if (!changed.isEmpty()) {
            entities.update(current.id(), name, normalized, type, ticker, lei, country);
          }
          boolean aliases = false;
          Set<String> existing = new LinkedHashSet<>();
          current.aliases().forEach(a -> existing.add(EntityNames.normalize(a)));
          for (String alias : distinct(cmd.removeAliases())) {
            aliases |= entities.removeAlias(current.id(), EntityNames.normalize(alias)) > 0;
          }
          for (String alias : distinct(cmd.addAliases())) {
            String n = requireNormalized(alias, "addAliases");
            if (!existing.contains(n)) {
              entities.addAlias(access.tenantId(), current.id(), alias, n);
              aliases = true;
            }
          }
          if (aliases) {
            changed.add("aliases");
          }
          if (!changed.isEmpty()) {
            events.entityChanged(
                tenant.id(),
                tenant.slug(),
                current.id(),
                List.copyOf(changed),
                access.actorId(),
                access.actingAsPlatformAdmin());
            log.info(
                "entity.updated tenantId={} entityId={} changed={}",
                tenant.id(),
                current.id(),
                changed);
          }
          return entities.findById(current.id()).orElseThrow();
        });
  }

  /** FR-ENT-02 soft delete (TENANT_ADMIN); archived entities stop matching. Idempotent. */
  @Transactional
  public Entity archive(AegisPrincipal principal, @Nullable UUID actingTenant, UUID entityId) {
    TenantAccess access = TenantAccess.forTenantAction("archiveEntity", principal, actingTenant);
    Tenant tenant = enter(access);
    Entity current = entities.lockById(entityId).orElseThrow(EntityService::notFound);
    if (current.archivedAt() == null) {
      entities.archive(current.id());
      events.entityChanged(
          tenant.id(),
          tenant.slug(),
          current.id(),
          List.of("archivedAt"),
          access.actorId(),
          access.actingAsPlatformAdmin());
      log.info("entity.archived tenantId={} entityId={}", tenant.id(), current.id());
    }
    return entities.findById(current.id()).orElseThrow();
  }

  /**
   * FR-ENT-03 (SERVICE callers with registry.resolveEntities): one result per mention, then per
   * ticker; stages ticker → alias → normalized name → trigram ≥ 0.85; deterministic.
   */
  @Transactional(readOnly = true)
  public List<Resolution> resolve(AegisPrincipal principal, Commands.ResolveEntities cmd) {
    requireService(principal);
    scope.apply(cmd.tenantId());
    return resolveInScope(cmd.mentions(), cmd.tickers() == null ? List.of() : cmd.tickers());
  }

  /** Resolution for callers already inside the tenant scope (checkWatchlists counterparty refs). */
  List<Resolution> resolveInScope(List<String> mentions, List<String> tickers) {
    List<String> inputs = new ArrayList<>(mentions);
    inputs.addAll(tickers);
    Map<String, Resolution> resolved = new LinkedHashMap<>();
    // 1. ticker exact (raw mention or ticker)
    Map<String, EntityRepository.Match> byTicker =
        entities.byTicker(inputs.stream().map(String::strip).distinct().toList());
    // normalized forms for the remaining stages
    Map<String, String> normalizedOf = new LinkedHashMap<>();
    for (String in : inputs) {
      normalizedOf.put(in, EntityNames.normalize(in));
    }
    List<String> norms =
        normalizedOf.values().stream().filter(n -> !n.isEmpty()).distinct().sorted().toList();
    Map<String, EntityRepository.Match> byAlias = entities.byAlias(norms);
    Map<String, EntityRepository.Match> byName = entities.byNormalizedName(norms);
    List<String> trigramCandidates =
        norms.stream().filter(n -> !byAlias.containsKey(n) && !byName.containsKey(n)).toList();
    Map<String, EntityRepository.Match> byTrigram =
        entities.byTrigram(trigramCandidates, TRIGRAM_THRESHOLD);
    List<Resolution> out = new ArrayList<>();
    for (String in : inputs) {
      Resolution r = resolved.get(in);
      if (r == null) {
        String n = normalizedOf.get(in);
        EntityRepository.Match m;
        Entity.MatchType type;
        if ((m = byTicker.get(in.strip())) != null) {
          type = Entity.MatchType.TICKER_EXACT;
        } else if ((m = byAlias.get(n)) != null) {
          type = Entity.MatchType.ALIAS_EXACT;
        } else if ((m = byName.get(n)) != null) {
          type = Entity.MatchType.NAME_NORMALIZED;
        } else if ((m = byTrigram.get(n)) != null) {
          type = Entity.MatchType.TRIGRAM;
        } else {
          type = null;
        }
        r =
            m == null
                ? new Resolution(in, null, null, null)
                : new Resolution(
                    in, m.entityId(), type, Math.round(m.similarity() * 10_000) / 10_000.0);
        resolved.put(in, r);
      }
      out.add(r);
    }
    return out;
  }

  static void requireService(AegisPrincipal principal) {
    if (!(principal instanceof AegisPrincipal.Service)) {
      throw new DomainException.Forbidden("FORBIDDEN", "internal action for SERVICE callers only");
    }
  }

  private Tenant enter(TenantAccess access) {
    Tenant tenant =
        tenants
            .findById(access.tenantId())
            .orElseThrow(() -> new DomainException.NotFound("NOT_FOUND", "tenant not found"));
    scope.apply(access.tenantId());
    return tenant;
  }

  private static @Nullable String merge(
      java.util.@Nullable Optional<String> update, @Nullable String current) {
    if (update == null) {
      return current; // absent: unchanged
    }
    return update.orElse(null); // explicit null clears
  }

  private static List<String> distinct(@Nullable List<String> values) {
    return values == null ? List.of() : values.stream().map(String::strip).distinct().toList();
  }

  private static String requireNormalized(String value, String field) {
    String n = EntityNames.normalize(value);
    if (n.isEmpty()) {
      throw new DomainException.Validation(
          "VALIDATION_ERROR",
          "request failed validation",
          List.of(new DomainException.ErrorDetail(field, "must contain a letter or digit")));
    }
    return n;
  }

  static DomainException notFound() {
    return new DomainException.NotFound("NOT_FOUND", "entity not found");
  }

  /** Base64url keyset cursors shared by the Phase 3 lists. */
  static final class Cursors {
    private Cursors() {}

    static String encode(OffsetDateTime at, UUID id) {
      return Base64.getUrlEncoder()
          .withoutPadding()
          .encodeToString((at + "|" + id).getBytes(StandardCharsets.UTF_8));
    }

    static <P> P decode(
        String cursor, java.util.function.BiFunction<OffsetDateTime, UUID, P> make) {
      try {
        String raw = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
        int bar = raw.indexOf('|');
        return make.apply(
            OffsetDateTime.parse(raw.substring(0, bar)), UUID.fromString(raw.substring(bar + 1)));
      } catch (IllegalArgumentException
          | DateTimeParseException
          | StringIndexOutOfBoundsException e) {
        throw new DomainException.Validation(
            "VALIDATION_ERROR",
            "request failed validation",
            List.of(new DomainException.ErrorDetail("cursor", "invalid cursor")));
      }
    }
  }
}
