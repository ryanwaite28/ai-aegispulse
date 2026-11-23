package io.aegispulse.platform.it;

import io.aegispulse.contracts.topology.QueueName;
import io.aegispulse.platform.amqp.EnvelopeHandler;
import io.aegispulse.platform.amqp.EnvelopeListeners;
import io.aegispulse.platform.errors.ConsumerFailure;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.platform.security.ServiceActionAuthorizer;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.amqp.rabbit.listener.SimpleMessageListenerContainer;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Minimal "service" using the starter: one internal route and one consumer adapter (dispatch only).
 */
@SpringBootApplication
public class TestApplication {

  /** What the test handler does with the next deliveries. */
  enum Mode {
    OK,
    DUPLICATE,
    TRANSIENT_ONCE,
    TRANSIENT_ALWAYS,
    PERMANENT,
    SLOW
  }

  record Received(String eventId, EnvelopeHandler.DeliveryContext context) {}

  static final AtomicReference<Mode> MODE = new AtomicReference<>(Mode.OK);
  static final List<Received> RECEIVED = new CopyOnWriteArrayList<>();
  static final List<String> FINISHED = new CopyOnWriteArrayList<>();

  @Bean
  SimpleMessageListenerContainer auditIngestListener(EnvelopeListeners listeners) {
    return listeners.container(
        QueueName.CASES_AUDIT_INGEST_Q,
        (envelope, ctx) -> {
          RECEIVED.add(new Received(envelope.eventId(), ctx));
          switch (MODE.get()) {
            case DUPLICATE -> {
              return EnvelopeHandler.Outcome.DUPLICATE;
            }
            case TRANSIENT_ONCE -> {
              if (ctx.retryCount() == 0) {
                throw new ConsumerFailure.TransientException(
                    "DEPENDENCY_UNAVAILABLE", "scanner down");
              }
            }
            case TRANSIENT_ALWAYS ->
                throw new ConsumerFailure.TransientException(
                    "DEPENDENCY_UNAVAILABLE", "still down");
            case PERMANENT -> throw new DomainException.NotFound("NOT_FOUND", "case missing");
            case SLOW -> Thread.sleep(700);
            case OK -> {}
          }
          FINISHED.add(envelope.eventId());
          return EnvelopeHandler.Outcome.PROCESSED;
        });
  }

  @RestController
  static class InternalRoutes {
    private final ServiceActionAuthorizer authorizer;

    InternalRoutes(ServiceActionAuthorizer authorizer) {
      this.authorizer = authorizer;
    }

    @PostMapping("/internal/v1/ping")
    Map<String, Object> ping(Authentication authentication) {
      AegisPrincipal p = authorizer.requireAction(authentication, "cases.ping");
      return Map.of("data", Map.of("kind", p instanceof AegisPrincipal.User ? "user" : "service"));
    }

    @PostMapping("/internal/v1/missing")
    Map<String, Object> missing() {
      throw new DomainException.NotFound("NOT_FOUND", "no such case");
    }
  }
}
