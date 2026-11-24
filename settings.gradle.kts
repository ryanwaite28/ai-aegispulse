// Gradle multi-project for the Java runtimes (PROJECT.md §6.1). Projects are included once their directories exist (Phase 1+).
rootProject.name = "aegispulse"

pluginManagement {
    repositories { gradlePluginPortal() }
}

// Single, centrally declared repository; projects may not add their own (supply-chain hygiene).
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { mavenCentral() }
}

val javaProjects = listOf(
    "packages/java-platform" to "java-platform",
    "services/registry" to "registry",
    "services/cases" to "cases",
)
javaProjects.filter { (dir, _) -> file(dir).isDirectory }.forEach { (dir, name) ->
    include(name)
    project(":$name").projectDir = file(dir)
}
