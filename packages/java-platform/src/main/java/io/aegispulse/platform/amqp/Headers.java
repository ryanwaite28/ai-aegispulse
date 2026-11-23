package io.aegispulse.platform.amqp;

/** §6.4 AMQP headers. */
public final class Headers {
  public static final String RETRY_COUNT = "x-retry-count";
  public static final String TENANT = "x-aegis-tenant";
  public static final String SCHEMA_VERSION = "x-aegis-schema-version";
  public static final String REPLAY_JOB = "x-aegis-replay-job";
  public static final String REPLAY_GENERATION = "x-aegis-replay-generation";
  public static final String ERROR_CODE = "x-aegis-error-code";
  public static final String ORIGINAL_QUEUE = "x-aegis-original-queue";

  private Headers() {}
}
