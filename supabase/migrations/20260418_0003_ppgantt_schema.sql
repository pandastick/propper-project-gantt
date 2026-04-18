-- =============================================================================
-- Migration: 20260418_0003_ppgantt_schema
-- Tool:      PPGantt
-- Project:   wzzjozdljxhmrmscevlh  (shared Supabase project)
--
-- Purpose
-- -------
-- Creates the `ppgantt.*` schema and all PPGantt-only tables.  This is the
-- tool's private data layer: phases, streams, tasks, task dependencies, sync
-- event log, and per-project Notion schema mappings.  Unlike the shared
-- `public.*` layer (migration 0001), nothing outside PPGantt reads or writes
-- these tables.  PPControl is a sibling tool and never touches `ppgantt.*`.
--
-- Idempotency
-- -----------
-- Every object in this file uses `IF NOT EXISTS`.  Safe to run on a fresh DB,
-- and safe to re-run after partial application.  No DROP, no ALTER, no data
-- inserts.
--
-- RLS
-- ---
-- RLS is NOT enabled in this migration.  Enabling RLS and defining the
-- `ppgantt_*` policies lives in migration 0004 (`20260418_0004_ppgantt_rls.sql`).
-- Until 0004 runs, these tables are unreadable to the `anon`/`authenticated`
-- roles on Supabase — which is intentional: we'd rather fail closed than
-- accidentally expose rows during the window between 0003 and 0004.
--
-- Relationship to `public.*`
-- --------------------------
-- Every PPGantt table that needs project scoping FKs into `public.projects(id)`
-- with `ON DELETE CASCADE` so removing a project cleans up its roadmap.
-- Audit columns (`created_by`, `updated_by`, `actor_id`) FK into `auth.users(id)`
-- without a cascade clause, i.e. Postgres default NO ACTION: deleting an
-- auth user is BLOCKED as long as any dependent audit row still references
-- them.  If we later want historical rows preserved when users leave, switch
-- those FKs to `ON DELETE SET NULL` and make the column nullable.
--
-- Out of scope for this file
-- --------------------------
--   * `public.*` tables                 → 20260418_0001_shared_public_schema.sql
--   * `public.*` RLS policies           → 20260418_0002_public_rls_policies.sql
--   * `ppgantt.*` RLS + policies        → 20260418_0004_ppgantt_rls.sql
--   * Societist seed data               → 20260418_0005_ppgantt_seed_societist.sql
--   * `auth.*` objects                  → managed by Supabase
--   * PPControl's `ppcontrol.*` schema  → PPControl's own migration set
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Schema
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS ppgantt;

COMMENT ON SCHEMA ppgantt IS
  'PPGantt-only tables (phases, streams, tasks, dependencies, sync events, '
  'Notion schema mappings). Sibling of ppcontrol.* — PPControl never reads or '
  'writes here. RLS policies live in migration 0004.';


-- -----------------------------------------------------------------------------
-- ppgantt.phases
--   The phase palette for a single project.  Replaces the hardcoded
--   `phase_palette` block that used to live in `data/roadmap.json`.  Each
--   project owns its own phase list (e.g. Societist uses "Phase 0.5 -
--   Security", CPU will use a different breakdown).  `sort_order` controls
--   display order in the UI legend; `(project_id, name)` is unique so a
--   phase name can be reused across projects but never duplicated within
--   one.  Deleting the parent project cascades all its phases away.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ppgantt.phases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       text NOT NULL,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (project_id, name)
);

COMMENT ON TABLE ppgantt.phases IS
  'Per-project phase palette. Replaces the hardcoded phase_palette in '
  'data/roadmap.json. (project_id, name) is unique; cascades on project delete.';


-- -----------------------------------------------------------------------------
-- ppgantt.streams
--   Swim lanes for the Gantt chart.  Societist currently uses "Stream A
--   (Lourenço)", "Stream B (Peter)", "Shared", etc.  Like phases, streams
--   are per-project so each roadmap can define its own workstreams without
--   colliding.  `sort_order` controls which lane renders at the top of the
--   chart.  Same cascade behavior and uniqueness constraint as phases.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ppgantt.streams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (project_id, name)
);

COMMENT ON TABLE ppgantt.streams IS
  'Per-project swim lanes (e.g. "Stream A (Lourenço)", "Shared"). '
  '(project_id, name) is unique; cascades on project delete.';


-- -----------------------------------------------------------------------------
-- ppgantt.tasks
--   The main roadmap row.  Every Gantt bar is a row here.  Columns are
--   grouped into five clusters:
--
--     1. Core Gantt fields   — name, dates, progress (0-100).
--     2. Categorization      — phase_id, stream_id, owner_label. owner_label
--                              is free text for v1 (matches current Notion
--                              export of "Peter"/"Lourenço"); may FK to
--                              public.profiles in v3.
--     3. Status              — status string, risk_level enum, is_milestone,
--                              critical_path, slack_days, duration_days, and
--                              a duration_text override (e.g. "4h", "0.5-1d").
--     4. Context             — free-form reference + notes fields.
--     5. Notion linkage      — notion_page_id (unique, NULL for
--                              Supabase-first rows), notion_url, last-pulled
--                              and last-pushed timestamps, and
--                              notion_sync_status ('clean' | 'local_ahead' |
--                              'notion_ahead' | 'conflict', nullable for
--                              rows that have never synced).
--     6. Audit               — created_at/by, updated_at/by.
--
--   FKs: project_id cascades; phase_id and stream_id do NOT cascade
--   (default NO ACTION) so deleting a phase/stream while tasks still
--   reference it fails loudly rather than silently dropping roadmap rows.
--   created_by / updated_by FK auth.users(id) without cascade.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ppgantt.tasks (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                   uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,

  -- Core Gantt fields
  name                         text NOT NULL,
  start_date                   date,
  end_date                     date,
  progress                     numeric(5,2) DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),

  -- Categorization
  phase_id                     uuid REFERENCES ppgantt.phases(id),
  stream_id                    uuid REFERENCES ppgantt.streams(id),
  owner_label                  text,

  -- Status
  status                       text,
  risk_level                   text CHECK (risk_level IN ('None','Low','Medium','High','Critical') OR risk_level IS NULL),
  is_milestone                 boolean DEFAULT false,
  critical_path                boolean DEFAULT false,
  slack_days                   numeric(6,2),
  duration_days                numeric(6,2),
  duration_text                text,

  -- Context
  reference                    text,
  notes                        text,

  -- Notion linkage (the bidirectional mirror)
  notion_page_id               text UNIQUE,
  notion_url                   text,
  last_pulled_from_notion_at   timestamptz,
  last_pushed_to_notion_at     timestamptz,
  notion_sync_status           text CHECK (notion_sync_status IN ('clean','local_ahead','notion_ahead','conflict') OR notion_sync_status IS NULL),

  -- Audit
  created_at                   timestamptz DEFAULT now(),
  created_by                   uuid REFERENCES auth.users(id),
  updated_at                   timestamptz DEFAULT now(),
  updated_by                   uuid REFERENCES auth.users(id)
);

COMMENT ON TABLE ppgantt.tasks IS
  'Roadmap tasks (one row per Gantt bar). Core fields, phase/stream FKs, '
  'status/risk, Notion sync linkage, and audit columns. notion_page_id is '
  'UNIQUE and NULL for Supabase-first rows; notion_sync_status is NULL until '
  'the first sync.';

-- Indexes per §2.2.  project_id gets its own index because nearly every
-- query filters on it; phase/stream indexes back the grouping dropdowns;
-- the (start_date, end_date) composite backs the Gantt viewport query.
CREATE INDEX IF NOT EXISTS ppgantt_tasks_project_idx ON ppgantt.tasks (project_id);
CREATE INDEX IF NOT EXISTS ppgantt_tasks_phase_idx   ON ppgantt.tasks (phase_id);
CREATE INDEX IF NOT EXISTS ppgantt_tasks_stream_idx  ON ppgantt.tasks (stream_id);
CREATE INDEX IF NOT EXISTS ppgantt_tasks_dates_idx   ON ppgantt.tasks (start_date, end_date);


-- -----------------------------------------------------------------------------
-- ppgantt.task_dependencies
--   Symmetric self-relation over ppgantt.tasks.  A task can block many tasks
--   ("blocks") and be blocked by many ("blocked_by"); the graph is stored
--   here as a join table.  The composite PK (blocked_task_id, blocker_task_id)
--   prevents duplicate edges.  The CHECK constraint prevents self-loops
--   (a task cannot block itself).  Deleting either side of the relation
--   cascades the edge away.
--
--   Note: this table has no project_id column.  RLS in migration 0004
--   derives access by joining through ppgantt.tasks → public.project_members.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ppgantt.task_dependencies (
  blocked_task_id  uuid NOT NULL REFERENCES ppgantt.tasks(id) ON DELETE CASCADE,
  blocker_task_id  uuid NOT NULL REFERENCES ppgantt.tasks(id) ON DELETE CASCADE,
  created_at       timestamptz DEFAULT now(),
  PRIMARY KEY (blocked_task_id, blocker_task_id),
  CHECK (blocked_task_id <> blocker_task_id)
);

COMMENT ON TABLE ppgantt.task_dependencies IS
  'Symmetric self-relation over ppgantt.tasks. PK (blocked_task_id, '
  'blocker_task_id) prevents duplicate edges; CHECK prevents self-loops. '
  'No project_id column — RLS derives access via JOIN through ppgantt.tasks.';


-- -----------------------------------------------------------------------------
-- ppgantt.sync_events
--   Append-only log of Notion sync runs.  Every "Pull from Notion" or
--   "Push to Notion" button press writes exactly one row.  `direction`
--   distinguishes the two, `status` records success/partial/failed,
--   `rows_read`/`rows_written`/`rows_failed` give a per-run tally, and
--   `error_detail` (jsonb) captures any per-row errors for the conflict UI.
--   `started_at` / `finished_at` bound the run; `created_at` is when the
--   row landed (usually == finished_at).  `actor_id` FKs the user who
--   pushed the button (nullable for future server-initiated syncs).
--
--   The composite index (project_id, created_at DESC) backs the per-project
--   "recent sync history" feed.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ppgantt.sync_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  actor_id      uuid REFERENCES auth.users(id),
  direction     text NOT NULL CHECK (direction IN ('pull_from_notion','push_to_notion')),
  status        text NOT NULL CHECK (status IN ('success','partial','failed')),
  rows_read     int,
  rows_written  int,
  rows_failed   int,
  error_detail  jsonb,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL,
  created_at    timestamptz DEFAULT now()
);

COMMENT ON TABLE ppgantt.sync_events IS
  'Append-only log of Notion sync runs. One row per button press. Indexed on '
  '(project_id, created_at DESC) for the recent-history feed.';

CREATE INDEX IF NOT EXISTS ppgantt_sync_events_project_idx
  ON ppgantt.sync_events (project_id, created_at DESC);


-- -----------------------------------------------------------------------------
-- ppgantt.notion_schema_mappings
--   Replaces the `data/_schema_cache/<database-id>.json` files.  Stores the
--   per-project mapping from PPGantt's canonical field keys (name_field,
--   start_field, end_field, etc.) to the actual Notion property names that
--   sync.py's LLM-assisted schema_mapper discovered on first sync.
--   `phase_palette` caches the Notion "Phase" select options plus colors
--   so the push-to-Notion function can restore them without a second API
--   call.
--
--   project_id is itself the PRIMARY KEY — exactly one mapping per project.
--   If the mapping changes (e.g. user renames a Notion property), the row
--   is UPDATEd, not INSERTed again.  Cascades on project delete.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ppgantt.notion_schema_mappings (
  project_id     uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  notion_db_id   text NOT NULL,
  mapping        jsonb NOT NULL,
  phase_palette  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

COMMENT ON TABLE ppgantt.notion_schema_mappings IS
  'Per-project Notion schema mapping (replaces data/_schema_cache/*.json). '
  'project_id is the PK — exactly one mapping per project. mapping jsonb '
  'holds canonical_field → notion_property_name; phase_palette caches the '
  'Notion Phase select options + colors.';


-- End of 20260418_0003_ppgantt_schema.sql
