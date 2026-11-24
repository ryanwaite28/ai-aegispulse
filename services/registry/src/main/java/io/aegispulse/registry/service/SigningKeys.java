package io.aegispulse.registry.service;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.JWK;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.KeyUse;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.proc.SecurityContext;
import io.aegispulse.registry.db.AuthCacheStore;
import io.aegispulse.registry.db.SigningKeyRepository;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.interfaces.RSAPrivateCrtKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.RSAPublicKeySpec;
import java.text.ParseException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * FR-AUTH-05 signing keys: the current private key (from Infisical via env), and the published JWKS
 * from registry.signing_keys (CURRENT + PREVIOUS for 24 h after a rotation).
 */
@Component
public class SigningKeys {
  private static final Logger log = LoggerFactory.getLogger(SigningKeys.class);
  static final Duration PREVIOUS_PUBLISHED = Duration.ofHours(24);
  static final Duration JWKS_CACHE_TTL = Duration.ofMinutes(10);
  static final Duration LOCAL_RELOAD = Duration.ofSeconds(30);
  static final int MIN_BITS = 2048;

  private final SigningKeyRepository keys;
  private final AuthCacheStore cache;
  private final TransactionTemplate tx;
  private final Clock clock;
  private volatile @Nullable RSAKey current;
  private volatile JWKSet published = new JWKSet();
  private volatile Instant publishedAt = Instant.EPOCH;

  public SigningKeys(
      SigningKeyRepository keys,
      AuthCacheStore cache,
      PlatformTransactionManager transactions,
      Clock clock) {
    this.keys = keys;
    this.cache = cache;
    this.tx = new TransactionTemplate(transactions);
    this.clock = clock;
  }

  /**
   * Registers the configured key as CURRENT (startup; idempotent across replicas). A different
   * former CURRENT key becomes PREVIOUS; PREVIOUS keys older than 24 h are retired.
   */
  public void register(String pem, String kid) {
    RSAKey key = parse(pem, kid);
    String publicJson = key.toPublicJWK().toJSONString();
    Instant now = clock.instant();
    tx.executeWithoutResult(s -> {
      keys.lock();
      Optional<SigningKeyRepository.Stored> existing = keys.current();
      if (existing.isPresent() && existing.get().kid().equals(kid)) {
        if (!sameKey(existing.get().publicJwk(), key)) {
          throw new IllegalStateException(
              "JWT_SIGNING_KEY_CURRENT_KID " + kid + " is already registered for a different key");
        }
      } else {
        keys.demoteCurrent(now);
        keys.upsertCurrent(kid, publicJson, now);
        log.info(
            "signing_key.registered kid={} previous={}",
            kid,
            existing.map(SigningKeyRepository.Stored::kid).orElse("none"));
      }
      keys.retireReplacedBefore(now.minus(PREVIOUS_PUBLISHED));
    });
    cache.evictJwks();
    current = key;
    reload();
  }

  /** The private signing key; registration happens at startup before readiness. */
  public RSAKey current() {
    RSAKey key = current;
    if (key == null) {
      throw new IllegalStateException("signing key not registered");
    }
    return key;
  }

  /** The published public set, reloaded from the DB at most every 30 s. */
  public JWKSet publishedSet() {
    if (Duration.between(publishedAt, clock.instant()).compareTo(LOCAL_RELOAD) > 0) {
      reload();
    }
    return published;
  }

  /** Bare RFC 7517 JSON for /.well-known/jwks.json, cached in Redis (§7.7 auth:jwks:cache). */
  public String jwksJson() {
    return cache
        .jwks()
        .orElseGet(() -> {
          String json = publishedSet().toString(true);
          cache.putJwks(json, JWKS_CACHE_TTL);
          return json;
        });
  }

  /** In-process key source for the registry's own token verification (no HTTP to itself). */
  public JWKSource<SecurityContext> jwkSource() {
    return (selector, context) -> {
      List<JWK> found = selector.select(publishedSet());
      if (found.isEmpty()) {
        reload(); // unknown kid: a peer replica may just have rotated
        found = selector.select(published);
      }
      return found;
    };
  }

  private synchronized void reload() {
    Instant now = clock.instant();
    List<JWK> list = new ArrayList<>();
    for (String json : keys.publishedJwks(now.minus(PREVIOUS_PUBLISHED))) {
      try {
        list.add(JWK.parse(json));
      } catch (ParseException e) {
        throw new IllegalStateException("stored signing key is not a JWK", e);
      }
    }
    published = new JWKSet(list);
    publishedAt = now;
  }

  private static boolean sameKey(String storedJson, RSAKey key) {
    try {
      return RSAKey.parse(storedJson).toRSAPublicKey().equals(key.toRSAPublicKey());
    } catch (ParseException | com.nimbusds.jose.JOSEException e) {
      return false;
    }
  }

  /**
   * PKCS#8 PEM → RSA JWK (kid, RS256, sig). Accepts literal "\n" escapes. Errors name the variable,
   * never the value.
   */
  static RSAKey parse(String pem, String kid) {
    if (pem.isBlank() || kid.isBlank()) {
      throw new IllegalStateException(
          "JWT_SIGNING_KEY_CURRENT_PEM and JWT_SIGNING_KEY_CURRENT_KID are required");
    }
    String body =
        pem.replace("\\n", "\n")
            .replace("-----BEGIN PRIVATE KEY-----", "")
            .replace("-----END PRIVATE KEY-----", "")
            .replaceAll("\\s", "");
    try {
      KeyFactory rsa = KeyFactory.getInstance("RSA");
      RSAPrivateCrtKey privateKey =
          (RSAPrivateCrtKey)
              rsa.generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(body)));
      if (privateKey.getModulus().bitLength() < MIN_BITS) {
        throw new IllegalStateException("JWT_SIGNING_KEY_CURRENT_PEM must be RSA >= 2048 bits");
      }
      RSAPublicKey publicKey =
          (RSAPublicKey)
              rsa.generatePublic(
                  new RSAPublicKeySpec(privateKey.getModulus(), privateKey.getPublicExponent()));
      return new RSAKey.Builder(publicKey)
          .privateKey(privateKey)
          .keyID(kid)
          .algorithm(JWSAlgorithm.RS256)
          .keyUse(KeyUse.SIGNATURE)
          .build();
    } catch (GeneralSecurityException | IllegalArgumentException | ClassCastException e) {
      throw new IllegalStateException(
          "JWT_SIGNING_KEY_CURRENT_PEM is not a PKCS#8 RSA private key", null);
    }
  }
}
