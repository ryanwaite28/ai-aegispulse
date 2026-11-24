package io.aegispulse.platform.autoconfigure;

import io.aegispulse.platform.amqp.AmqpEnvelopePublisher;
import io.aegispulse.platform.amqp.EnvelopeCodec;
import io.aegispulse.platform.amqp.EnvelopeListeners;
import io.aegispulse.platform.config.AegisPlatformProperties;
import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.health.FlywaySchemaVersionHealthIndicator;
import io.aegispulse.platform.outbox.OutboxRelay;
import io.aegispulse.platform.outbox.OutboxRepository;
import io.aegispulse.platform.security.AegisJwt;
import io.aegispulse.platform.security.ServiceActionAuthorizer;
import io.aegispulse.platform.web.CorrelationIdFilter;
import io.aegispulse.platform.web.ErrorEnvelopeAdvice;
import io.aegispulse.platform.web.ErrorEnvelopes;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.core.Ordered;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

/**
 * java-platform auto-configuration (PROJECT.md §6.1, Phase 1c): correlation ids, §8.2 error
 * envelopes, JWT resource server with the AegisPulse token rules and probe paths open, act[]
 * authorizer, tenant scope, Flyway readiness, envelope codec, confirmed publisher, listener
 * factory, and the outbox relay when {@code aegis.outbox.schema} is set. Servlet-only beans are
 * skipped in non-web one-shot commands (e.g. registry bootstrap-platform-admin).
 */
@AutoConfiguration
@EnableConfigurationProperties(AegisPlatformProperties.class)
public class AegisPlatformAutoConfiguration {

  static final List<String> PROBE_PATHS = List.of("/livez", "/readyz", "/healthz");

  @Bean
  @ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
  FilterRegistrationBean<CorrelationIdFilter> aegisCorrelationIdFilter() {
    FilterRegistrationBean<CorrelationIdFilter> registration =
        new FilterRegistrationBean<>(new CorrelationIdFilter());
    registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
    return registration;
  }

  @Bean
  @ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
  ErrorEnvelopeAdvice aegisErrorEnvelopeAdvice() {
    return new ErrorEnvelopeAdvice();
  }

  @Bean
  @ConditionalOnMissingBean
  JwtDecoder aegisJwtDecoder(AegisPlatformProperties properties) {
    return AegisJwt.decoder(properties.security());
  }

  @Bean
  ServiceActionAuthorizer aegisServiceActionAuthorizer() {
    return new ServiceActionAuthorizer();
  }

  @Bean
  @ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
  @ConditionalOnMissingBean(SecurityFilterChain.class)
  SecurityFilterChain aegisSecurityFilterChain(
      HttpSecurity http, AegisPlatformProperties properties, JwtDecoder decoder, JsonMapper json) {
    List<String> open = new ArrayList<>(PROBE_PATHS);
    open.addAll(properties.security().publicPaths());
    AuthenticationEntryPoint unauthorized =
        (request, response, e) -> {
          response.setStatus(401);
          response.setHeader("WWW-Authenticate", "Bearer");
          response.setContentType(MediaType.APPLICATION_JSON_VALUE);
          json.writeValue(
              response.getOutputStream(),
              ErrorEnvelopes.current(
                  "UNAUTHORIZED", "missing, invalid or expired token", List.of()));
        };
    AccessDeniedHandler forbidden =
        (request, response, e) -> {
          response.setStatus(403);
          response.setContentType(MediaType.APPLICATION_JSON_VALUE);
          json.writeValue(
              response.getOutputStream(),
              ErrorEnvelopes.current("FORBIDDEN", "not allowed", List.of()));
        };
    http.csrf(c -> c.disable())
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(a ->
            a.requestMatchers(open.toArray(String[]::new)).permitAll().anyRequest().authenticated())
        .oauth2ResourceServer(o ->
            o.jwt(j -> j.decoder(decoder).jwtAuthenticationConverter(AegisJwt.converter()))
                .authenticationEntryPoint(unauthorized)
                .accessDeniedHandler(forbidden))
        .exceptionHandling(
            e -> e.authenticationEntryPoint(unauthorized).accessDeniedHandler(forbidden));
    return http.build();
  }

  @Bean
  TenantScope aegisTenantScope(JdbcClient jdbc) {
    return new TenantScope(jdbc);
  }

  /** Bean name yields the health contributor "flywaySchema" (readiness group, NFR-11 c). */
  @Bean
  FlywaySchemaVersionHealthIndicator flywaySchemaHealthIndicator(
      JdbcClient jdbc, AegisPlatformProperties properties) {
    return new FlywaySchemaVersionHealthIndicator(
        jdbc, properties.readiness().schema(), properties.readiness().minFlywayVersion());
  }

  @Bean
  EnvelopeCodec aegisEnvelopeCodec(JsonMapper json) {
    return new EnvelopeCodec(json);
  }

  @Bean
  AmqpEnvelopePublisher aegisEnvelopePublisher(RabbitTemplate rabbit, EnvelopeCodec codec) {
    return new AmqpEnvelopePublisher(rabbit, codec, Duration.ofSeconds(10));
  }

  @Bean
  EnvelopeListeners aegisEnvelopeListeners(
      ConnectionFactory connectionFactory,
      EnvelopeCodec codec,
      AmqpEnvelopePublisher publisher,
      ObjectProvider<MeterRegistry> meters) {
    return new EnvelopeListeners(connectionFactory, codec, publisher, meters.getIfAvailable());
  }

  @Bean
  @ConditionalOnProperty(prefix = "aegis.outbox", name = "schema")
  OutboxRepository aegisOutboxRepository(
      JdbcClient jdbc, JsonMapper json, AegisPlatformProperties properties) {
    return new OutboxRepository(
        jdbc, json, java.util.Objects.requireNonNull(properties.outbox().schema()));
  }

  @Bean
  @ConditionalOnProperty(prefix = "aegis.outbox", name = "schema")
  OutboxRelay aegisOutboxRelay(
      OutboxRepository repository,
      AmqpEnvelopePublisher publisher,
      PlatformTransactionManager transactions,
      AegisPlatformProperties properties,
      ObjectProvider<MeterRegistry> meters) {
    return new OutboxRelay(
        repository,
        publisher,
        new TransactionTemplate(transactions),
        properties.outbox().pollInterval(),
        properties.outbox().batchSize(),
        meters.getIfAvailable());
  }
}
