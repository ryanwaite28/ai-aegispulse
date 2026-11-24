package io.aegispulse.registry.adapters.http;

import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.platform.security.ServiceActionAuthorizer;
import io.aegispulse.registry.domain.ServiceAccount;
import io.aegispulse.registry.service.AuthViews;
import io.aegispulse.registry.service.Commands;
import io.aegispulse.registry.service.Page;
import io.aegispulse.registry.service.ServiceAccountService;
import jakarta.validation.Valid;
import java.util.List;
import org.jspecify.annotations.Nullable;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Internal INTEGRATION service-account actions (FR-TEN-06). */
@RestController
@RequestMapping("/internal/v1")
class ServiceAccountController {
  private final ServiceActionAuthorizer authorizer;
  private final ServiceAccountService accounts;

  ServiceAccountController(ServiceActionAuthorizer authorizer, ServiceAccountService accounts) {
    this.authorizer = authorizer;
    this.accounts = accounts;
  }

  @PostMapping("/createServiceAccount")
  ResponseEntity<Success<AuthViews.ServiceAccountWithSecret>> create(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @RequestHeader(value = Headers.IDEMPOTENCY_KEY, required = false) @Nullable String key,
      @Valid @RequestBody Commands.CreateServiceAccount body) {
    AegisPrincipal principal = authorizer.requireAction(auth, "registry.createServiceAccount");
    return ResponseEntity.status(201)
        .body(Success.of(accounts.create(principal, Headers.actingTenant(acting), key, body)));
  }

  @PostMapping("/listServiceAccounts")
  Success<List<ServiceAccount>> list(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @Valid @RequestBody Commands.ListServiceAccounts body) {
    AegisPrincipal principal = authorizer.requireAction(auth, "registry.listServiceAccounts");
    Page<ServiceAccount> page = accounts.list(principal, Headers.actingTenant(acting), body);
    return Success.of(page.items(), page.nextCursor());
  }

  @PostMapping("/rotateServiceAccountSecret")
  Success<AuthViews.ServiceAccountWithSecret> rotate(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @RequestHeader(value = Headers.IDEMPOTENCY_KEY, required = false) @Nullable String key,
      @Valid @RequestBody Commands.ServiceAccountRef body) {
    AegisPrincipal principal =
        authorizer.requireAction(auth, "registry.rotateServiceAccountSecret");
    return Success.of(
        accounts.rotate(principal, Headers.actingTenant(acting), key, body.serviceAccountId()));
  }

  @PostMapping("/revokeServiceAccount")
  Success<ServiceAccount> revoke(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @Valid @RequestBody Commands.ServiceAccountRef body) {
    AegisPrincipal principal = authorizer.requireAction(auth, "registry.revokeServiceAccount");
    return Success.of(
        accounts.revoke(principal, Headers.actingTenant(acting), body.serviceAccountId()));
  }
}
