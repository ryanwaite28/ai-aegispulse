import net.ltgt.gradle.errorprone.CheckSeverity
import net.ltgt.gradle.errorprone.errorprone

plugins {
    base
    alias(libs.plugins.errorprone) apply false
    alias(libs.plugins.spotless) apply false
}

// Shared conventions for the Java runtimes (NFR-14): Java 25 toolchain, -Xlint:all -Werror, Error Prone + NullAway
// (JSpecify, packages under io.aegispulse), google-java-format via Spotless. -Xlint:-try allows the MDC scope idiom
// `try (LogContext ignored = ...)`; -Xlint:-processing silences "no processor claimed" noise.
val catalog = extensions.getByType<VersionCatalogsExtension>().named("libs")

subprojects {
    plugins.withType<JavaPlugin> {
        apply(plugin = "net.ltgt.errorprone")
        apply(plugin = "com.diffplug.spotless")

        extensions.configure<JavaPluginExtension> {
            toolchain.languageVersion.set(JavaLanguageVersion.of(25))
        }
        dependencies {
            "errorprone"(catalog.findLibrary("errorprone-core").get())
            "errorprone"(catalog.findLibrary("nullaway").get())
        }
        tasks.withType<JavaCompile>().configureEach {
            options.compilerArgs.addAll(listOf("-Xlint:all", "-Xlint:-processing", "-Xlint:-try", "-Werror", "-parameters"))
            options.errorprone {
                disableWarningsInGeneratedCode.set(true)
                check("NullAway", CheckSeverity.ERROR)
                option("NullAway:AnnotatedPackages", "io.aegispulse")
                option("NullAway:JSpecifyMode", "true")
                // Generated contract records live in their own source tree and are excluded from analysis.
                excludedPaths.set(".*/packages/contracts/generated/.*")
                if (name.contains("Test")) {
                    check("NullAway", CheckSeverity.OFF)
                }
            }
        }
        tasks.withType<Test>().configureEach { useJUnitPlatform() }

        extensions.configure<com.diffplug.gradle.spotless.SpotlessExtension> {
            java {
                target("src/**/*.java")
                googleJavaFormat(catalog.findVersion("google-java-format").get().requiredVersion)
                removeUnusedImports()
            }
        }
    }
}
