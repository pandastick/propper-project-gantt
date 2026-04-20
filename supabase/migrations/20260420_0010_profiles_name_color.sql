-- =============================================================================
-- Migration: 20260420_0010_profiles_name_color
-- Tool:      PPGantt
-- Project:   wzzjozdljxhmrmscevlh
--
-- Purpose
-- -------
-- Adds structured name + color to public.profiles so the snapshot sidebar
-- can render a proper owner badge (initials on a per-user-coloured chip).
--
-- New columns:
--   first_name  text  — user's given name (nullable until onboarded)
--   last_name   text  — user's family name (nullable)
--   color       text  — one of a fixed 8-colour palette for badge display
--
-- The existing `initials` column (from 0009) stays as an optional override:
--   - If `initials` is set, use it verbatim.
--   - Else if both `first_name` and `last_name` are set, derive
--     UPPER(LEFT(first_name,1) || LEFT(last_name,1)).
--   - Else fall back to email first char (frontend concern).
--
-- Colour palette (constrained via CHECK so invalid hex can't sneak in):
--   #3B82F6 blue      #16A34A green    #EC4899 pink
--   #A855F7 purple    #EAB308 amber    #06B6D4 cyan
--   #F97316 orange    #64748B slate (default/unassigned)
--
-- Idempotency
-- -----------
-- ADD COLUMN IF NOT EXISTS for both text columns. CHECK constraint is named
-- and dropped first so re-running the migration doesn't fail. Seed uses
-- ON CONFLICT DO UPDATE.
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS first_name text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_name text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS color text;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_color_palette_chk;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_color_palette_chk
  CHECK (color IS NULL OR color IN (
    '#3B82F6', '#16A34A', '#EC4899',
    '#A855F7', '#EAB308', '#06B6D4',
    '#F97316', '#64748B'
  ));

COMMENT ON COLUMN public.profiles.first_name IS
  'User given name. Source for derived initials when `initials` override is NULL.';

COMMENT ON COLUMN public.profiles.last_name IS
  'User family name. Source for derived initials when `initials` override is NULL.';

COMMENT ON COLUMN public.profiles.color IS
  'Owner badge background color. Constrained to an 8-color palette so badges '
  'stay legible on the dark UI. NULL = frontend falls back to slate. See '
  'INVITE_USER.md for the seed SQL.';

-- No tenant seeds in this migration — names/colors are user-specific
-- and live in deployment-local docs (PRIVATE_INFRA.md for the
-- maintainer's personal seed; INVITE_USER.md for new-member SQL).

-- End of 20260420_0010_profiles_name_color.sql
