#!/usr/bin/env bash
# Gradle build checks in ONE invocation (one JVM start + one configuration pass; matters in CI's fresh containers):
# google-java-format (Spotless), then compile main + test sources with -Werror + Error Prone + NullAway (NFR-14).
# `classes testClasses`, not `assemble`: lint needs compilation, not Spring Boot jar packaging. Outputs land in the
# Gradle build cache (.gradle-home in CI), so test:java's `check` reuses them.
set -euo pipefail
cd "$(dirname "$0")/.."
./gradlew --no-daemon spotlessCheck classes testClasses
echo "lint-java: OK"
