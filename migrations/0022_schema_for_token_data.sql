-- Title: Add Token Usage Events
-- Description: Creates token_usage_events, the per-request LLM token accounting table read by the token-usage recipe. Includes RLS policies, byos_app grants, and indexes for time-window queries and retention pruning.

-- =============================================================================
-- Part 1: Create token_usage_events table
-- =============================================================================

CREATE TABLE IF NOT EXISTS token_usage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The emitter's own record id, kept separate from the surrogate key so
    -- ingestion can be replayed: INSERT ... ON CONFLICT (event_id) DO NOTHING.
    -- Uniqueness is global rather than per-tenant because emitter ids are
    -- opaque and already unique. A per-tenant key would need the pair of
    -- partial indexes that `recipes` uses for slugs, since a NULL user_id
    -- defeats a plain composite UNIQUE.
    event_id TEXT NOT NULL,

    ts TIMESTAMPTZ NOT NULL,
    session_id TEXT NOT NULL,
    prompt_id TEXT,
    agent_id TEXT,
    is_sidechain BOOLEAN NOT NULL DEFAULT FALSE,

    -- Free text, deliberately not an enum: a new model id must not require a
    -- migration to start recording usage against it.
    model TEXT NOT NULL,

    -- BIGINT rather than INTEGER. A single request fits in INTEGER, but SUM()
    -- widens to BIGINT anyway, so this removes the question entirely.
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    cache_creation_input_tokens BIGINT NOT NULL DEFAULT 0,
    cache_read_input_tokens BIGINT NOT NULL DEFAULT 0,

    -- One definition of "total" for every consumer, instead of four re-derivations.
    total_tokens BIGINT GENERATED ALWAYS AS (
        input_tokens
        + output_tokens
        + cache_creation_input_tokens
        + cache_read_input_tokens
    ) STORED,

    user_id TEXT REFERENCES "user"("id") ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- A bad emitter must not be able to write negatives that would silently
    -- distort a chart segment.
    CONSTRAINT token_usage_events_counters_non_negative CHECK (
        input_tokens >= 0
        AND output_tokens >= 0
        AND cache_creation_input_tokens >= 0
        AND cache_read_input_tokens >= 0
    ),

    CONSTRAINT token_usage_events_event_id_key UNIQUE (event_id)
);

COMMENT ON TABLE token_usage_events IS 'Per-request LLM token accounting. One row per model call; grouped by model and summed by the token-usage recipe.';
COMMENT ON COLUMN token_usage_events.event_id IS 'Emitter-assigned record id. Unique, so a replayed ingest batch is a no-op via ON CONFLICT (event_id) DO NOTHING.';
COMMENT ON COLUMN token_usage_events.ts IS 'When the model call happened, as reported by the emitter (ISO-8601 UTC on the wire).';
COMMENT ON COLUMN token_usage_events.created_at IS 'When the row was ingested. Compare against ts to measure emitter lag.';
COMMENT ON COLUMN token_usage_events.is_sidechain IS 'TRUE for subagent/sidechain calls. The token-usage recipe can exclude these from its totals.';
COMMENT ON COLUMN token_usage_events.total_tokens IS 'Generated sum of the four counters. The value the token-usage recipe sorts models by.';

-- =============================================================================
-- Part 2: Indexes
-- =============================================================================

-- The recipe's access path: scope to the tenant, then walk a ts window backwards.
CREATE INDEX IF NOT EXISTS token_usage_events_user_ts_idx
    ON token_usage_events (user_id, ts DESC);

-- Tenant-agnostic time scans: retention pruning and cross-tenant rollups.
CREATE INDEX IF NOT EXISTS token_usage_events_ts_idx
    ON token_usage_events (ts DESC);

-- Session drill-down ("where did this conversation's tokens go").
CREATE INDEX IF NOT EXISTS token_usage_events_session_idx
    ON token_usage_events (session_id);

-- Intentionally no index on model or is_sidechain. Both have a handful of
-- distinct values, so the planner would ignore them; the GROUP BY reads the
-- ts range regardless.

-- =============================================================================
-- Part 3: Row Level Security
-- =============================================================================

ALTER TABLE token_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_usage_events FORCE ROW LEVEL SECURITY;

-- Session lookups are wrapped as (select current_setting(...)) so Postgres
-- evaluates them once per statement as an InitPlan rather than once per row,
-- matching the form every other tenant policy was rewritten to in 0021.

DROP POLICY IF EXISTS token_usage_events_select_policy ON token_usage_events;
CREATE POLICY token_usage_events_select_policy ON token_usage_events
    FOR SELECT
    USING (user_id = (select current_setting('app.current_user_id', true)) OR user_id IS NULL);

DROP POLICY IF EXISTS token_usage_events_insert_policy ON token_usage_events;
CREATE POLICY token_usage_events_insert_policy ON token_usage_events
    FOR INSERT
    WITH CHECK (user_id = (select current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS token_usage_events_update_policy ON token_usage_events;
CREATE POLICY token_usage_events_update_policy ON token_usage_events
    FOR UPDATE
    USING (user_id = (select current_setting('app.current_user_id', true)))
    WITH CHECK (user_id = (select current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS token_usage_events_delete_policy ON token_usage_events;
CREATE POLICY token_usage_events_delete_policy ON token_usage_events
    FOR DELETE
    USING (user_id = (select current_setting('app.current_user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON token_usage_events TO byos_app;

-- =============================================================================
-- Part 4: Retention
-- =============================================================================

-- This table grows one row per model call, so it needs pruning eventually.
-- Nothing in this repo schedules jobs, so no retention policy is installed here.
-- token_usage_events_ts_idx makes the delete cheap when someone runs it:
--
--   DELETE FROM token_usage_events WHERE ts < NOW() - INTERVAL '90 days';
