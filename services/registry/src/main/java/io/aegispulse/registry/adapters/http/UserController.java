package io.aegispulse.registry.adapters.http;

import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.platform.security.ServiceActionAuthorizer;
import io.aegispulse.registry.domain.User;
import io.aegispulse.registry.service.Commands;
import io.aegispulse.registry.service.Page;
import io.aegispulse.registry.service.UserService;
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

/** Internal user actions (§6.2); X-Aegis-Tenant is forwarded unchanged by the gateway. */
@RestController
@RequestMapping("/internal/v1")
class UserController {
  private final ServiceActionAuthorizer authorizer;
  private final UserService users;

  UserController(ServiceActionAuthorizer authorizer, UserService users) {
    this.authorizer = authorizer;
    this.users = users;
  }

  @PostMapping("/createUser")
  ResponseEntity<Success<User>> createUser(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @RequestHeader(value = Headers.IDEMPOTENCY_KEY, required = false) @Nullable String key,
      @Valid @RequestBody Commands.CreateUser body) {
    AegisPrincipal principal = authorizer.requireAction(auth, "registry.createUser");
    return ResponseEntity.status(201)
        .body(Success.of(users.create(principal, Headers.actingTenant(acting), key, body)));
  }

  @PostMapping("/listUsers")
  Success<List<User>> listUsers(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @Valid @RequestBody Commands.ListUsers body) {
    AegisPrincipal principal = authorizer.requireAction(auth, "registry.listUsers");
    Page<User> page = users.list(principal, Headers.actingTenant(acting), body);
    return Success.of(page.items(), page.nextCursor());
  }

  @PostMapping("/updateUser")
  Success<User> updateUser(
      @Nullable Authentication auth,
      @RequestHeader(value = Headers.ACTING_TENANT, required = false) @Nullable String acting,
      @RequestHeader(value = Headers.IDEMPOTENCY_KEY, required = false) @Nullable String key,
      @Valid @RequestBody Commands.UpdateUser body) {
    AegisPrincipal principal = authorizer.requireAction(auth, "registry.updateUser");
    return Success.of(users.update(principal, Headers.actingTenant(acting), key, body));
  }
}
