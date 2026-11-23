# syntax=docker/dockerfile:1
# Python service image (PROJECT.md §5.4, NFR-15): multi-stage, non-root, read-only root FS at runtime (writable /tmp
# only), self-contained venv with non-editable workspace packages, no uv or build tooling in the final stage.
#   docker build -f deploy/docker/python-service.Dockerfile --build-arg SERVICE=risk-scoring \
#     --build-arg MODULE=aegis_risk.main:app --build-arg PORT=8086 --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
FROM ghcr.io/astral-sh/uv:0.13.9-python3.13-trixie-slim AS build
ARG SERVICE
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /repo
COPY . .
RUN test -n "${SERVICE}" && uv sync --frozen --no-dev --no-editable --package "${SERVICE}"
ARG GIT_SHA=dev
RUN printf '{"gitSha":"%s"}\n' "${GIT_SHA}" > /app/build-info.json

# Same interpreter as the build stage (3.13.18 at /usr/local/bin/python), so the venv's links stay valid.
FROM python:3.13.18-slim-trixie
RUN groupadd --system --gid 10001 aegis && useradd --system --uid 10001 --gid aegis --no-create-home aegis
COPY --from=build /app /app
ARG MODULE
ARG PORT
ENV PATH="/app/.venv/bin:${PATH}" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    APP_MODULE="${MODULE}" APP_PORT="${PORT}"
WORKDIR /app
USER 10001:10001
ENTRYPOINT ["sh", "-c", "exec uvicorn \"$APP_MODULE\" --host 0.0.0.0 --port \"$APP_PORT\" --no-access-log --timeout-graceful-shutdown 20"]
