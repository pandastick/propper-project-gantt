-- =============================================================================
-- Migration: 20260418_0007_policies_via_helpers
-- Tool:      PPGantt (coordinate with PPControl)
-- Project:   wzzjozdljxhmrmscevlh
--
-- Purpose
-- -------
-- Follow-up to 0006 (RLS recursion fix).  Two improvements, per the
-- PPControl handoff received 2026-04-18:
--
--   1. Add a direct `user_id = auth.uid()` short-circuit to the
--      `project_members_read_member` policy, evaluated BEFORE the
--      is_project_member() helper.  Defense-in-depth: a user can always
--      read their own membership row even if the helper is ever broken
--      by a future refactor.  Zero real cost — the OR short-circuits as
--      soon as the cheap comparison succeeds.
--
--   2. Rewrite every `ppgantt_*` policy on every ppgantt.* table to call
--      the shared SECURITY DEFINER helpers (is_project_member /
--      is_project_editor / is_project_owner) instead of inlining a raw
--      `EXISTS (SELECT 1 FROM public.project_members pm ...)` subquery.
--      The old subqueries work because 0006 broke the recursion in
--      project_members's own policies, but they're slower (re-planned
--      per-row) and more brittle (depend on indirect policy ordering).
--      The helpers are STABLE + SECURITY DEFINER so Postgres can inline
--      them safely.
--
-- Scope
-- -----
--   - ONE `public.*` policy touched: project_members_read_member.
--   - 23 `ppgantt.*` policies rewritten: 4 each on phases, streams,
--     tasks, sync_events, notion_schema_mappings (20), plus 3 on
--     task_dependencies (which joins through ppgantt.tasks because it
--     has no project_id column of its own).
--
-- Idempotency
-- -----------
-- Every CREATE POLICY is preceded by DROP POLICY IF EXISTS.  Safe to
-- re-run.  No data changes, no schema changes, no helper changes.
--
-- Sanity precondition
-- -------------------
-- The three helpers (public.is_project_member, public.is_project_editor,
-- public.is_project_owner) must exist and be STABLE SECURITY DEFINER.
-- They're created by 0006; if this migration somehow runs before 0006,
-- the CREATE POLICY calls below will fail with "function does not exist"
-- — a safe, loud failure.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. public.project_members — short-circuit on user_id = auth.uid()
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS project_members_read_member ON public.project_members;

CREATE POLICY project_members_read_member
  ON public.project_members FOR SELECT
  USING (
    user_id = auth.uid()
    OR public.is_project_member(public.project_members.project_id)
  );


-- -----------------------------------------------------------------------------
-- 2. ppgantt.phases
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS ppgantt_phases_read_member   ON ppgantt.phases;
DROP POLICY IF EXISTS ppgantt_phases_insert_editor ON ppgantt.phases;
DROP POLICY IF EXISTS ppgantt_phases_update_editor ON ppgantt.phases;
DROP POLICY IF EXISTS ppgantt_phases_delete_owner  ON ppgantt.phases;

CREATE POLICY ppgantt_phases_read_member
  ON ppgantt.phases FOR SELECT
  USING (public.is_project_member(project_id));

CREATE POLICY ppgantt_phases_insert_editor
  ON ppgantt.phases FOR INSERT
  WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY ppgantt_phases_update_editor
  ON ppgantt.phases FOR UPDATE
  USING (public.is_project_editor(project_id))
  WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY ppgantt_phases_delete_owner
  ON ppgantt.phases FOR DELETE
  USING (public.is_project_owner(project_id));


-- -----------------------------------------------------------------------------
-- 3. ppgantt.streams
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS ppgantt_streams_read_member   ON ppgantt.streams;
DROP POLICY IF EXISTS ppgantt_streams_insert_editor ON ppgantt.streams;
DROP POLICY IF EXISTS ppgantt_streams_update_editor ON ppgantt.streams;
DROP POLICY IF EXISTS ppgantt_streams_delete_owner  ON ppgantt.streams;

CREATE POLICY ppgantt_streams_read_member
  ON ppgantt.streams FOR SELECT
  USING (public.is_project_member(project_id));

CREATE POLICY ppgantt_streams_insert_editor
  ON ppgantt.streams FOR INSERT
  WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY ppgantt_streams_update_editor
  ON ppgantt.streams FOR UPDATE
  USING (public.is_project_editor(project_id))
  WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY ppgantt_streams_delete_owner
  ON ppgantt.streams FOR DELETE
  USING (public.is_project_owner(project_id));


-- -----------------------------------------------------------------------------
-- 4. ppgantt.tasks
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS ppgantt_tasks_read_member   ON ppgantt.tasks;
DROP POLICY IF EXISTS ppgantt_tasks_insert_editor ON ppgantt.tasks;
DROP POLICY IF EXISTS ppgantt_tasks_update_editor ON ppgantt.tasks;
DROP POLICY IF EXISTS ppgantt_tasks_delete_owner  ON ppgantt.tasks;

CREATE POLICY ppgantt_tasks_read_member
  ON ppgantt.tasks FOR SELECT
  USING (public.is_project_member(project_id));

CREATE POLICY ppgantt_tasks_insert_editor
  ON ppgantt.tasks FOR INSERT
  WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY ppgantt_tasks_update_editor
  ON ppgantt.tasks FOR UPDATE
  USING (public.is_project_editor(project_id))
  WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY ppgantt_tasks_delete_owner
  ON ppgantt.tasks FOR DELETE
  USING (public.is_project_owner(project_id));


-- -----------------------------------------------------------------------------
-- 5. ppgantt.task_dependencies  (no project_id — joins through ppgantt.tasks)
-- -----------------------------------------------------------------------------
-- Anchored on `blocked_task_id` (either end works since both tasks must
-- live in the same project for the dependency to be meaningful).  The
-- JOIN still fetches one ppgantt.tasks row, but the membership check is
-- the fast helper call — no EXISTS on project_members.

DROP POLICY IF EXISTS ppgantt_task_dependencies_read_member   ON ppgantt.task_dependencies;
DROP POLICY IF EXISTS ppgantt_task_dependencies_insert_editor ON ppgantt.task_dependencies;
DROP POLICY IF EXISTS ppgantt_task_dependencies_delete_editor ON ppgantt.task_dependencies;

CREATE POLICY ppgantt_task_dependencies_read_member
  ON ppgantt.task_dependencies FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM ppgantt.tasks t
    WHERE t.id = ppgantt.task_dependencies.blocked_task_id
      AND public.is_project_member(t.project_id)
  ));

CREATE POLICY ppgantt_task_dependencies_insert_editor
  ON ppgantt.task_dependencies FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM ppgantt.tasks t
    WHERE t.id = ppgantt.task_dependencies.blocked_task_id
      AND public.is_project_editor(t.project_id)
  ));

CREATE POLICY ppgantt_task_dependencies_delete_editor
  ON ppgantt.task_dependencies FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM ppgantt.tasks t
    WHERE t.id = ppgantt.task_dependencies.blocked_task_id
      AND public.is_project_editor(t.project_id)
  ));


-- -----------------------------------------------------------------------------
-- 6. ppgantt.sync_events
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS ppgantt_sync_events_read_member   ON ppgantt.sync_events;
DROP POLICY IF EXISTS ppgantt_sync_events_insert_editor ON ppgantt.sync_events;
DROP POLICY IF EXISTS ppgantt_sync_events_update_editor ON ppgantt.sync_events;
DROP POLICY IF EXISTS ppgantt_sync_events_delete_owner  ON ppgantt.sync_events;

CREATE POLICY ppgantt_sync_events_read_member
  ON ppgantt.sync_events FOR SELECT
  USING (public.is_project_member(project_id));

CREATE POLICY ppgantt_sync_events_insert_editor
  ON ppgantt.sync_events FOR INSERT
  WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY ppgantt_sync_events_update_editor
  ON ppgantt.sync_events FOR UPDATE
  USING (public.is_project_editor(project_id))
  WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY ppgantt_sync_events_delete_owner
  ON ppgantt.sync_events FOR DELETE
  USING (public.is_project_owner(project_id));


-- -----------------------------------------------------------------------------
-- 7. ppgantt.notion_schema_mappings
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS ppgantt_notion_schema_mappings_read_member   ON ppgantt.notion_schema_mappings;
DROP POLICY IF EXISTS ppgantt_notion_schema_mappings_insert_editor ON ppgantt.notion_schema_mappings;
DROP POLICY IF EXISTS ppgantt_notion_schema_mappings_update_editor ON ppgantt.notion_schema_mappings;
DROP POLICY IF EXISTS ppgantt_notion_schema_mappings_delete_owner  ON ppgantt.notion_schema_mappings;

CREATE POLICY ppgantt_notion_schema_mappings_read_member
  ON ppgantt.notion_schema_mappings FOR SELECT
  USING (public.is_project_member(project_id));

CREATE POLICY ppgantt_notion_schema_mappings_insert_editor
  ON ppgantt.notion_schema_mappings FOR INSERT
  WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY ppgantt_notion_schema_mappings_update_editor
  ON ppgantt.notion_schema_mappings FOR UPDATE
  USING (public.is_project_editor(project_id))
  WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY ppgantt_notion_schema_mappings_delete_owner
  ON ppgantt.notion_schema_mappings FOR DELETE
  USING (public.is_project_owner(project_id));


-- End of 20260418_0007_policies_via_helpers.sql
