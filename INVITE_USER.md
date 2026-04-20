# Inviting a new user to a PPGantt project

> Current state: there's no UI for managing team members. Membership lives in `public.project_members` and is added via SQL. A proper invitation UI ("Feature A") is documented in `AGENTS.md` as planned work.

## Prerequisites

1. The new user must **sign in at least once** via the Supabase magic-link flow (`/login` on the deployed site). This is what creates their `auth.users` row. Without this, the SQL below finds no matching user and the INSERT does nothing.
2. You (the inviter) must have **owner** role on the target project. Without it, RLS rejects the INSERT.

## Roles

`public.project_members.role` must be one of:

- **`member`** — read-only. Can view snapshots but cannot create/edit/push anything.
- **`editor`** — read + write. Can Pull from Notion, save snapshots, Push to Notion, edit tasks.
- **`owner`** — everything + delete + invite other members + change roles.

Most collaborators you invite will be `editor`.

## Step 1 — Verify the new user has signed in

In the Supabase Dashboard → SQL Editor:

```sql
SELECT id, email, created_at
FROM auth.users
WHERE email = 'new.member@example.com';
```

Expected: one row. If zero rows → they haven't signed in yet. Send them the deploy URL (e.g. `https://ppgantt.netlify.app/login`) and ask them to complete the magic-link flow once before you run the INSERT.

## Step 2 — Add them to the project

```sql
INSERT INTO public.project_members (project_id, user_id, role)
SELECT
  (SELECT id FROM public.projects WHERE slug = '<PROJECT_SLUG>'),
  (SELECT id FROM auth.users WHERE email = '<NEW_MEMBER_EMAIL>'),
  '<ROLE>'   -- 'member' | 'editor' | 'owner'
ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role;
```

Replace:
- `<PROJECT_SLUG>` — the slug in the URL (e.g. `societist`, `rvms`, `cpu`)
- `<NEW_MEMBER_EMAIL>` — the exact email they used to sign in
- `<ROLE>` — one of the three role strings above

The `ON CONFLICT` clause makes the statement idempotent — if they were already a member with a different role, this updates the role instead of erroring.

## Step 3 — (Strongly recommended) Set their profile name + colour

The snapshot sidebar renders a coloured 2-letter owner badge on each card. Set `first_name`, `last_name`, and `color` so their snapshots are visually distinguishable. Initials auto-derive from `first_name[0] + last_name[0]` — no need to set `initials` unless you want an override (e.g. 3-letter middle initials).

```sql
INSERT INTO public.profiles (id, first_name, last_name, color)
SELECT u.id, '<FIRST_NAME>', '<LAST_NAME>', '<COLOR_HEX>'
FROM auth.users u
WHERE u.email = '<NEW_MEMBER_EMAIL>'
ON CONFLICT (id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  last_name  = EXCLUDED.last_name,
  color      = EXCLUDED.color;
```

**Color palette** (constrained by CHECK constraint — other values are rejected):

| Hex | Label |
|---|---|
| `#3B82F6` | Blue |
| `#16A34A` | Green |
| `#EC4899` | Pink |
| `#A855F7` | Purple |
| `#EAB308` | Amber |
| `#06B6D4` | Cyan |
| `#F97316` | Orange |
| `#64748B` | Slate (default) |

If you want an initials override (e.g. family name starting with a digit, or a nickname), also set it:

```sql
UPDATE public.profiles SET initials = '<INITIALS>'
WHERE id = (SELECT id FROM auth.users WHERE email = '<NEW_MEMBER_EMAIL>');
```

Constraints on `initials`: 1-5 uppercase A-Z letters only (e.g. `PP`, `LB`, `MRW`).

## Step 4 — Verify

```sql
SELECT p.slug, u.email, pm.role,
       pr.first_name, pr.last_name, pr.initials, pr.color
FROM public.project_members pm
JOIN public.projects p ON p.id = pm.project_id
JOIN auth.users u ON u.id = pm.user_id
LEFT JOIN public.profiles pr ON pr.id = pm.user_id
WHERE p.slug = '<PROJECT_SLUG>'
ORDER BY pm.role, u.email;
```

You should see the new row. Ask the new member to reload the project URL (e.g. `/societist`) — they'll now see snapshots, phases, streams, and tasks.

## Removing a member

```sql
DELETE FROM public.project_members
WHERE project_id = (SELECT id FROM public.projects WHERE slug = '<PROJECT_SLUG>')
  AND user_id = (SELECT id FROM auth.users WHERE email = '<MEMBER_EMAIL>');
```

Their session stays alive until expiry, but the next page load will 403 on any gated data call. Their `auth.users` row stays — they can still sign in, they just won't have project access.

## Common issues

| Symptom | Cause | Fix |
|---|---|---|
| INSERT affects 0 rows | New user hasn't signed in yet | Have them log in via magic link once, retry |
| INSERT rejected by RLS | You're not an owner on this project | Run as service_role from the dashboard (bypasses RLS) |
| New member sees empty sidebar after login | `project_members` row exists but `role` = `'member'` and project has no snapshots yet | Correct — they need `editor` to pull/create snapshots, or wait for an owner to pull first |
| Initials show as `?` on cards | `profiles.initials` is NULL for that user | Run Step 3 |

## Future: proper invitation UI

See the "Feature A: Team invitation UI" section in `AGENTS.md` for the planned self-service flow. Until that ships, this SQL is the canonical path.
