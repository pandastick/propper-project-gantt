-- =============================================================================
-- Migration: 20260418_0006_fix_rls_recursion
-- Tool:      PPGantt (coordinate with PPControl — shared public.* policies)
-- Project:   wzzjozdljxhmrmscevlh
--
-- Purpose
-- -------
-- Fix the infinite-recursion bug on `public.project_members` RLS policies
-- discovered during live smoke testing on Postgres 17.  The original policies
-- in migration 0002 contained self-referential EXISTS subqueries like:
--
--   USING (EXISTS (
--     SELECT 1 FROM public.project_members pm
--     WHERE pm.project_id = public.project_members.project_id
--       AND pm.user_id = auth.uid()
--   ))
--
-- When a query reads public.project_members, the policy fires → subqueries
-- public.project_members → the subquery ALSO has RLS applied → policy fires
-- again → infinite recursion.  Postgres raises `42P17: infinite recursion
-- detected in policy for relation "project_members"`.
--
-- The standard fix (flagged as an advisory note by the 0002 tester agent):
-- extract membership checks into SECURITY DEFINER helper functions.  These
-- functions execute with the postgres role's privileges and bypass RLS on
-- their internal queries, breaking the recursion.  The policies then call
-- the helpers instead of inlining a recursive subquery.
--
-- This migration:
--   1. Creates `public.is_project_member(uuid)` + `public.is_project_owner(uuid)`
--      helpers — both SECURITY DEFINER, stable, search_path locked for safety.
--   2. Drops the recursive project_members + projects policies from 0002.
--   3. Recreates them using the helpers.  Same semantics, no recursion.
--
-- Scope
-- -----
-- Affects only public.project_members and public.projects.  ppgantt.* policies
-- in 0004 also use EXISTS subqueries against public.project_members but those
-- are NOT self-referential (the RLS target is ppgantt.tasks / phases / etc.,
-- not project_members itself), so they don't recurse.  They will still work
-- after this migration because the helper functions they effectively call
-- through (the project_members policies) no longer recurse.
--
-- Idempotency
-- -----------
-- CREATE OR REPLACE for functions, DROP POLICY IF EXISTS + CREATE POLICY
-- for policies.  Safe to re-run.
--
-- Coordinate with PPControl
-- -------------------------
-- PPControl's ppcontrol_* policies on ppcontrol.* tables use the same
-- EXISTS-against-project_members pattern and will fire correctly once this
-- migration lands (because their subquery on public.project_members will be
-- gated by the non-recursive policies below).  PPControl must NOT add its
-- own EXISTS(SELECT FROM public.project_members ...) to its shared-layer
-- 0002 — instead, call is_project_member()/is_project_owner() directly or
-- let the policies below do the filtering.  Coordination doc updated at
-- /Users/peterpropper/AI Projects/_TOOLS/PPGantt/_docs/2026-04-18-ppcontrol-coordination.md.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Helper functions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_project_member(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.project_members pm
    WHERE pm.project_id = p_project_id
      AND pm.user_id = auth.uid()
  );
$fn$;

CREATE OR REPLACE FUNCTION public.is_project_owner(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.project_members pm
    WHERE pm.project_id = p_project_id
      AND pm.user_id = auth.uid()
      AND pm.role = 'owner'
  );
$fn$;

CREATE OR REPLACE FUNCTION public.is_project_editor(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.project_members pm
    WHERE pm.project_id = p_project_id
      AND pm.user_id = auth.uid()
      AND pm.role IN ('owner', 'editor')
  );
$fn$;

-- Allow anon/authenticated/service_role to call these helpers.  The functions
-- are SECURITY DEFINER, so they execute as postgres internally regardless of
-- who calls them — this grant just permits the CALL itself.
GRANT EXECUTE ON FUNCTION public.is_project_member(uuid)  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_project_owner(uuid)   TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_project_editor(uuid)  TO anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 2. public.project_members — drop recursive policies, recreate via helpers
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS project_members_read_member     ON public.project_members;
DROP POLICY IF EXISTS project_members_insert_owner    ON public.project_members;
DROP POLICY IF EXISTS project_members_update_owner    ON public.project_members;
DROP POLICY IF EXISTS project_members_delete_owner    ON public.project_members;

CREATE POLICY project_members_read_member
  ON public.project_members FOR SELECT
  USING (public.is_project_member(public.project_members.project_id));

-- Bootstrap branch preserved: either caller is an existing owner, OR caller
-- is inserting themselves as 'owner' of a project they `created_by`.
CREATE POLICY project_members_insert_owner
  ON public.project_members FOR INSERT
  WITH CHECK (
    public.is_project_owner(public.project_members.project_id)
    OR (
      user_id = auth.uid()
      AND role = 'owner'
      AND EXISTS (
        SELECT 1 FROM public.projects p
        WHERE p.id = public.project_members.project_id
          AND p.created_by = auth.uid()
      )
    )
  );

CREATE POLICY project_members_update_owner
  ON public.project_members FOR UPDATE
  USING (public.is_project_owner(public.project_members.project_id))
  WITH CHECK (public.is_project_owner(public.project_members.project_id));

CREATE POLICY project_members_delete_owner
  ON public.project_members FOR DELETE
  USING (public.is_project_owner(public.project_members.project_id));


-- -----------------------------------------------------------------------------
-- 3. public.projects — same recursion-free rewrite
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS projects_read_member          ON public.projects;
DROP POLICY IF EXISTS projects_insert_authenticated ON public.projects;
DROP POLICY IF EXISTS projects_update_owner         ON public.projects;
DROP POLICY IF EXISTS projects_delete_owner         ON public.projects;

CREATE POLICY projects_read_member
  ON public.projects FOR SELECT
  USING (public.is_project_member(public.projects.id));

CREATE POLICY projects_insert_authenticated
  ON public.projects FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND created_by = auth.uid()
  );

CREATE POLICY projects_update_owner
  ON public.projects FOR UPDATE
  USING (public.is_project_owner(public.projects.id))
  WITH CHECK (public.is_project_owner(public.projects.id));

CREATE POLICY projects_delete_owner
  ON public.projects FOR DELETE
  USING (public.is_project_owner(public.projects.id));


-- End of 20260418_0006_fix_rls_recursion.sql
