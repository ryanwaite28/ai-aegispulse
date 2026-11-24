package io.aegispulse.registry.adapters.http;

import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.platform.security.ServiceActionAuthorizer;
import io.aegispulse.registry.service.Commands;
import io.aegispulse.registry.service.TenantService;
import jakarta.validation.Valid;
import org.jspecify.annotations.Nullable;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Internal tenant actions (§6.2): parse → one service call → map. */
@RestController
@RequestMapping("/internal/v1")
class TenantController {
  private final ServiceActionAuthorizer authorizer;
  private final TenantService tenants;

  TenantController(ServiceActionAuthorizer authorizer, TenantService tenants) {
    this.authorizer = authorizer;
    this.tenants = tenants;
  }

  @PostMapping("/createTenant")
  ResponseEntity<Success<TenantView>> createTenant(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.IDEMPOTENCY_KEY, required = false) @Nullable String key,
      @Valid @RequestBody Commands.CreateTenant body) {
    AegisPrincipal principal = authorizer.requireAction(auth, "registry.createTenant");
    return ResponseEntity.status(201)
        .body(Success.of(TenantView.of(tenants.create(principal, key, body))));
  }

  @PostMapping("/updateTenantStatus")
  Success<TenantView> updateTenantStatus(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.IDEMPOTENCY_KEY, required = false) @Nullable String key,
      @Valid @RequestBody Commands.UpdateTenantStatus body) {
    AegisPrincipal principal = authorizer.requireAction(auth, "registry.updateTenantStatus");
    return Success.of(TenantView.of(tenants.updateStatus(principal, key, body)));
  }
}
