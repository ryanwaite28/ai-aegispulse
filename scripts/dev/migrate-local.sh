#!/usr/bin/env bash
# Local-only second half of `make migrate`: Mongo migrations (as mig_events) and RabbitMQ topology (as aegis_topology).
# Secrets are read from .env into this process only; nothing is printed.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
set -a
# shellcheck disable=SC1091
. "$root/.env"
set +a
export MONGO_MIGRATE_URI="mongodb://mig_events:${MONGO_MIG_EVENTS_PASSWORD}@localhost:27017/aegispulse_events?authSource=admin&directConnection=true"
pnpm --filter @aegispulse/events run migrate:mongo
export AMQP_URL="amqp://aegis_topology:${RABBITMQ_TOPOLOGY_PASSWORD}@localhost:5672/aegispulse-local"
pnpm --filter @aegispulse/contracts run topology:assert
