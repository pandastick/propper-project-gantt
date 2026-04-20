# Inviting a new user to a PPGantt project

> Current state: there's no UI for managing team members. Membership lives in `public.project_members` and is added via SQL. A proper invitation UI ("Feature A") is documented in `AGENTS.md` as planned work.

## Two paths

1. **Admin-created account (recommended)** — you create the user with a temp password via Supabase admin API. Share the temp password with them securely. On first login they're forced to change it. No email required, no rate-limit risk.
2. **Self-serve magic-link** — they visit `/login`, click "Email me a magic link", click the link, land signed in. Limited to 2 emails/hour unless you configure custom SMTP.

Path 1 is reliable and fast. Path 2 depends on the Supabase default mailer's rate limit.

## Path 1 — Admin-created account

Create the account via the Supabase admin API. Needs the `service_role` key from **Supabase Dashboard → Settings → API**.

```bash
SERVICE_ROLE="<paste-service-role-key>"
NEW_EMAIL="new.member@example.com"
TEMP_PASSWORD=$(python3 -c "import secrets, string; print(''.join(secrets.choice(string.ascii_letters + string.digits + '@#\$%&*!?') for _ in range(16)))")
echo "Temp password: $TEMP_PASSWORD"

curl -s -X POST "https://wzzjozdljxhmrmscevlh.supabase.co/auth/v1/admin/users" \
  -H "apikey: $SERVICE_ROLE" \
  -H "Authorization: Bearer $SERVICE_ROLE" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$NEW_EMAIL\",\"password\":\"$TEMP_PASSWORD\",\"email_confirm\":true,\"user_metadata\":{\"must_change_password\":true}}"
```

Share the temp password with them over a secure channel (1Password shared item, Signal, WhatsApp, etc. — not plain email).

On their first sign-in at `/login`, they enter email + temp password, then the app shows a "set a new password" form before granting access.

Then continue with Step 2 + Step 3 + Step 4 below to grant project membership and set their profile.

## Path 2 — Self-serve magic link

They visit `https://ppgantt.netlify.app/login`, click "Email me a magic link instead", enter email, click the link in the email. This creates their `auth.users` row. Then you run Step 2 onward.

## Prerequisites (both paths)

1. The new user must have an `auth.users` row before you can grant project membership. Path 1 creates it directly; Path 2 requires them to complete a magic-link sign-in first.
2. You (the inviter) must have **owner** role on the target project. Without it, RLS rejects the INSERT in Step 2.

## Roles

`public.project_members.role` must be one of:

- **`member`** — read-only. Can view snapshots but cannot create/edit/push anything.
- **`editor`** — read + write. Can Pull from Notion, save snapshots, Push to Notion, edit tasks.
- **`owner`** — everything + delete + invite other members + change roles.

Most collaborators you invite will be `editor`.

## Step 1 — Verify the new user exists

In the Supabase Dashboard → SQL Editor:

```sql
SELECT id, email, created_at
FROM auth.users
WHERE email = 'new.member@example.com';
```

Expected: one row. If zero rows → use Path 1 above to create the account, OR have them complete Path 2's magic-link sign-in once before you continue.

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
