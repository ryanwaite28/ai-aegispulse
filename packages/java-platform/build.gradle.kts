// java-platform (PROJECT.md §6.1, Phase 1c): Spring Boot starter shared by registry and cases. No business logic.
plugins {
    `java-library`
}

group = "io.aegispulse"
version = "0.1.0"

val contracts = rootProject.file("packages/contracts")

sourceSets {
    main {
        // Generated contract records (make contracts) compile into the platform; never hand-edited.
        java.srcDir(contracts.resolve("generated/java"))
    }
}

tasks.processResources {
    from(contracts.resolve("envelope")) {
        include("canonical-envelope.v1.schema.json")
        into("aegispulse/contracts/envelope")
    }
}

tasks.processTestResources {
    from(contracts.resolve("envelope/examples")) { into("aegispulse/contracts/envelope/examples") }
    from(contracts.resolve("topology/aegispulse.topology.json")) { into("aegispulse/contracts/topology") }
}

dependencies {
    api(platform(libs.spring.boot.bom))
    api(libs.jspecify)
    api("org.springframework.boot:spring-boot-starter")
    api("org.springframework.boot:spring-boot-starter-jackson")
    api("org.springframework.boot:spring-boot-starter-webmvc")
    api("org.springframework.boot:spring-boot-starter-validation")
    api("org.springframework.boot:spring-boot-starter-actuator")
    api("org.springframework.boot:spring-boot-starter-security-oauth2-resource-server")
    api("org.springframework.boot:spring-boot-starter-rabbitmq")
    api("org.springframework.boot:spring-boot-starter-jdbc")
    implementation(libs.json.schema.validator)
    // OTel API only (version from the Boot BOM); the Java agent supplies the SDK at runtime (§6.3).
    implementation("io.opentelemetry:opentelemetry-api")
    runtimeOnly("org.postgresql:postgresql")
    // Rules are compiled against ArchUnit; services bring it on their test classpath.
    compileOnly(libs.archunit)

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.boot:spring-boot-starter-webmvc-test")
    testImplementation(libs.archunit.junit5)
    testImplementation("org.testcontainers:testcontainers-junit-jupiter")
    testImplementation("org.testcontainers:testcontainers-postgresql")
    testImplementation("org.testcontainers:testcontainers-rabbitmq")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// Integration tests (Testcontainers, need Docker) are tagged and run by `integrationTest` (make test-integration).
tasks.test {
    useJUnitPlatform { excludeTags("integration") }
}
// The same Flyway runner image `make migrate` uses (BuildKit only sends the COPY sources it references).
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
