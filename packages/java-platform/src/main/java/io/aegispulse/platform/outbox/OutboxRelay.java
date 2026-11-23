package io.aegispulse.platform.outbox;

import io.aegispulse.platform.errors.ConsumerFailure;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * In-process outbox relay (§6.6): polls every 250 ms, publishes due rows with publisher confirms,
 * marks SENT or backs off. Stops before the connection pools on shutdown and finishes its in-flight
 * batch (NFR-11). Exposes {@code aegispulse_outbox_lag_seconds}.
 */
public final class OutboxRelay implements SmartLifecycle {
  private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);

  private final OutboxRepository repository;
  private final EnvelopePublisher publisher;
  private final TransactionTemplate tx;
  private final Duration interval;
  private final int batchSize;
  private final AtomicLong lagMillis = new AtomicLong();
  private final Object pollLock = new Object();
  private @Nullable ScheduledExecutorService executor;
  private @Nullable ScheduledFuture<?> task;
  private volatile boolean running;
  private long lastLagRefresh;

  public OutboxRelay(
      OutboxRepository repository,
      EnvelopePublisher publisher,
      TransactionTemplate tx,
      Duration interval,
      int batchSize,
      @Nullable MeterRegistry meters) {
    this.repository = repository;
    this.publisher = publisher;
    this.tx = tx;
    this.interval = interval;
    this.batchSize = batchSize;
    if (meters != null) {
      Gauge.builder("aegispulse_outbox_lag_seconds", lagMillis, v -> v.get() / 1000.0)
          .description("Age of the oldest PENDING outbox row")
          .baseUnit("seconds")
          .register(meters);
    }
  }

  /**
   * One poll; returns rows processed. Serialized with the scheduler (public for tests and drain).
   */
  public int runOnce() {
    synchronized (pollLock) {
      Integer processed =
          tx.execute(status -> {
            List<OutboxRepository.Row> rows = repository.claimBatch(batchSize);
            List<UUID> sent = new ArrayList<>();
            for (OutboxRepository.Row row : rows) {
              try {
                publisher.publish(row.message());
                sent.add(row.id());
              } catch (RuntimeException e) {
                String reason = ConsumerFailure.describe(e);
                String newStatus = repository.markFailed(row, reason);
                var event = "FAILED".equals(newStatus) ? log.atError() : log.atWarn();
                event
                    .addKeyValue("eventId", row.eventId())
                    .addKeyValue("attempts", row.attempts() + 1)
                    .addKeyValue("err", reason)
                    .log(
                        "FAILED".equals(newStatus)
                            ? "outbox row FAILED after max attempts"
                            : "outbox publish failed; backing off");
              }
            }
            repository.markSent(sent);
            return rows.size();
          });
      long now = System.currentTimeMillis();
      if (now - lastLagRefresh >= 5_000) {
        lastLagRefresh = now;
        lagMillis.set(Math.round(repository.lagSeconds() * 1000));
      }
      return processed == null ? 0 : processed;
    }
  }

  public double lagSeconds() {
    return lagMillis.get() / 1000.0;
  }

  /**
   * Polls run under a valid but unsampled parent, so the agent's parent-based sampler drops the
   * JDBC/AMQP spans of idle polling (4 polls/s per service would otherwise flood the trace store).
   * Real request traces are unaffected.
   */
  static Context quietContext() {
    ThreadLocalRandom random = ThreadLocalRandom.current();
    String traceId = String.format("%016x%016x", random.nextLong() | 1L, random.nextLong());
    String spanId = String.format("%016x", random.nextLong() | 1L);
    SpanContext unsampled =
        SpanContext.create(traceId, spanId, TraceFlags.getDefault(), TraceState.getDefault());
    return Context.root().with(Span.wrap(unsampled));
  }

  private void tick() {
    try (Scope ignored = quietContext().makeCurrent()) {
      while (running && runOnce() >= batchSize) {
        // a full batch means more rows are due: keep draining
      }
    } catch (RuntimeException e) {
      log.atError().addKeyValue("err", ConsumerFailure.describe(e)).log("outbox relay poll failed");
    }
  }

  @Override
  public void start() {
    ScheduledExecutorService ex =
        Executors.newSingleThreadScheduledExecutor(
            Thread.ofVirtual().name("outbox-relay").factory());
    executor = ex;
    running = true;
    task = ex.scheduleWithFixedDelay(this::tick, 0, interval.toMillis(), TimeUnit.MILLISECONDS);
  }

  @Override
  public void stop() {
    running = false;
    ScheduledFuture<?> t = task;
    if (t != null) {
      t.cancel(false);
    }
    ScheduledExecutorService ex = executor;
    if (ex != null) {
      ex.shutdown();
      try {
        if (!ex.awaitTermination(20, TimeUnit.SECONDS)) {
          log.warn("outbox relay batch did not finish within 20s");
        }
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
    }
  }

  @Override
  public boolean isRunning() {
    return running;
  }

  /** Stops after the HTTP server and listener containers, before connection pools close. */
  @Override
  public int getPhase() {
    return Integer.MAX_VALUE - 2048;
  }
}
