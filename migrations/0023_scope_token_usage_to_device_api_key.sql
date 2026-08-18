-- Title: Scope Token Usage Events to Device Access Tokens
-- Description: Adds device-api-key RLS policies to token_usage_events so a device authenticated by its Access-Token can insert and read usage rows belonging to its owner, without a browser session.

-- =============================================================================
-- Device access-token policies
--
-- Ingestion arrives as a device Access-Token, not a session: the connection has
-- `app.device_api_key` set and `app.current_user_id` empty, so the 0022 tenant
-- policies can never match. These policies are additive — Postgres ORs them
-- with the existing ones — so the session-scoped dashboard reads are unchanged.
--
-- Rows stay bound to the device owner rather than being admitted with a NULL
-- user_id: 0022's select policy treats `user_id IS NULL` as shared data, so an
-- untenanted usage row would be readable by every tenant.
--
-- The devices lookup resolves under the same setting via
-- devices_api_key_select_policy (0019, rewritten in 0021). Session lookups are
-- wrapped as (select current_setting(...)) so Postgres evaluates them once per
-- statement as an InitPlan, matching the form used by every policy since 0021.
-- =============================================================================

DROP POLICY IF EXISTS token_usage_events_api_key_select_policy ON token_usage_events;
CREATE POLICY token_usage_events_api_key_select_policy ON token_usage_events
    FOR SELECT
    USING (
        (select current_setting('app.device_api_key', true)) <> ''
        AND EXISTS (
            SELECT 1
            FROM devices d
            WHERE d.api_key = (select current_setting('app.device_api_key', true))
                AND d.user_id = token_usage_events.user_id
        )
    );

DROP POLICY IF EXISTS token_usage_events_api_key_insert_policy ON token_usage_events;
CREATE POLICY token_usage_events_api_key_insert_policy ON token_usage_events
    FOR INSERT
    WITH CHECK (
        (select current_setting('app.device_api_key', true)) <> ''
        AND EXISTS (
            SELECT 1
            FROM devices d
            WHERE d.api_key = (select current_setting('app.device_api_key', true))
                AND d.user_id = token_usage_events.user_id
        )
    );

-- Deliberately no UPDATE or DELETE policy: a device only ever appends usage.
-- Editing and pruning stay on the session-scoped path from 0022.
