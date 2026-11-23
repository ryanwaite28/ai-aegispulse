package io.aegispulse.platform.it;

import com.rabbitmq.client.Channel;
import com.rabbitmq.client.Connection;
import com.rabbitmq.client.ConnectionFactory;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeoutException;
import org.testcontainers.containers.Container;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.Network;
import org.testcontainers.containers.startupcheck.OneShotStartupCheckStrategy;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.rabbitmq.RabbitMQContainer;
import org.testcontainers.utility.DockerImageName;
import org.testcontainers.utility.MountableFile;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Real infrastructure, started once per JVM (PROJECT.md §12: no mocks of PostgreSQL/RabbitMQ):
 * PostgreSQL 18 initialised by the compose init script and migrated by the real migrate image
 * (connect as svc_cases); RabbitMQ 4 with the contract topology declared by an admin, plus a
 * runtime user with configure '^$'.
 */
final class Infra {
  static final Path REPO = Path.of("../..").toAbsolutePath().normalize();
  private static final List<String> SCHEMAS =
      List.of("ingestion", "files", "registry", "cases", "analytics");
  static final Map<String, String> SECRETS = new HashMap<>();
  static final Network NETWORK = Network.newNetwork();
  static final PostgreSQLContainer POSTGRES;
  static final RabbitMQContainer RABBIT;
  static final String RUNTIME_USER = "svc_cases";
  static final String RUNTIME_PASSWORD = secret();

  private Infra() {}

  static String secret() {
    byte[] b = new byte[16];
    new SecureRandom().nextBytes(b);
    return HexFormat.of().formatHex(b);
  }

  static {
    SECRETS.put("PG_BACKUP_PASSWORD", secret());
    for (String s : SCHEMAS) {
      SECRETS.put("PG_MIG_PASSWORD_" + s.toUpperCase(java.util.Locale.ROOT), secret());
      SECRETS.put("PG_SVC_PASSWORD_" + s.toUpperCase(java.util.Locale.ROOT), secret());
    }
    POSTGRES =
        new PostgreSQLContainer("postgres:18.7-alpine")
            .withNetwork(NETWORK)
            .withNetworkAliases("postgres")
            .withDatabaseName("aegispulse")
            .withUsername("aegis_admin")
            .withPassword(secret())
            .withEnv(SECRETS)
            .withCopyFileToContainer(
                MountableFile.forHostPath(
                    REPO.resolve("deploy/compose/init/postgres/01-roles-schemas.sh"), 0755),
                "/docker-entrypoint-initdb.d/01-roles-schemas.sh");
    RABBIT = new RabbitMQContainer("rabbitmq:4.4.1-management-alpine");
    POSTGRES.start();
    RABBIT.start();
    migrate();
    try {
      declareTopology();
      rabbitctl("add_user", RUNTIME_USER, RUNTIME_PASSWORD);
      rabbitctl(
          "set_permissions",
          "-p",
          "/",
          RUNTIME_USER,
          "^$",
          "^aegispulse\\.(retry|dlx|domain|intelligence)$",
          "^cases\\.audit-ingest\\.q$");
    } catch (IOException | TimeoutException | InterruptedException e) {
      throw new IllegalStateException(e);
    }
  }

  static String svcPassword() {
    return Objects.requireNonNull(SECRETS.get("PG_SVC_PASSWORD_CASES"));
  }

  private static void migrate() {
    // Built by the Gradle task buildMigrateImage (integrationTest depends on it).
    DockerImageName image = DockerImageName.parse("aegispulse-migrate:test");
    Map<String, String> env = new HashMap<>(SECRETS);
    env.put("PG_HOST", "postgres");
    env.put("PG_PORT", "5432");
    env.put("PG_DATABASE", "aegispulse");
    try (GenericContainer<?> run =
        new GenericContainer<>(image)
            .withNetwork(NETWORK)
            .withEnv(env)
            .withStartupCheckStrategy(
                new OneShotStartupCheckStrategy().withTimeout(Duration.ofMinutes(3)))) {
      run.start();
      String logs = run.getLogs();
      if (!logs.contains("aegis-migrate: done")) {
        throw new IllegalStateException("migrations failed:\n" + logs);
      }
    }
  }

  static Connection adminConnection() throws IOException, TimeoutException {
    ConnectionFactory f = new ConnectionFactory();
    f.setHost(RABBIT.getHost());
    f.setPort(RABBIT.getAmqpPort());
    f.setUsername(RABBIT.getAdminUsername());
    f.setPassword(RABBIT.getAdminPassword());
    return f.newConnection("platform-it-admin");
  }

  /**
   * Declares the contract topology as the topology owner would (test setup only; runtime users
   * never declare).
   */
  private static void declareTopology() throws IOException, TimeoutException {
    JsonNode t;
    try (InputStream in =
        Objects.requireNonNull(
            Infra.class
                .getClassLoader()
                .getResourceAsStream("aegispulse/contracts/topology/aegispulse.topology.json"))) {
      t = JsonMapper.builder().build().readTree(in);
    }
    JsonMapper json = JsonMapper.builder().build();
    try (Connection c = adminConnection();
        Channel ch = c.createChannel()) {
      for (JsonNode ex : t.get("exchanges")) {
        ch.exchangeDeclare(ex.get("name").asString(), ex.get("type").asString(), true);
      }
      for (JsonNode q : t.get("queues")) {
        @SuppressWarnings("unchecked")
        Map<String, Object> args = json.convertValue(q.get("arguments"), Map.class);
        ch.queueDeclare(q.get("name").asString(), true, false, false, args);
      }
      for (JsonNode b : t.get("bindings")) {
        ch.queueBind(
            b.get("queue").asString(),
            b.get("exchange").asString(),
            b.get("routingKey").asString());
      }
    }
  }

  private static void rabbitctl(String... args) throws IOException, InterruptedException {
    String[] cmd = new String[args.length + 2];
    cmd[0] = "rabbitmqctl";
    cmd[1] = "-q";
    System.arraycopy(args, 0, cmd, 2, args.length);
    Container.ExecResult r =
        RABBIT.execInContainer(
            org.testcontainers.containers.ExecConfig.builder()
                .user("rabbitmq")
                .command(cmd)
                .build());
    if (r.getExitCode() != 0) {
      throw new IllegalStateException("rabbitmqctl failed: " + r.getStderr());
    }
  }
}
