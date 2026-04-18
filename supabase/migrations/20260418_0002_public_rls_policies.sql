-- =============================================================================
-- Migration: 20260418_0002_public_rls_policies
-- Tool:      PPGantt  (shared-layer migration — identical to PPControl's 0002)
-- Project:   wzzjozdljxhmrmscevlh  (shared Supabase project)
--
-- Purpose
-- -------
-- Enables Row Level Security on the four shared `public.*` tables created in
-- 0001, and installs the self-access + membership-driven RLS policies that
-- all PP-tools rely on for row-level authorization.
--
-- Tables covered (all in `public.*`):
--   * profiles          — self-access (auth.uid() = id)
--   * projects          — member-read, authenticated-self-create, owner-write
--   * project_members   — members see fellow members; owners manage membership
--   * preferences_kv    — self-access (auth.uid() = user_id)
--
-- Idempotency
-- -----------
-- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` is a no-op when RLS is already
-- on, so the ALTERs are safe to re-run unconditionally.
--
-- Postgres does NOT support `CREATE POLICY IF NOT EXISTS`, so each policy is
-- wrapped in a `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`
-- block. A second run of this file — or a run on a DB where PPControl's
-- equivalent 0002 has already been applied — silently skips already-present
-- policies. No DROP POLICY is ever issued: that protects both tools from
-- racing each other and from accidental policy destruction.
--
-- Companion contract
-- ------------------
-- PPControl's repo ships an identical `20260418_0002_public_rls_policies.sql`
-- with the same policy names and predicates. Whichever tool runs first wins
-- the CREATE; the other tool's DO blocks catch `duplicate_object` and
-- continue. If the two files ever diverge on predicate text, that is a
-- coordination bug — both repos' 0002 files update together, in lockstep.
--
-- Out of scope for this file
-- --------------------------
--   * `public.*` DDL                 → 20260418_0001_shared_public_schema.sql
--   * `ppgantt.*` schema + tables    → 20260418_0003_ppgantt_schema.sql
--   * `ppgantt.*` RLS policies       → 20260418_0004_ppgantt_rls.sql
--   * Seed data                      → 20260418_0005_ppgantt_seed_societist.sql
--   * `auth.*` policies              → managed by Supabase
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Enable Row Level Security on the shared tables.
--    Idempotent by nature — re-enabling already-enabled RLS is a no-op.
-- -----------------------------------------------------------------------------
ALTER TABLE public.profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.preferences_kv   ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- 2. Policies
-- =============================================================================


-- -----------------------------------------------------------------------------
-- public.profiles — self-access only.
--   A profile row is private to its owning auth user. No cross-user reads.
--   No DELETE policy: profile rows die via the FK cascade from auth.users.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  CREATE POLICY profiles_self_read
    ON public.profiles
    FOR SELECT
    USING (id = auth.uid());
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE POLICY profiles_self_insert
    ON public.profiles
    FOR INSERT
    WITH CHECK (id = auth.uid());
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE POLICY profiles_self_update
    ON public.profiles
    FOR UPDATE
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;


-- -----------------------------------------------------------------------------
-- public.preferences_kv — self-access only.
--   Each user sees and manages only their own key/value rows. DELETE is
--   allowed (unlike profiles) because users routinely clear preferences.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  CREATE POLICY preferences_kv_self_read
    ON public.preferences_kv
    FOR SELECT
    USING (user_id = auth.uid());
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE POLICY preferences_kv_self_insert
    ON public.preferences_kv
    FOR INSERT
    WITH CHECK (user_id = auth.uid());
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE POLICY preferences_kv_self_update
    ON public.preferences_kv
    FOR UPDATE
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE POLICY preferences_kv_self_delete
    ON public.preferences_kv
    FOR DELETE
    USING (user_id = auth.uid());
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;


-- -----------------------------------------------------------------------------
-- public.project_members — fellow-member reads; owner-managed writes.
--   Members of a project can see who else is a member of that project.
--   Only 'owner' rows can add, update, or remove membership — except for
--   the bootstrap case where a brand-new project has no owners yet (see
--   the chicken-and-egg branch on the INSERT policy).
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  CREATE POLICY project_members_read_member
    ON public.project_members
    FOR SELECT
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = public.project_members.project_id
        AND pm.user_id = auth.uid()
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Bootstrap note for the INSERT policy:
--
-- The normal rule is "only an existing owner of the project can add members."
-- But that creates a chicken-and-egg problem for the very first member of a
-- newly-created project: there are no owners yet, so no one would be allowed
-- to insert the first owner row.
--
-- The second branch of the WITH CHECK solves it: a user is allowed to insert
-- a row that makes THEMSELVES the owner of a project they just created
-- (i.e. `public.projects.created_by = auth.uid()`). Once that first owner
-- row exists, every subsequent insert flows through the normal owner check.
DO $$
BEGIN
  CREATE POLICY project_members_insert_owner
    ON public.project_members
    FOR INSERT
    WITH CHECK (
      EXISTS (
        SELECT 1 FROM public.project_members pm
        WHERE pm.project_id = public.project_members.project_id
          AND pm.user_id = auth.uid()
          AND pm.role = 'owner'
      )
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
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE POLICY project_members_update_owner
    ON public.project_members
    FOR UPDATE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = public.project_members.project_id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = public.project_members.project_id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE POLICY project_members_delete_owner
    ON public.project_members
    FOR DELETE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = public.project_members.project_id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;


-- -----------------------------------------------------------------------------
-- public.projects — membership-driven reads; owner-driven writes.
--   The specs are silent on public.projects policies (they focus on the
--   self-access tables and leave project-level access derivation to the
--   tools). These policies are the sensible derivation:
--
--     - Any member of a project can SELECT its row.
--     - Any authenticated user can INSERT a new project, as long as they
--       mark themselves as `created_by` (this pairs with the bootstrap
--       branch of project_members_insert_owner).
--     - Only owners of a given project can UPDATE or DELETE it.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  CREATE POLICY projects_read_member
    ON public.projects
    FOR SELECT
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = public.projects.id
        AND pm.user_id = auth.uid()
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE POLICY projects_insert_authenticated
    ON public.projects
    FOR INSERT
    WITH CHECK (
      auth.uid() IS NOT NULL
      AND created_by = auth.uid()
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE POLICY projects_update_owner
    ON public.projects
    FOR UPDATE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = public.projects.id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = public.projects.id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE POLICY projects_delete_owner
    ON public.projects
    FOR DELETE
    USING (EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = public.projects.id
        AND pm.user_id = auth.uid()
        AND pm.role = 'owner'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- End of 20260418_0002_public_rls_policies.sql
