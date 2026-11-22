plugins {
    base
}

// Root build: shared conventions for Java runtimes (Java 25 toolchain, -Werror). Per-project plugins land in Phase 1.
subprojects {
    plugins.withType<JavaPlugin> {
        extensions.configure<JavaPluginExtension> {
            toolchain.languageVersion.set(JavaLanguageVersion.of(25))
        }
        tasks.withType<JavaCompile>().configureEach {
            options.compilerArgs.addAll(listOf("-Xlint:all", "-Werror", "-parameters"))
        }
        tasks.withType<Test>().configureEach { useJUnitPlatform() }
    }
}
