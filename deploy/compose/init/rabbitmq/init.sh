#!/bin/sh
# Creates vhost, topology user, and per-runtime users via the management API (PROJECT.md §5.7.3).
# Runtime users cannot declare topology (configure '^$'), except the gateway's per-pod SSE queues.
set -eu
API="http://rabbitmq:15672/api"
AUTH="aegis_admin:${RABBITMQ_ADMIN_PASSWORD}"
VHOST="aegispulse-local"
put() { curl -sf -u "$AUTH" -H 'content-type: application/json' -X PUT "$API/$1" -d "$2" >/dev/null; }

put "vhosts/$VHOST" '{}'
put "users/aegis_topology" "{\"password\":\"${RABBITMQ_TOPOLOGY_PASSWORD}\",\"tags\":\"\"}"
put "permissions/$VHOST/aegis_topology" '{"configure":".*","write":".*","read":".*"}'
put "permissions/$VHOST/aegis_admin" '{"configure":".*","write":".*","read":".*"}'

EXCHANGES='^aegispulse\\.(ingress|enrichment|domain|intelligence|retry|dlx)$'
for svc in ingestion files events orchestrator cases registry doc_extraction data_intel gateway; do
  upper=$(echo "$svc" | tr '[:lower:]' '[:upper:]')
  pw=$(printenv "RABBITMQ_PASSWORD_${upper}")
  owner=$(echo "$svc" | sed 's/_/-/g; s/doc-extraction/doc/; s/data-intel/intel/')
  configure='^$'; write="$EXCHANGES"; read="^${owner}\\\\..*$"
  if [ "$svc" = "gateway" ]; then
    # SSE only (FR-SSE-01): declare + bind its per-pod queue (read on source exchanges), never publish.
    configure='^gateway\\.sse\\..*$'; write='^gateway\\.sse\\..*$'
    read='^(gateway\\.sse\\..*|aegispulse\\.(enrichment|domain))$'
  fi
  put "users/svc_${svc}" "{\"password\":\"${pw}\",\"tags\":\"\"}"
  put "permissions/$VHOST/svc_${svc}" "{\"configure\":\"${configure}\",\"write\":\"${write}\",\"read\":\"${read}\"}"
  echo "user svc_${svc}: configure=${configure} write=${write} read=${read}"
done
echo "rabbitmq init: done"
