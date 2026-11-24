package io.aegispulse.registry.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class PasswordHasherTest {
  private final PasswordHasher hasher = new PasswordHasher();

  @Test
  void FR_TEN_04_argon2idParametersAndRoundTrip() {
    String phc = hasher.hash("violet-Harbor-71-quartz!");
    assertThat(phc).startsWith("$argon2id$v=19$m=65536,t=3,p=1$");
    assertThat(hasher.verify("violet-Harbor-71-quartz!", phc)).isTrue();
    assertThat(hasher.verify("violet-Harbor-71-quartz?", phc)).isFalse();
    assertThat(hasher.hash("violet-Harbor-71-quartz!")).isNotEqualTo(phc); // random salt
  }

  @Test
  void FR_TEN_04_concurrentHashingIsBoundedSoBurstsCannotExhaustTheHeap() throws Exception {
    AtomicInteger running = new AtomicInteger();
    AtomicInteger peak = new AtomicInteger();
    CountDownLatch release = new CountDownLatch(1);
    try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
      List<Future<Integer>> tasks = new ArrayList<>();
      for (int i = 0; i < 6; i++) {
        tasks.add(
            pool.submit(() ->
                hasher.bounded(() -> {
                  peak.accumulateAndGet(running.incrementAndGet(), Math::max);
                  try {
                    release.await();
                  } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                  }
                  return running.decrementAndGet();
                })));
      }
      Thread.sleep(300); // let every task reach the gate
      assertThat(running.get()).isEqualTo(PasswordHasher.MAX_CONCURRENT);
      release.countDown();
      for (Future<Integer> f : tasks) {
        f.get();
      }
    }
    assertThat(peak.get()).isEqualTo(PasswordHasher.MAX_CONCURRENT);
  }
}
