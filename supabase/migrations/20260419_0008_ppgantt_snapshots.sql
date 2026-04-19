-- =============================================================================
-- Migration: 20260419_0008_ppgantt_snapshots
-- Tool:      PPGantt
-- Project:   wzzjozdljxhmrmscevlh
--
-- Purpose
-- -------
-- Adds `ppgantt.snapshots` — a point-in-time copy of a project's full task
-- list.  Three kinds of snapshots coexist in this table, distinguished by
-- the `kind` column:
--
--   'import'    Created automatically by Pull from Notion.  A frozen copy
--               of every task as it was in Notion at the time of the pull.
--               Read-only from the app's POV.  Every pull produces exactly
--               one `import` snapshot, linked to its sync_events row.
--
--   'snapshot'  Created manually by the user via the sidebar "Save
--               snapshot" button.  A frozen copy of the current live
--               ppgantt.tasks state, including any in-progress edits.
--               The user chooses when to take one.
--
--   'pushed'    A snapshot (formerly kind='snapshot' or 'import') that has
--               been pushed to Notion.  The push-to-notion function flips
--               `kind` from 'snapshot' → 'pushed' (or 'import' → 'pushed'
--               if the user pushes a just-pulled import back up) and stamps
--               `pushed_at` + `pushed_sync_event_id`.  The UI renders
--               pushed cards distinctly so the user can see which version
--               is now the source of truth in Notion.
--
-- The `payload` column holds the full task list as jsonb.  One jsonb blob
-- per snapshot is cheaper and simpler than a parallel `snapshot_tasks`
-- mirror table, and Postgres TOAST handles the sizing — a 66-task roadmap
-- is ~40KB, well within the 1GB jsonb cap.
--
-- Relationships
--   - project_id    FKs public.projects(id)         ON DELETE CASCADE
--     Deleting the project removes its snapshots.
--   - source_sync_event_id  FKs ppgantt.sync_events(id) ON DELETE SET NULL
--     Lets us say "this snapshot was produced by THAT pull".  If the
--     sync_events row is ever pruned, keep the snapshot but null the
--     pointer.
--   - pushed_sync_event_id  FKs ppgantt.sync_events(id) ON DELETE SET NULL
--     Set when kind='pushed'.  Points at the push's sync_events row.
--   - created_by    FKs auth.users(id)              NO ACTION
--     Audit: who took this snapshot.  Deleting a user is blocked while
--     any of their snapshots exist (same contract as ppgantt.tasks).
--
-- Idempotency
--   Every object uses IF NOT EXISTS / IF EXISTS.  Safe to re-run.
--
-- RLS
--   Enabled in this same file (unlike 0003 which deferred to 0004).  The
--   snapshots table is small-surface and the four policies follow the same
--   helpers-via-SECURITY-DEFINER pattern as 0007.  Delete is editor (not
--   owner): users should be able to clean up their own snapshots without
--   escalating to the project owner, and deleting a snapshot never
--   mutates live task data.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- ppgantt.snapshots
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ppgantt.snapshots (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,

  -- Classification
  kind                   text NOT NULL CHECK (kind IN ('import','snapshot','pushed')),
  label                  text,           -- short user-facing title (e.g. "before Q2 replan")
  notes                  text,           -- optional longer description

  -- The frozen data
  payload                jsonb NOT NULL,

  -- Sync event linkage
  source_sync_event_id   uuid REFERENCES ppgantt.sync_events(id) ON DELETE SET NULL,
  pushed_at              timestamptz,
  pushed_sync_event_id   uuid REFERENCES ppgantt.sync_events(id) ON DELETE SET NULL,

  -- Audit
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES auth.users(id),

  -- Invariant: if a snapshot is 'pushed' it must have a pushed_at timestamp.
  CONSTRAINT snapshots_pushed_has_timestamp
    CHECK ((kind = 'pushed') = (pushed_at IS NOT NULL))
);

COMMENT ON TABLE ppgantt.snapshots IS
  'Point-in-time copies of a project''s full task list. kind distinguishes '
  'imports (from Pull), manual snapshots (user-saved), and pushed (sent back '
  'to Notion). One jsonb payload per snapshot.';

COMMENT ON COLUMN ppgantt.snapshots.kind IS
  'import | snapshot | pushed — controls card styling in the sidebar UI.';

COMMENT ON COLUMN ppgantt.snapshots.payload IS
  'Full task list as jsonb at the moment the snapshot was taken. For '
  'imports this is the Notion response; for manual snapshots this is the '
  'live ppgantt.tasks state; for pushed it remains the payload that was '
  'actually written to Notion.';

-- Indexes: most queries filter by project, ordered by creation time.
-- The (project_id, created_at DESC) composite backs the sidebar feed.
CREATE INDEX IF NOT EXISTS ppgantt_snapshots_project_idx
  ON ppgantt.snapshots (project_id, created_at DESC);

-- Kind filter index — used when the UI asks "show me only pushed
-- snapshots" or "show me the most recent import".
CREATE INDEX IF NOT EXISTS ppgantt_snapshots_kind_idx
  ON ppgantt.snapshots (project_id, kind, created_at DESC);


-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE ppgantt.snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ppgantt_snapshots_read_member   ON ppgantt.snapshots;
DROP POLICY IF EXISTS ppgantt_snapshots_insert_editor ON ppgantt.snapshots;
DROP POLICY IF EXISTS ppgantt_snapshots_update_editor ON ppgantt.snapshots;
DROP POLICY IF EXISTS ppgantt_snapshots_delete_editor ON ppgantt.snapshots;

CREATE POLICY ppgantt_snapshots_read_member
  ON ppgantt.snapshots FOR SELECT
  USING (public.is_project_member(project_id));

CREATE POLICY ppgantt_snapshots_insert_editor
  ON ppgantt.snapshots FOR INSERT
  WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY ppgantt_snapshots_update_editor
  ON ppgantt.snapshots FOR UPDATE
  USING (public.is_project_editor(project_id))
  WITH CHECK (public.is_project_editor(project_id));

CREATE POLICY ppgantt_snapshots_delete_editor
  ON ppgantt.snapshots FOR DELETE
  USING (public.is_project_editor(project_id));


-- End of 20260419_0008_ppgantt_snapshots.sql
