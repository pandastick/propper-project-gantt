-- =============================================================================
-- Migration: 20260418_0001_shared_public_schema
-- Tool:      PPGantt  (shared-layer migration — identical to PPControl's 0001)
-- Project:   wzzjozdljxhmrmscevlh  (shared Supabase project)
--
-- Purpose
-- -------
-- Creates the shared `public.*` tables that all PP-tools (PPGantt, PPControl,
-- and future PPProjectMapper) read and write.  These tables are owned by
-- neither tool alone — whichever tool's 0001 migration runs first applies
-- the CREATEs; the other tool's run is a no-op thanks to `IF NOT EXISTS`.
--
-- Tables created (all in `public.*`):
--   * profiles          — per-auth.user profile + preferences jsonb
--   * projects          — cross-tool project registry (slug, name, color, ...)
--   * project_members   — membership + role (owner/editor/viewer)
--   * preferences_kv    — per-user cloud-synced key/value prefs
--
-- Idempotency
-- -----------
-- Every object uses `IF NOT EXISTS`.  Safe to run on an empty DB, and safe
-- to run on a DB where PPControl's equivalent migration has already been
-- applied.  No DROP, no ALTER, no TRUNCATE, no data inserts.
--
-- Companion contract
-- ------------------
-- This file MUST stay character-for-character identical (on column types,
-- defaults, FK cascades, and check constraints) to PPControl's equivalent
-- `20260418_0001_shared_public_schema.sql`.  If either tool needs a change
-- to a shared table, both repos' 0001 files update together.  RLS policies
-- for these tables live in the 0002 migration, not here.
--
-- Out of scope for this file
-- --------------------------
--   * RLS policies               → 20260418_0002_public_rls_policies.sql
--   * ppgantt.* schema + tables  → 20260418_0003_ppgantt_schema.sql
--   * ppgantt.* RLS              → 20260418_0004_ppgantt_rls.sql
--   * Seed data                  → 20260418_0005_ppgantt_seed_societist.sql
--   * auth.* objects             → managed by Supabase
-- =============================================================================

-- Required for `gen_random_uuid()` used as a default on several PKs.
-- Supabase typically has pgcrypto enabled already; the `IF NOT EXISTS`
-- keeps this idempotent on both fresh and existing databases.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- -----------------------------------------------------------------------------
-- public.profiles
--   Per-user profile data keyed by auth.users.id.  Stores the user's display
--   name, optional avatar emoji, and a cloud-synced `preferences` jsonb blob.
--   Deleting the auth user cascades the profile row away.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  text,
  avatar_emoji  text,
  preferences   jsonb DEFAULT '{}'::jsonb,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- public.projects
--   The cross-tool project registry.  PPGantt roadmaps, PPControl kanbans,
--   and any future PP-tool all reference these rows.  `slug` is the stable
--   human identifier (e.g. 'societist', 'cpu', 'rvms').  `column_schema` is
--   PPControl's kanban column config (PPGantt leaves it as the default `[]`).
--   `ppgantt_project_id` is a PPControl-v3 self-link placeholder; PPGantt
--   itself does not use it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.projects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text UNIQUE NOT NULL,
  name                text NOT NULL,
  color               text NOT NULL,
  icon                text,
  ppgantt_project_id  uuid,
  column_schema       jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_touched_at     timestamptz DEFAULT now(),
  created_at          timestamptz DEFAULT now(),
  -- created_by is nullable + SET NULL on auth.users delete.  Deleting a user
  -- who created projects must not hard-block their account cleanup, and the
  -- projects themselves should survive (a project outlives any one person's
  -- membership).  RLS on public.projects derives access from project_members,
  -- not from created_by, so a null creator does not break authorization.
  created_by          uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
);


-- -----------------------------------------------------------------------------
-- public.project_members
--   Membership + role for the (user, project) pair.  Role is one of
--   'owner', 'editor', 'viewer' (enforced via CHECK).  Composite PK
--   prevents duplicate memberships.  Deleting either the project or the
--   auth user removes the membership row.  RLS policies across all tools
--   derive access from this table.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_members (
  project_id   uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  invited_at   timestamptz DEFAULT now(),
  accepted_at  timestamptz,
  PRIMARY KEY (project_id, user_id)
);


-- -----------------------------------------------------------------------------
-- public.preferences_kv
--   Cloud-synced per-user key/value store.  Any PP-tool can persist UI
--   prefs here (e.g. PPControl's `filter:project:<slug>:collaborator`,
--   PPGantt's default zoom level).  Composite PK on (user_id, key) allows
--   a user to have many keys but each key appears exactly once.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.preferences_kv (
  user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- End of 20260418_0001_shared_public_schema.sql
