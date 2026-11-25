// cases service (PROJECT.md §6.1; Java 25, Spring Boot 4.2): evaluations, cases, policy, audit, correlation (§2.12–§2.14).
plugins {
    java
    alias(libs.plugins.spring.boot)
}

group = "io.aegispulse"
version = "0.1.0"

val otelAgent: Configuration by configurations.creating { isTransitive = false }

dependencies {
    implementation(project(":java-platform"))
    otelAgent(libs.otel.javaagent)

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation(libs.archunit.junit5)
    testImplementation(libs.json.schema.validator) // event payloads vs packages/contracts/events
    testImplementation("org.testcontainers:testcontainers-junit-jupiter")
    testImplementation("org.testcontainers:testcontainers-postgresql")
    testImplementation("org.testcontainers:testcontainers-rabbitmq")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// Integration tests (Testcontainers; need Docker) are tagged and run by `integrationTest` (make test-integration).
tasks.test {
    useJUnitPlatform { excludeTags("integration") }
}
val buildMigrateImage by tasks.registering(Exec::class) {
    description = "Builds aegispulse-migrate:test from deploy/docker/migrate.Dockerfile."
    workingDir = rootProject.projectDir
    commandLine("docker", "build", "--quiet", "-t", "aegispulse-migrate:test", "-f", "deploy/docker/migrate.Dockerfile", ".")
}
val integrationTest by tasks.registering(Test::class) {
    dependsOn(buildMigrateImage)
    description = "Testcontainers integration tests (PostgreSQL 18, RabbitMQ 4)."
    group = "verification"
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    useJUnitPlatform { includeTags("integration") }
    shouldRunAfter(tasks.test)
}

springBoot { mainClass.set("io.aegispulse.cases.CasesApplication") }

// The OpenTelemetry Java agent (§6.3) is resolved through Gradle (checksummed by the lockfile/cache), never curl'd.
val copyOtelAgent by tasks.registering(Copy::class) {
    from(otelAgent)
    into(layout.buildDirectory.dir("otel"))
    rename { "opentelemetry-javaagent.jar" }
}
tasks.named("bootJar") { finalizedBy(copyOtelAgent) }
