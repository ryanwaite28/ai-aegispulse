package io.aegispulse.registry.adapters.http;

import io.aegispulse.registry.service.SigningKeys;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** FR-AUTH-05: bare RFC 7517 JWK Set (not the §8.2 envelope); public. */
@RestController
class JwksController {
  static final MediaType JWK_SET = MediaType.parseMediaType("application/jwk-set+json");

  private final SigningKeys keys;

  JwksController(SigningKeys keys) {
    this.keys = keys;
  }

  @GetMapping("/.well-known/jwks.json")
  ResponseEntity<String> jwks() {
    return ResponseEntity.ok()
        .contentType(JWK_SET)
        .cacheControl(CacheControl.maxAge(java.time.Duration.ofMinutes(10)).cachePublic())
        .body(keys.jwksJson());
  }
}
