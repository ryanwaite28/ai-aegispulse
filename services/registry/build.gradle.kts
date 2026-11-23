// registry service (PROJECT.md §6.1; Java 25, Spring Boot 4.2): tenants, users, auth, RBAC, entities, watchlists (§2.1–§2.3, §2.8). Phase 1e: skeleton.
plugins {
    java
    alias(libs.plugins.spring.boot)
}

group = "io.aegispulse"
version = "0.1.0"

val otelAgent: Configuration by configurations.creating { isTransitive = false }

dependencies {
    implementation(project(":java-platform"))
    implementation("org.springframework.boot:spring-boot-starter-data-redis")
    otelAgent(libs.otel.javaagent)

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation(libs.archunit.junit5)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

springBoot { mainClass.set("io.aegispulse.registry.RegistryApplication") }

// The OpenTelemetry Java agent (§6.3) is resolved through Gradle (checksummed by the lockfile/cache), never curl'd.
val copyOtelAgent by tasks.registering(Copy::class) {
    from(otelAgent)
    into(layout.buildDirectory.dir("otel"))
    rename { "opentelemetry-javaagent.jar" }
}
tasks.named("bootJar") { finalizedBy(copyOtelAgent) }
