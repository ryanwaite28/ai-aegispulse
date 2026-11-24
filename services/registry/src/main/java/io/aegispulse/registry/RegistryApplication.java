package io.aegispulse.registry;

import java.util.Arrays;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * registry composition root. {@code java -jar app.jar bootstrap-platform-admin} runs the FR-TEN-09
 * one-shot command without a web server and exits with its code; otherwise the service starts.
 */
@SpringBootApplication
public class RegistryApplication {
  static final String BOOTSTRAP = "bootstrap-platform-admin";

  public static void main(String[] args) {
    if (Arrays.asList(args).contains(BOOTSTRAP)) {
      ConfigurableApplicationContext ctx =
          new SpringApplicationBuilder(RegistryApplication.class)
              .web(WebApplicationType.NONE)
              .properties("aegis.registry.command=" + BOOTSTRAP)
              .run(args);
      System.exit(SpringApplication.exit(ctx));
    }
    SpringApplication.run(RegistryApplication.class, args);
  }
}
