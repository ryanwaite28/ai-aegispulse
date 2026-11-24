-- V1__baseline.sql — schema `analytics` (owner service: data-intel). PROJECT.md §7.0, ADR-0004, ADR-0005.
-- Shared per-schema objects: updated_at trigger function, RLS helpers, transactional outbox, consumer dedup.
-- Runs as mig_analytics; svc_analytics receives DML through ALTER DEFAULT PRIVILEGES (deploy/compose/init/postgres).

CREATE FUNCTION analytics.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

-- Tenant context for Row-Level Security: services run `SET LOCAL app.tenant_id = '<uuid>'` per transaction (NFR-06).
CREATE FUNCTION analytics.current_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Platform jobs (cross-tenant sweeps, outbox relay) set `SET LOCAL app.bypass_rls = 'on'` inside audited repository methods only.
CREATE FUNCTION analytics.rls_bypassed() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
$$;

CREATE TABLE analytics.outbox_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID,                                  -- null only for platform-level events
  event_id      UUID NOT NULL,                         -- envelope eventId (UUIDv7)
  exchange      TEXT NOT NULL,
  routing_key   TEXT NOT NULL,
  envelope      JSONB NOT NULL,                        -- full canonical envelope (§6.4)
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  attempts      INT  NOT NULL DEFAULT 0,
  available_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),    -- backoff scheduling (§6.6)
  last_error    TEXT,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_outbox_event_id ON analytics.outbox_events (event_id);
CREATE INDEX ix_outbox_pending ON analytics.outbox_events (available_at) WHERE status = 'PENDING';
CREATE INDEX ix_outbox_sent_purge ON analytics.outbox_events (sent_at) WHERE status = 'SENT';
-- No RLS on the outbox: it is never read on behalf of a tenant request; only the in-process relay reads it.

CREATE TABLE analytics.processed_messages (            -- consumer dedup (NFR-02)
  consumer           TEXT NOT NULL,                   -- e.g. queue name
  event_id           UUID NOT NULL,
  replay_generation  INT  NOT NULL DEFAULT 0,         -- 0 = original delivery (FR-RPL-03)
  processed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (consumer, event_id, replay_generation)
);
CREATE INDEX ix_processed_messages_purge ON analytics.processed_messages (processed_at);  -- 14-day purge
