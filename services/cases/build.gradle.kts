// cases service (PROJECT.md §6.1; Java 25, Spring Boot 4.2): evaluations, cases, policy, audit, correlation (§2.12–§2.14). Phase 1e: skeleton.
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
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

springBoot { mainClass.set("io.aegispulse.cases.CasesApplication") }

// The OpenTelemetry Java agent (§6.3) is resolved through Gradle (checksummed by the lockfile/cache), never curl'd.
val copyOtelAgent by tasks.registering(Copy::class) {
    from(otelAgent)
    into(layout.buildDirectory.dir("otel"))
    rename { "opentelemetry-javaagent.jar" }
}
tasks.named("bootJar") { finalizedBy(copyOtelAgent) }
