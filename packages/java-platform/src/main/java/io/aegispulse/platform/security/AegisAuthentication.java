package io.aegispulse.platform.security;

import java.io.Serial;
import java.util.Collection;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Spring Security authentication carrying the {@link AegisPrincipal}. Authorities are ROLE_* for
 * users.
 */
public final class AegisAuthentication extends AbstractAuthenticationToken {
  @Serial private static final long serialVersionUID = 1L;

  private final transient AegisPrincipal principal;
  private final transient Jwt jwt;

  public AegisAuthentication(
      AegisPrincipal principal, Jwt jwt, Collection<? extends GrantedAuthority> authorities) {
    super(authorities);
    this.principal = principal;
    this.jwt = jwt;
    setAuthenticated(true);
  }

  @Override
  public AegisPrincipal getPrincipal() {
    return principal;
  }

  @Override
  public Jwt getCredentials() {
    return jwt;
  }
}
