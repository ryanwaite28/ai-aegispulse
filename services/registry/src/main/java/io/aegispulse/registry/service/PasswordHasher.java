package io.aegispulse.registry.service;

import com.password4j.Argon2Function;
import com.password4j.Password;
import com.password4j.types.Argon2;
import io.aegispulse.platform.errors.DomainException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import org.springframework.stereotype.Component;

/**
 * Argon2id with FR-TEN-04 parameters (m = 64 MiB, t = 3, p = 1), PHC string output.
 *
 * <p>Each hash or verify holds 64 MiB of heap, so concurrency is bounded: at most {@value
 * #MAX_CONCURRENT} run at once (fair queue). A caller that waits longer than {@value
 * #MAX_WAIT_SECONDS} s gets 429. Without this bound, a burst on the unauthenticated
 * client-credentials or login actions exhausts the heap (observed: 8 concurrent verifies OOM a 768
 * MiB registry).
 */
@Component
public class PasswordHasher {
  static final int MEMORY_KIB = 65_536;
  static final int ITERATIONS = 3;
  static final int PARALLELISM = 1;
  static final int TAG_BYTES = 32;
  static final int SALT_BYTES = 16;
  static final int MAX_CONCURRENT = 2;
  static final long MAX_WAIT_SECONDS = 10;
  private static final Argon2Function ARGON2ID =
      Argon2Function.getInstance(MEMORY_KIB, ITERATIONS, PARALLELISM, TAG_BYTES, Argon2.ID, 19);

  private final Semaphore permits = new Semaphore(MAX_CONCURRENT, true);

  public String hash(String password) {
    return bounded(
        () -> Password.hash(password).addRandomSalt(SALT_BYTES).with(ARGON2ID).getResult());
  }

  public boolean verify(String password, String phc) {
    return bounded(
        () -> Password.check(password, phc).with(Argon2Function.getInstanceFromHash(phc)));
  }

  <T> T bounded(Supplier<T> work) {
    boolean acquired;
    try {
      acquired = permits.tryAcquire(MAX_WAIT_SECONDS, TimeUnit.SECONDS);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      acquired = false;
    }
    if (!acquired) {
      throw new DomainException.RateLimited(
          "RATE_LIMITED", "authentication is busy; retry shortly");
    }
    try {
      return work.get();
    } finally {
      permits.release();
    }
  }
}
