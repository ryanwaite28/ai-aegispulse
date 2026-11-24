# AegisPulse unified task runner (PROJECT.md §9.5). CI logic lives in ci/*.sh; this file only dispatches.

# Toolchain resolution: prefer Homebrew node@24 / openjdk@25 when present (keg-only installs), plus corepack shims.
NODE24_BIN := $(wildcard /opt/homebrew/opt/node@24/bin)
JDK25_HOME := $(wildcard /opt/homebrew/opt/openjdk@25)
# PATH entries containing spaces (e.g. editor extensions under "Application Support") are dropped for recipes: make
# splits SHELL on whitespace, so such an entry would break every target.
SAFE_PATH := $(shell printf '%s' "$$PATH" | tr ':' '\n' | grep -v ' ' | paste -sd: -)
export PATH := $(CURDIR)/.tools/bin$(if $(NODE24_BIN),:$(NODE24_BIN)):$(SAFE_PATH)
ifneq ($(JDK25_HOME),)
export JAVA_HOME := $(JDK25_HOME)
endif
# make 3.81 resolves direct commands with its startup PATH; routing through env makes the exported PATH effective.
SHELL := env PATH=$(PATH) /bin/bash
.DEFAULT_GOAL := help

COMPOSE := docker compose --env-file .env -f deploy/compose/docker-compose.yml
ENV ?= dev

define not_yet
	@echo "make $@: not available yet — delivered in $(1) (PROJECT.md §11)." >&2; exit 2
endef

.PHONY: help
help: ## List targets
	@awk 'BEGIN{FS=":.*## "} /^[a-zA-Z0-9_-]+:.*## /{printf "  \033[36m%-18s\033[0m %s\n",$$1,$$2}' $(MAKEFILE_LIST)

# ---------------------------------------------------------------- setup
.PHONY: bootstrap env
bootstrap: ## Verify toolchains, enable pnpm (corepack), install git hooks, install deps
	@scripts/dev/bootstrap.sh
	pnpm install
	uv sync --all-groups

env: ## Create a local-only .env with generated secrets (never from Infisical; ADR-0012)
	@scripts/dev/gen-local-secrets.sh

# ---------------------------------------------------------------- local stack
.PHONY: up down reset ps logs
up: .env ## Start the local compose stack and wait for health
	$(COMPOSE) up -d
	@scripts/dev/compose-wait.sh

down: ## Stop the local stack (keeps volumes)
	$(COMPOSE) down

reset: ## Stop the local stack and DELETE local volumes
	$(COMPOSE) down -v --remove-orphans

ps: ## Show local stack status
	$(COMPOSE) ps

logs: ## Tail local stack logs (SERVICE=name to filter)
	$(COMPOSE) logs -f --tail=100 $(SERVICE)

.env:
	@scripts/dev/gen-local-secrets.sh

# ---------------------------------------------------------------- quality
.PHONY: lint lint-node lint-python lint-java lint-shell typecheck format check test test-unit test-integration test-e2e build
lint: lint-shell lint-node lint-python lint-java check ## All linters + guardrail checks

lint-shell:
	@ci/lint-shell.sh
lint-node:
	@ci/lint-node.sh
lint-python:
	@ci/lint-python.sh
lint-java:
	@ci/lint-java.sh

check: ## Guardrail checks (boundaries, migrations, resource budget) + their self-tests
	@ci/check-boundaries.sh
	@ci/check-migrations.sh
	@ci/check-resource-budget.sh
	@ci/tests/run.sh

typecheck: ## Type checks (TS workspaces + mypy)
	pnpm run typecheck
	uv run mypy $$(git ls-files -co --exclude-standard '*.py' | grep -v '/generated/')

format: ## Auto-format (Prettier + Ruff)
	pnpm run format
	uv run ruff format .

test: test-unit ## Alias for test-unit

test-unit: ## Unit suites (Vitest / JUnit / pytest)
	@ci/test-node.sh
	@ci/test-python.sh
	@ci/test-java.sh

test-integration: ## Testcontainers suites (requires Docker; no compose stack needed)
	pnpm run test:integration
	./gradlew --no-daemon integrationTest
	uv run pytest -q -m integration packages/py-platform/tests/integration

test-e2e: ## E2E + security suites against the compose stack (make up first; grows per phase)
	@scripts/dev/test-e2e.sh

build: ## Build all workspaces
	pnpm run build
	./gradlew --no-daemon assemble

# ---------------------------------------------------------------- data & contracts
.PHONY: migrate seed contracts eval
migrate: ## Flyway (5 schemas) + migrate-mongo + RabbitMQ topology (local)
	@scripts/dev/pg-bootstrap.sh
	$(COMPOSE) --profile tools run --rm --build migrate
	@scripts/dev/migrate-local.sh
	@WAIT_PROBE=readyz scripts/dev/compose-wait.sh
seed: ## Seed demo tenants/entities/watchlists via the API (re-runnable; make up + registry-bootstrap first)
	@scripts/dev/seed.sh
contracts: ## Validate contracts + regenerate TS/Python types (fails in CI on generated drift)
	@ci/contract.sh
eval: ## Golden-dataset evaluation
	$(call not_yet,Phase 16)

# ---------------------------------------------------------------- runtime helpers
.PHONY: dev images demo demo-webhook demo-upload demo-dlq check-dlq-alert chaos trigger k3d-up k3d-down env-sleep env-wake env-reset
dev: ## Run one service natively with hot reload against the compose stack (SERVICE=name; Ctrl-C restores the container)
	@test -n "$(SERVICE)" || { echo "usage: make dev SERVICE=<name>" >&2; exit 2; }
	@scripts/dev/dev-service.sh $(SERVICE)
images: ## Build all container images locally (tagged with the git sha; deploy/docker/*.Dockerfile)
	@scripts/dev/build-images.sh
demo: ## End-to-end demo scenario
	$(call not_yet,Phase 20)
demo-upload: ## Phase 5 demo: init → PUT → complete → VALIDATED, plus EICAR → QUARANTINED (make up + make seed first)
	@scripts/demo/upload.sh
demo-dlq: ## Phase 7 demo: ClamAV stopped → retries 1s/5s/30s → DLQ registry → restart → replay → VALIDATED (make seed first)
	@scripts/demo/dlq-demo.sh
check-dlq-alert: ## FR-MSG-04 local equivalent: evaluate the dlq-spike alerts against local OpenObserve + broker (exit 1 = firing)
	@uv run python scripts/dev/dlq_alert_check.py
demo-webhook: ## Phase 4 demo: signed webhook → 202 → event on aegispulse.ingress (make up + make seed first)
	@scripts/demo/webhook-demo.sh
chaos: ## Chaos scenario (SCENARIO=name; dev/local only)
	$(call not_yet,Phase 18)
trigger: ## Run a scheduler-trigger job against the local stack (JOB=name, e.g. ingestion-secret-expiry)
	@test -n "$(JOB)" || { echo "usage: make trigger JOB=<job>" >&2; exit 2; }
	$(COMPOSE) --profile tools run --rm --build scheduler-trigger $(JOB)
k3d-up k3d-down: ## Optional k3d parity cluster
	$(call not_yet,Phase 9)
env-sleep env-wake env-reset: ## Dev namespace sleep/wake/reset (refuses prod)
	@if [ "$(ENV)" = "prod" ]; then echo "refused: $@ never targets prod (ADR-0014)" >&2; exit 1; fi
	$(call not_yet,Phase 9)

# ---------------------------------------------------------------- tools
.PHONY: objectstore-compat
objectstore-compat: ## ADR-0011 S3 compatibility check against the local object store
	@set -a; . ./.env; set +a; uv run --with boto3 --with requests scripts/dev/objectstore_compat.py \
	  --endpoint http://localhost:9000 --admin-key "$$S3_ADMIN_ACCESS_KEY" --admin-secret "$$S3_ADMIN_SECRET_KEY" \
	  --scoped-key "$$S3_INGESTION_ACCESS_KEY" --scoped-secret "$$S3_INGESTION_SECRET_KEY" \
	  --bucket aegispulse-local-raw --scoped-prefix raw/webhooks/
