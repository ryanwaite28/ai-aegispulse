# syntax=docker/dockerfile:1
# Java service image (PROJECT.md §5.4, §6.3, NFR-15): multi-stage, non-root, read-only root FS at runtime (writable
# /tmp only), JRE only, OpenTelemetry Java agent attached, heap capped at 70% of the container limit.
#   docker build -f deploy/docker/java-service.Dockerfile --build-arg SERVICE=registry --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
FROM eclipse-temurin:25-jdk-noble AS build
ARG SERVICE
WORKDIR /repo
COPY . .
RUN test -n "${SERVICE}" \
 && ./gradlew --no-daemon -q ":${SERVICE}:bootJar" ":${SERVICE}:copyOtelAgent" -x test \
 && mkdir -p /out \
 && cp "services/${SERVICE}/build/libs/${SERVICE}-0.1.0.jar" /out/app.jar \
 && cp "services/${SERVICE}/build/otel/opentelemetry-javaagent.jar" /out/
ARG GIT_SHA=dev
RUN printf 'aegis.version=%s\n' "${GIT_SHA}" > /out/build-info.properties

FROM eclipse-temurin:25-jre-noble
RUN groupadd --system --gid 10001 aegis && useradd --system --uid 10001 --gid aegis --no-create-home aegis
WORKDIR /app
COPY --from=build /out/ /app/
USER 10001:10001
# Heap 50% of the container limit: ~290 MiB non-heap (Spring, OTel agent, metaspace) must fit too (PROJECT.md §3).
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=50 -XX:+ExitOnOutOfMemoryError -Djava.io.tmpdir=/tmp -javaagent:/app/opentelemetry-javaagent.jar"
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
