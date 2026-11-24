package io.aegispulse.registry.adapters.http;

import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.platform.security.ServiceActionAuthorizer;
import io.aegispulse.registry.domain.Watchlist;
import io.aegispulse.registry.domain.WatchlistEntry;
import io.aegispulse.registry.service.Commands;
import io.aegispulse.registry.service.Page;
import io.aegispulse.registry.service.WatchlistService;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Internal watchlist actions (FR-ENT-04/05). */
@RestController
@RequestMapping("/internal/v1")
class WatchlistController {
  private final ServiceActionAuthorizer authorizer;
  private final WatchlistService watchlists;

  WatchlistController(ServiceActionAuthorizer authorizer, WatchlistService watchlists) {
    this.authorizer = authorizer;
    this.watchlists = watchlists;
  }

  @PostMapping("/createWatchlist")
  ResponseEntity<Success<Watchlist>> create(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @RequestHeader(value = Headers.IDEMPOTENCY_KEY, required = false) @Nullable String key,
      @Valid @RequestBody Commands.CreateWatchlist body) {
    AegisPrincipal p = authorizer.requireAction(auth, "registry.createWatchlist");
    return ResponseEntity.status(201)
        .body(Success.of(watchlists.create(p, Headers.actingTenant(acting), key, body)));
  }

  @PostMapping("/listWatchlists")
  Success<List<Watchlist>> list(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @Valid @RequestBody Commands.ListWatchlists body) {
    AegisPrincipal p = authorizer.requireAction(auth, "registry.listWatchlists");
    Page<Watchlist> page = watchlists.list(p, Headers.actingTenant(acting), body);
    return Success.of(page.items(), page.nextCursor());
  }

  @PostMapping("/updateWatchlist")
  Success<Watchlist> update(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @RequestHeader(value = Headers.IDEMPOTENCY_KEY, required = false) @Nullable String key,
      @Valid @RequestBody Commands.UpdateWatchlist body) {
    AegisPrincipal p = authorizer.requireAction(auth, "registry.updateWatchlist");
    return Success.of(watchlists.update(p, Headers.actingTenant(acting), key, body));
  }

  @PostMapping("/deleteWatchlist")
  Success<Map<String, Object>> delete(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @Valid @RequestBody Commands.WatchlistRef body) {
    AegisPrincipal p = authorizer.requireAction(auth, "registry.deleteWatchlist");
    watchlists.delete(p, Headers.actingTenant(acting), body.watchlistId());
    return Success.of(Map.of());
  }

  @PostMapping("/addWatchlistEntry")
  ResponseEntity<Success<WatchlistEntry>> addEntry(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @RequestHeader(value = Headers.IDEMPOTENCY_KEY, required = false) @Nullable String key,
      @Valid @RequestBody Commands.AddWatchlistEntry body) {
    AegisPrincipal p = authorizer.requireAction(auth, "registry.addWatchlistEntry");
    return ResponseEntity.status(201)
        .body(Success.of(watchlists.addEntry(p, Headers.actingTenant(acting), key, body)));
  }

  @PostMapping("/removeWatchlistEntry")
  Success<Map<String, Object>> removeEntry(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @Valid @RequestBody Commands.RemoveWatchlistEntry body) {
    AegisPrincipal p = authorizer.requireAction(auth, "registry.removeWatchlistEntry");
    watchlists.removeEntry(p, Headers.actingTenant(acting), body);
    return Success.of(Map.of());
  }

  @PostMapping("/checkWatchlists")
  Success<Map<String, List<WatchlistService.Hit>>> check(
      @Nullable Authentication auth, @Valid @RequestBody Commands.CheckWatchlists body) {
    AegisPrincipal p = authorizer.requireAction(auth, "registry.checkWatchlists");
    return Success.of(Map.of("hits", watchlists.check(p, body)));
  }
}
