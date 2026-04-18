-- =============================================================================
-- Migration: 20260418_0004_ppgantt_rls
-- Tool:      PPGantt
-- Project:   wzzjozdljxhmrmscevlh  (shared Supabase project)
--
-- Purpose
-- -------
-- Enables Row Level Security on the six `ppgantt.*` tables created in 0003,
-- and defines the membership-based policies that gate every read/write.  The
-- model (per PPGantt proposal §2.3) is simple:
--
--   * Any member of a project (`public.project_members.user_id = auth.uid()`)
--     can SELECT rows scoped to that project.
--   * `owner` or `editor` members can INSERT and UPDATE rows.
--   * Only `owner` members can DELETE rows (except on `task_dependencies`,
--     where DELETE is editor-or-better — dependencies are lightweight graph
--     edges, not worth gating to owner-only; users should DELETE + INSERT to
--     change an edge rather than UPDATE it).
--
-- Policy-name prefix convention
-- -----------------------------
-- Every policy in this file is prefixed `ppgantt_` to avoid collision with
-- PPControl's `ppcontrol_` policies on the shared `public.*` tables.  See
-- PPControl spec §9 and PPGantt proposal §2.3.
--
-- Idempotency
-- -----------
-- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` is a no-op on a table that
-- already has RLS enabled, so the top block is safe to re-run.  Postgres
-- does NOT support `CREATE POLICY IF NOT EXISTS`, so each CREATE POLICY is
-- wrapped in a DO block that swallows `duplicate_object` errors — the same
-- idempotency pattern used in 0002.  Safe to re-run on a fresh DB and safe
-- to re-run after partial application.  No DROP POLICY, no DISABLE RLS, no
-- data inserts.
--
-- task_dependencies has no project_id
-- -----------------------------------
-- `ppgantt.task_dependencies` (a symmetric self-relation over ppgantt.tasks)
-- has no `project_id` column.  Its policies derive project scope by joining
-- through `ppgantt.tasks` on `blocked_task_id` — either anchor would work
-- since both endpoints of a dependency must belong to the same project for
-- the edge to be meaningful, but picking one anchor keeps the policy
-- subqueries single-row-lookup fast.
--
-- Out of scope for this file
-- --------------------------
--   * `public.*` tables                → 20260418_0001_shared_public_schema.sql
--   * `public.*` RLS policies          → 20260418_0002_public_rls_policies.sql
--   * `ppgantt.*` DDL                  → 20260418_0003_ppgantt_schema.sql
--   * Societist seed data              → 20260418_0005_ppgantt_seed_societist.sql
--   * `auth.*` objects                 → managed by Supabase
--   * PPControl's `ppcontrol.*` RLS    → PPControl's own migration set
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Enable RLS on all six ppgantt.* tables
--    Idempotent — re-enabling on an already-enabled table is a no-op.
-- -----------------------------------------------------------------------------
ALTER TABLE ppgantt.phases                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ppgantt.streams                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ppgantt.tasks                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ppgantt.task_dependencies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ppgantt.sync_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE ppgantt.notion_schema_mappings   ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- 2. ppgantt.phases policies
--    Per-project phase palette.  Standard membership gate: members read,
--    editors/owners write, owners delete.
-- =============================================================================

-- SELECT: any project member
DO $$ BEGIN
  CREATE POLICY ppgantt_phases_read_member
    ON ppgantt.phases FOR SELECT
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.phases.project_id
        AND pm.user_id = auth.uid()
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- INSERT: owner or editor
DO $$ BEGIN
  CREATE POLICY ppgantt_phases_insert_editor
    ON ppgantt.phases FOR INSERT
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.phases.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- UPDATE: owner or editor (both USING and WITH CHECK so the row can't be
-- re-parented to a project the caller doesn't also have editor rights on)
DO $$ BEGIN
  CREATE POLICY ppgantt_phases_update_editor
    ON ppgantt.phases FOR UPDATE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.phases.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.phases.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- DELETE: owner only
DO $$ BEGIN
  CREATE POLICY ppgantt_phases_delete_owner
    ON ppgantt.phases FOR DELETE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.phases.project_id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =============================================================================
-- 3. ppgantt.streams policies
--    Per-project swim lanes.  Same membership gate as phases.
-- =============================================================================

-- SELECT: any project member
DO $$ BEGIN
  CREATE POLICY ppgantt_streams_read_member
    ON ppgantt.streams FOR SELECT
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.streams.project_id
        AND pm.user_id = auth.uid()
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- INSERT: owner or editor
DO $$ BEGIN
  CREATE POLICY ppgantt_streams_insert_editor
    ON ppgantt.streams FOR INSERT
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.streams.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- UPDATE: owner or editor
DO $$ BEGIN
  CREATE POLICY ppgantt_streams_update_editor
    ON ppgantt.streams FOR UPDATE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.streams.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.streams.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- DELETE: owner only
DO $$ BEGIN
  CREATE POLICY ppgantt_streams_delete_owner
    ON ppgantt.streams FOR DELETE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.streams.project_id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =============================================================================
-- 4. ppgantt.tasks policies
--    The main roadmap row.  Same membership gate; read is the hot path for
--    the Gantt viewer.
-- =============================================================================

-- SELECT: any project member
DO $$ BEGIN
  CREATE POLICY ppgantt_tasks_read_member
    ON ppgantt.tasks FOR SELECT
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.tasks.project_id
        AND pm.user_id = auth.uid()
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- INSERT: owner or editor
DO $$ BEGIN
  CREATE POLICY ppgantt_tasks_insert_editor
    ON ppgantt.tasks FOR INSERT
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.tasks.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- UPDATE: owner or editor
DO $$ BEGIN
  CREATE POLICY ppgantt_tasks_update_editor
    ON ppgantt.tasks FOR UPDATE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.tasks.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.tasks.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- DELETE: owner only
DO $$ BEGIN
  CREATE POLICY ppgantt_tasks_delete_owner
    ON ppgantt.tasks FOR DELETE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.tasks.project_id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =============================================================================
-- 5. ppgantt.task_dependencies policies  (SPECIAL — no project_id column)
--    The dependency graph has no `project_id` column of its own.  Every
--    policy below derives project scope by joining ppgantt.tasks on
--    `blocked_task_id`.  Either endpoint (blocked or blocker) would work
--    since both tasks must belong to the same project for the edge to be
--    meaningful, but anchoring on `blocked_task_id` keeps the subquery to
--    a single-row lookup.  No UPDATE policy is defined — the table has no
--    mutable columns beyond the composite PK, so users should DELETE +
--    INSERT to change an edge.  DELETE is editor-or-better (not owner-only)
--    because dependency edges are lightweight graph metadata, not a
--    destructive operation on roadmap content.
-- =============================================================================

-- SELECT: any member of the owning project (via JOIN through ppgantt.tasks)
DO $$ BEGIN
  CREATE POLICY ppgantt_task_dependencies_read_member
    ON ppgantt.task_dependencies FOR SELECT
    USING (EXISTS (
      SELECT 1 FROM ppgantt.tasks t
      JOIN public.project_members pm ON pm.project_id = t.project_id
      WHERE t.id = ppgantt.task_dependencies.blocked_task_id
        AND pm.user_id = auth.uid()
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- INSERT: owner or editor of the owning project (via JOIN through ppgantt.tasks)
DO $$ BEGIN
  CREATE POLICY ppgantt_task_dependencies_insert_editor
    ON ppgantt.task_dependencies FOR INSERT
    WITH CHECK (EXISTS (
      SELECT 1 FROM ppgantt.tasks t
      JOIN public.project_members pm ON pm.project_id = t.project_id
      WHERE t.id = ppgantt.task_dependencies.blocked_task_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- DELETE: owner or editor of the owning project (via JOIN through ppgantt.tasks).
-- Intentionally editor-or-better, not owner-only: edges are metadata, and
-- changing a dependency is a DELETE + INSERT pair.
DO $$ BEGIN
  CREATE POLICY ppgantt_task_dependencies_delete_editor
    ON ppgantt.task_dependencies FOR DELETE
    USING (EXISTS (
      SELECT 1 FROM ppgantt.tasks t
      JOIN public.project_members pm ON pm.project_id = t.project_id
      WHERE t.id = ppgantt.task_dependencies.blocked_task_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =============================================================================
-- 6. ppgantt.sync_events policies
--    Append-only log of Notion pull/push runs.  Standard membership gate.
--    In practice INSERT is the hot path (every sync button press writes a
--    row) and DELETE is rare (sync history is kept for audit).
-- =============================================================================

-- SELECT: any project member
DO $$ BEGIN
  CREATE POLICY ppgantt_sync_events_read_member
    ON ppgantt.sync_events FOR SELECT
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.sync_events.project_id
        AND pm.user_id = auth.uid()
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- INSERT: owner or editor
DO $$ BEGIN
  CREATE POLICY ppgantt_sync_events_insert_editor
    ON ppgantt.sync_events FOR INSERT
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.sync_events.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- UPDATE: owner or editor
DO $$ BEGIN
  CREATE POLICY ppgantt_sync_events_update_editor
    ON ppgantt.sync_events FOR UPDATE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.sync_events.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.sync_events.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- DELETE: owner only
DO $$ BEGIN
  CREATE POLICY ppgantt_sync_events_delete_owner
    ON ppgantt.sync_events FOR DELETE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.sync_events.project_id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =============================================================================
-- 7. ppgantt.notion_schema_mappings policies
--    Per-project canonical-field -> Notion-property mapping (one row per
--    project).  Standard membership gate.  UPDATE is the hot path (the
--    mapping is upserted whenever schema_mapper runs); INSERT only on the
--    first sync of a new project; DELETE only if a project is retired.
-- =============================================================================

-- SELECT: any project member
DO $$ BEGIN
  CREATE POLICY ppgantt_notion_schema_mappings_read_member
    ON ppgantt.notion_schema_mappings FOR SELECT
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.notion_schema_mappings.project_id
        AND pm.user_id = auth.uid()
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- INSERT: owner or editor
DO $$ BEGIN
  CREATE POLICY ppgantt_notion_schema_mappings_insert_editor
    ON ppgantt.notion_schema_mappings FOR INSERT
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.notion_schema_mappings.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- UPDATE: owner or editor
DO $$ BEGIN
  CREATE POLICY ppgantt_notion_schema_mappings_update_editor
    ON ppgantt.notion_schema_mappings FOR UPDATE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.notion_schema_mappings.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.notion_schema_mappings.project_id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner','editor')
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- DELETE: owner only
DO $$ BEGIN
  CREATE POLICY ppgantt_notion_schema_mappings_delete_owner
    ON ppgantt.notion_schema_mappings FOR DELETE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = ppgantt.notion_schema_mappings.project_id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- End of 20260418_0004_ppgantt_rls.sql
