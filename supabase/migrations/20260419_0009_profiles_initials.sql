-- =============================================================================
-- Migration: 20260419_0009_profiles_initials
-- Tool:      PPGantt
-- Project:   wzzjozdljxhmrmscevlh
--
-- Purpose
-- -------
-- Adds `initials` (text) to `public.profiles` so the snapshot sidebar can
-- render a 2-3 character owner badge on each snapshot card (e.g. "PP" for
-- Peter Propper, "LB" for Lourenço B., "LR" for Lea R.). Pure display
-- concern — `created_by` UUID is still the source of truth for audit.
--
-- Constraint: 1-5 characters, ASCII letters only (uppercase). Short so it
-- fits a 22×22 badge; upper-case so all initials look consistent; letters
-- only to avoid Unicode badge-layout surprises.
--
-- Nullable on purpose — new sign-ups have no initials until someone (Peter
-- or the user themself) sets one. The frontend falls back to the first
-- letter of email when initials is NULL.
--
-- Idempotency
-- -----------
-- Uses IF NOT EXISTS for the column add. CHECK is named so it can be
-- dropped by a future migration. INSERT below uses ON CONFLICT DO UPDATE
-- so re-running safely refreshes Peter's initials.
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS initials text;

-- Drop the constraint first in case we're re-running — can't use IF NOT
-- EXISTS on ADD CONSTRAINT in older Postgres.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_initials_format_chk;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_initials_format_chk
  CHECK (initials IS NULL OR (initials ~ '^[A-Z]{1,5}$'));

COMMENT ON COLUMN public.profiles.initials IS
  'Short uppercase badge for UI display (1-5 A-Z chars). NULL = frontend '
  'falls back to first letter of email. Set by the user or by a project '
  'owner during onboarding. See INVITE_USER.md for the seed SQL.';

-- No tenant seeds in this migration — initials are user-specific and
-- live in deployment-local docs (PRIVATE_INFRA.md for the maintainer's
-- personal seed; INVITE_USER.md for new-member SQL).

-- End of 20260419_0009_profiles_initials.sql
