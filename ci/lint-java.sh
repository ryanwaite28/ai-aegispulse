#!/usr/bin/env bash
# Gradle build checks: google-java-format (Spotless), then compile with -Werror + Error Prone + NullAway (NFR-14).
set -euo pipefail
cd "$(dirname "$0")/.."
./gradlew --no-daemon -q projects
./gradlew --no-daemon spotlessCheck
./gradlew --no-daemon assemble
echo "lint-java: OK"
