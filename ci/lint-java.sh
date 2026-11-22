#!/usr/bin/env bash
# Gradle build checks (Spotless/Error Prone/ArchUnit are added with the first Java project in Phase 1).
set -euo pipefail
cd "$(dirname "$0")/.."
./gradlew --no-daemon -q projects
./gradlew --no-daemon assemble
echo "lint-java: OK"
