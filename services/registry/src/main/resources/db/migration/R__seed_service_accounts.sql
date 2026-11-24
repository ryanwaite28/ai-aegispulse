-- Internal SERVICE accounts and their act[] allowlists (PROJECT.md §5.7.4, FR-TEN-07, ADR-0017). Secrets are NOT here:
-- the registry reconciles verifiers at startup from SERVICE_CLIENT_SECRET_{RUNTIME}. Changing an allowlist = editing
-- this file in a reviewed MR. Runs as registry_platform (BYPASSRLS) because SERVICE rows have no tenant.
SET ROLE registry_platform;

INSERT INTO registry.service_accounts (client_id, name, kind, allowed_actions) VALUES
  ('svc-gateway', 'gateway', 'SERVICE',
   ARRAY['registry.login', 'registry.refreshToken', 'ingestion.ingestWebhookDelivery']),
  ('svc-orchestrator', 'orchestrator', 'SERVICE',
   ARRAY['registry.resolveEntities', 'registry.checkWatchlists', 'registry.getTenantSettings', 'riskScoring.score',
         'cases.recordRiskEvaluation', 'cases.reevaluateOpenCases', 'cases.openCase', 'cases.attachEvidence',
         'events.searchEventsForEntities']),
  ('svc-ingestion', 'ingestion', 'SERVICE', ARRAY['files.registerRemoteFile', 'registry.getTenantSettings']),
  ('svc-files', 'files', 'SERVICE', ARRAY['registry.getTenantSettings']),
  ('svc-events', 'events', 'SERVICE', ARRAY['scanner.scan', 'registry.getTenantSettings']),
  ('svc-doc-extraction', 'doc-extraction', 'SERVICE',
   ARRAY['files.markProcessing', 'files.getInternalDownloadUrl', 'files.recordExtractionResult',
         'files.recordProcessingFailure', 'ingestion.submitTransactionBatch', 'registry.resolveEntities']),
  ('svc-risk-scoring', 'risk-scoring', 'SERVICE', ARRAY[]::text[]),
  ('svc-data-intel', 'data-intel', 'SERVICE', ARRAY['registry.getTenantSettings']),
  ('svc-scheduler-trigger', 'scheduler-trigger', 'SERVICE',
   ARRAY['ingestion.runDueConnectors', 'ingestion.expirePreviousSecrets', 'files.sweepOrphans', 'files.purgeRetention',
         'events.sweepPendingScans', 'events.purgeRetention', 'cases.runEnrichmentTimeouts', 'cases.autoResolveCleared',
         'cases.verifyAuditChain', 'dataIntel.runRollups', 'dataIntel.runDriftChecks', 'dataIntel.exportParquet'])
ON CONFLICT (client_id) DO UPDATE
  SET name = EXCLUDED.name, allowed_actions = EXCLUDED.allowed_actions
  WHERE registry.service_accounts.kind = 'SERVICE';

RESET ROLE;
