package io.aegispulse.platform.web;

import io.aegispulse.platform.logging.LogContext;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;
import org.slf4j.MDC;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Accepts or mints {@code X-Correlation-Id} (§6.4 format {@code corr-<uuid>}) and {@code
 * X-Request-Id}, puts them in the log context, and echoes them on the response. Malformed inbound
 * ids are replaced, never logged.
 */
public final class CorrelationIdFilter extends OncePerRequestFilter {
  public static final String CORRELATION_HEADER = "X-Correlation-Id";
  public static final String REQUEST_HEADER = "X-Request-Id";
  private static final Pattern CORRELATION =
      Pattern.compile("^corr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
  private static final Pattern REQUEST = Pattern.compile("^[A-Za-z0-9._-]{1,64}$");

  static String correlationId(@Nullable String inbound) {
    return inbound != null && CORRELATION.matcher(inbound).matches()
        ? inbound
        : "corr-" + UUID.randomUUID();
  }

  static String requestId(@Nullable String inbound) {
    return inbound != null && REQUEST.matcher(inbound).matches()
        ? inbound
        : "req_" + UUID.randomUUID();
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String correlation = correlationId(request.getHeader(CORRELATION_HEADER));
    String requestId = requestId(request.getHeader(REQUEST_HEADER));
    response.setHeader(CORRELATION_HEADER, correlation);
    response.setHeader(REQUEST_HEADER, requestId);
    MDC.put(LogContext.REQUEST_ID, requestId);
    try (LogContext ignored = LogContext.open(correlation, null, null)) {
      chain.doFilter(request, response);
    } finally {
      MDC.remove(LogContext.REQUEST_ID);
    }
  }
}
