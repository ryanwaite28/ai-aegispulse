package io.aegispulse.registry.adapters.http;

import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.platform.security.ServiceActionAuthorizer;
import io.aegispulse.registry.service.AuthService;
import io.aegispulse.registry.service.AuthViews;
import io.aegispulse.registry.service.ClientCredentialsService;
import io.aegispulse.registry.service.Commands;
import jakarta.validation.Valid;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Internal auth actions (FR-AUTH-01..04, 07): parse → one service call → map. */
@RestController
@RequestMapping("/internal/v1")
class AuthController {
  private final ServiceActionAuthorizer authorizer;
  private final AuthService auth;
  private final ClientCredentialsService clientCredentials;

  AuthController(
      ServiceActionAuthorizer authorizer,
      AuthService auth,
      ClientCredentialsService clientCredentials) {
    this.authorizer = authorizer;
    this.auth = auth;
    this.clientCredentials = clientCredentials;
  }

  @PostMapping("/login")
  Success<AuthViews.TokenPair> login(
      @Nullable Authentication authentication, @Valid @RequestBody Commands.Login body) {
    authorizer.requireAction(authentication, "registry.login");
    return Success.of(auth.login(body));
  }

  @PostMapping("/refreshToken")
  Success<AuthViews.TokenPair> refreshToken(
      @Nullable Authentication authentication, @Valid @RequestBody Commands.RefreshToken body) {
    authorizer.requireAction(authentication, "registry.refreshToken");
    return Success.of(auth.refresh(body.refreshToken()));
  }

  @PostMapping("/logout")
  Success<Map<String, Object>> logout(
      @Nullable Authentication authentication, @Valid @RequestBody Commands.RefreshToken body) {
    AegisPrincipal principal = authorizer.requireAction(authentication, "registry.logout");
    auth.logout(principal, body.refreshToken());
    return Success.of(Map.of());
  }

  @PostMapping("/changePassword")
  Success<Map<String, Object>> changePassword(
      @Nullable Authentication authentication, @Valid @RequestBody Commands.ChangePassword body) {
    AegisPrincipal principal = authorizer.requireAction(authentication, "registry.changePassword");
    auth.changePassword(principal, body);
    return Success.of(Map.of());
  }

  @PostMapping("/getCurrentPrincipal")
  Success<AuthViews.Principal> getCurrentPrincipal(@Nullable Authentication authentication) {
    AegisPrincipal principal =
        authorizer.requireAction(authentication, "registry.getCurrentPrincipal");
    return Success.of(auth.currentPrincipal(principal));
  }

  /** The only unauthenticated internal action (FR-AUTH-04): credentials are in the body. */
  @PostMapping("/issueClientCredentialsToken")
  Success<AuthViews.AccessToken> issueClientCredentialsToken(
      @Valid @RequestBody Commands.IssueClientCredentials body) {
    return Success.of(clientCredentials.issue(body));
  }
}
