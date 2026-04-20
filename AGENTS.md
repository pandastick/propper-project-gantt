# PPGantt — Agent Rules

> Generic rules for any AI coding agent (Claude Code, Cursor, Aider, etc.) working on PPGantt. Read this before making changes. Project-specific deployment details (token rotation TODOs, per-tenant slug mappings, etc.) live in `PRIVATE_INFRA.md` — git-ignored, local-only.

## Context

PPGantt is a Gantt chart viewer for roadmaps synced from Notion databases. It renders task bars with slack-aware critical path simulation, supports a snapshot system for point-in-time copies of the task list, and round-trips edits back to Notion via a "Push snapshot" flow. It runs as a static web app with Netlify Functions as the backend and Supabase (Postgres + Auth) as the data layer.

Architecturally:
- **Viewer + simulator**: static JS + Frappe Gantt, in `index.html` + `js/*`. No build step.
- **Sync**: Python CLI in `sync/` that reads a Notion database, maps its schema, and seeds / refreshes the Supabase `ppgantt.*` tables.
- **Data**: Supabase Postgres, schema `ppgantt.*`, RLS-gated.
- **Backend**: Netlify Functions in `netlify/functions/*` forward the user's Supabase JWT to PostgREST so RLS enforces project membership.
- **Auth**: Supabase Auth email + password (primary) with a magic-link fallback. Gated routes like `/societist` redirect unauthenticated users to `/login`. Admin-created users start with a temp password + `must_change_password=true` metadata flag; the login page forces a password change on first sign-in.

## Non-Negotiables

1. **The JSON contract in this file is LOCKED.** Every component (sync, viewer, simulator, snapshots, change log) must conform to it. If you need to change the contract, stop and ask the maintainer — changing it in one place breaks everything downstream.

2. **Simulation is non-destructive.** Dragging a bar in the viewer NEVER mutates `ppgantt.tasks` directly. All in-viewer edits live in memory until the user saves them as a new `kind='snapshot'` row via the sidebar.

3. **Frappe Gantt is the rendering library.** Vendored into `js/frappe-gantt.min.js` + `css/frappe-gantt.css`. MIT license. Do not swap it for another library.

4. **Safari-compatible file://**. Opening `index.html` via `file://` (no server, no npm install, no Python) must render the public demo fixtures. The JSONP `.js` shims in `data/` exist for this reason. Loader falls back gracefully between `/api/*`, Netlify Functions, and static `data/` paths.

5. **Local-first dev loop.** The Express server in `server.js` (`npm start`) serves the viewer + demo fixtures without hitting any cloud service. Only gated slug routes (`/<slug>`) require Netlify + Supabase.

6. **No auto-push to git or Netlify.** Commits land on `main` when the maintainer asks; pushes happen only on explicit request. Treat every `git push` as a visible/shared action.

7. **No secrets in code or committed files.** Env vars live in Netlify (production) and a git-ignored `.env` (local dev). Rotate via `netlify env:set`. Bearer tokens, Supabase anon keys, and Notion integration tokens must never appear in tracked files.

## JSON Contract (viewer payload shape)

Every viewer render consumes this shape (returned by `netlify/functions/get-roadmap.js`, by the `_shared/roadmap-shape.js` assembler, or stored as `ppgantt.snapshots.payload`):

```json
{
  "source": {
    "notion_url": "...",
    "data_source_id": "collection://<uuid>",
    "table_name": "ROADMAP",
    "synced_at": "2026-04-19T20:00:00Z",
    "row_count": 66
  },
  "schema_mapping": { "name_field": "Task Name", "start_field": "Start Date", ... },
  "phase_palette": { "phase-1-foundation": { "color": "#F59E0B" }, ... },
  "tasks": [
    {
      "id": "<uuid>",
      "name": "Task name",
      "start": "YYYY-MM-DD",
      "end": "YYYY-MM-DD",
      "progress": 0,
      "dependencies": "comma,separated,task,ids",
      "custom_class": "phase-X critical-path risk-high milestone",
      "meta": {
        "phase": "...",
        "stream": "...",
        "owner": "...",
        "status": "...",
        "risk_level": "...",
        "critical_path": true,
        "is_milestone": false,
        "slack_days": 0,
        "duration_days": 2,
        "duration_text": "2 days",
        "reference": "...",
        "notes": "...",
        "notion_url": "...",
        "notion_page_id": "<uuid>",
        "notion_sync_status": "clean"
      }
    }
  ]
}
```

See `data/_fixture.json` for a complete minimal example.

## Development Fixture

`data/_fixture.json` is a hand-written 12-task fixture covering all 7 phases, critical + off-path tasks, slack variations, milestones, risk levels, and a diamond dependency (`fix-010` blocked by both `fix-008` and `fix-009`). Build and test against this fixture — it's designed to exercise every visual and logical code path.

`data/_fixture2.json` is the same fixture with a 14-day push applied, useful for testing the overlay mode.

## Current State (as of 2026-04-19)

### Supabase schema
- `public.projects`, `public.project_members`, `public.profiles` — shared.
- `ppgantt.phases`, `ppgantt.streams`, `ppgantt.tasks`, `ppgantt.task_dependencies`, `ppgantt.sync_events`, `ppgantt.notion_schema_mappings`, **`ppgantt.snapshots`**.
- RLS on every table; `public.is_project_member` / `is_project_editor` / `is_project_owner` SECURITY DEFINER helpers drive the policies.
- Migrations live in `supabase/migrations/YYYYMMDD_NNNN_<name>.sql`. Latest: `20260419_0009_profiles_initials`.
- `ppgantt.snapshots` (migration 0008) is a per-project point-in-time copy of the task list. `kind` ∈ `{import, snapshot, pushed}`. `payload jsonb` holds the full viewer-shape response. A CHECK constraint enforces `(kind='pushed') = (pushed_at IS NOT NULL)`.
- `public.profiles.initials` (migration 0009) is a 1-5 uppercase-letter badge rendered on snapshot cards.

### Netlify Functions

| Function | Method(s) | Purpose |
|---|---|---|
| `get-roadmap.js` | GET | Live roadmap for the viewer. Joins phases/streams/tasks/deps into the viewer shape. |
| `pull-from-notion.js` | POST | Fetches Notion, upserts `ppgantt.tasks` with 4-way merge (`clean\|local_ahead\|notion_ahead\|conflict`), writes a `sync_events` row, creates a `kind='import'` snapshot. |
| `push-to-notion.js` | POST | Requires `snapshot_id`; pushes that snapshot's payload to Notion, stamps audit fields, flips snapshot `kind` to `pushed` on final-chunk success. |
| `list-snapshots.js` | GET | Sidebar feed: snapshots for a project, sorted newest-first, payload excluded, enriched with `created_by_initials`. |
| `snapshot.js` | GET / POST / DELETE | Single-snapshot CRUD. |

### Viewer features
- Two-row toolbar with icon-only action cluster: undo / reset / sync menu / user menu.
- Snapshot sidebar (gated routes only) with kind pills (blue IMPORT, slate SNAPSHOT, green PUSHED), owner-initials badge, local-timezone timestamps, delete confirmation, unsaved-edits guard.
- Search input filters Gantt bars by `name` / `meta.owner` / `meta.status` substring, composed on top of the existing focus/crossfade dim.
- Sticky date header that survives Frappe's zoom-mode re-renders.

### Non-gated public demo
Still works via the legacy file-list sidebar and static `data/_fixture*.json` files. Never broken by the snapshot work.

## Rule Cascading

PPGantt inherits rules from three places:
1. Workspace-root `.agent/rules/` (shared across all projects)
2. This `AGENTS.md` (PPGantt-specific)
3. Subfolder-local rules if they exist

Lower-level rules override higher-level. Conflicts must be flagged to the maintainer before acting.

## Development Loop

### Local dev (public demo)
```bash
cd /path/to/PPGantt
npm install
npm start
# → http://localhost:8080/ — serves the fixtures
```

### Local dev (gated routes, with Supabase-backed data)
```bash
netlify dev
# → http://localhost:8888/societist
```
Requires `netlify login` + `netlify link` once; env vars (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `NOTION_API_KEY`, etc.) come from Netlify or a local `.env`.

### Running tests
```bash
node tests/test_cascade.js                    # 9 simulator tests
node tests/test_related_component.js          # 17 lineage tests
node tests/test_pull_from_notion.js           # 18 pull tests
node tests/test_push_to_notion_supabase.js    # 19 push tests
node tests/test_get_roadmap_supabase.js       # 8 read tests
node tests/test_list_snapshots.js             # 10 list tests
node tests/test_snapshot.js                   # 28 snapshot CRUD tests
node tests/test_supabase_gate.mjs             # 10 auth gate tests
node js/change-log.js                         # 7 change-log self-tests
sync/.venv/bin/python -m pytest tests/ -q     # 35 Python sync tests
```

Total: ~160 passing tests. All JS tests run offline with mocked `fetch` — no live Supabase or Notion calls.

### Applying a new Supabase migration
1. Write `supabase/migrations/YYYYMMDD_NNNN_<name>.sql`. Follow the existing idempotency patterns (`IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`).
2. Apply via the Supabase Dashboard SQL Editor, or via the Management API if a token is available. The local Supabase CLI's migration tracking can get out of sync with dashboard-applied migrations — prefer the dashboard unless you have a reason not to.
3. Verify tables/policies/indexes exist via a quick SELECT from `information_schema` / `pg_policy`.

## Future Features

### Feature A: Team invitation UI (not yet built)

**Why it's needed:** Adding a new project member today requires direct SQL against `public.project_members` (see the invite snippet in `INVITE_USER.md`). The user has signed in once (so `auth.users` has their row), then an admin runs SQL to grant them membership with a role (`member`, `editor`, or `owner`). Clunky and error-prone.

**What to build:** A "Team" section in the user menu (top-right) showing:
- Current project members with their role and initials
- An "Invite by email" input that:
  1. Looks up `auth.users` by email
  2. If found → INSERT into `public.project_members` with the chosen role
  3. If not found → send a Supabase magic-link invite (via Supabase Auth Admin API) and queue the `project_members` insert to fire once they complete signup (can be done via a DB trigger on `auth.users` INSERT that reads from a `pending_invites` table)
- Role-change dropdown per member (owner only can change roles)
- Remove-member action (owner only)

**Constraints:**
- All writes to `public.project_members` require the caller to be an `owner` — enforce with an RLS policy using `is_project_owner`.
- Don't expose `auth.users` emails to non-owners — join through `public.profiles` (which should have a `display_name` + `initials` field — already exists).
- Initials can be set at invite time OR defaulted from the email first letter, with an owner-editable override.

**Rough effort:** 1-2 days — new Netlify function (`manage-members.js` or similar), new migration if `pending_invites` table is needed, UI wiring, RLS tightening.

### Features 7 + 8: Inline task editing (not yet built)

See `_docs/2026-04-19-handoff-inline-task-editing.md` for the full architectural analysis. The handoff covers:
- Source-of-truth tension (live-task writes vs. snapshot overlays)
- 4-way merge status composition with inline edits
- RLS and the `editor` role
- Popup architecture (Frappe's `custom_popup_html` vs. replacement)
- Field scope v1 / v2 / v3
- Notion write-back timing (keep snapshot-push model)
- UI patterns for double-click-to-edit
- Schema changes (likely none for v1)
- Testing strategy
- ~6-8 implementation milestones

**Rough effort:** 1-2 weeks.

### Phase 5: History log view (deferred)

A collapsible panel showing `ppgantt.sync_events` + snapshot creations chronologically for the current project. Small scope (~30 min of work) — deferred because the snapshot sidebar already covers the same ground visually (the creation timestamp + kind pill on each card is the log).

## Testing

All tests run offline. Mocked fetch for the Netlify functions; fixture-based for the simulator. If a test needs to hit Supabase live, it goes in `_docs/`, not `tests/`.

Before merging any PR: run the full test suite listed above, plus syntax-check the inline scripts in `index.html`:
```bash
node -e "const fs=require('fs'); const h=fs.readFileSync('index.html','utf8'); const rx=/<script>([\\s\\S]*?)<\\/script>/g; let m; let n=0; while ((m=rx.exec(h))) { new Function(m[1]); n++; } console.log('blocks parsed:', n);"
```
Should print `blocks parsed: 2`.

## Setting Up For A New User (OSS contributors)

If you're helping someone onboard to their own PPGantt instance:

1. Ask them for a Notion database URL they want to track as a Gantt chart.
2. Help them get a Notion integration token at `notion.so/my-integrations`.
3. Share the target database with the integration.
4. Set up the Python sync venv and `.env` with their keys.
5. Run a first sync — the LLM-assisted schema mapper will ask them to confirm field mappings, then cache the result.
6. Open the viewer (`npm start`).

Under 5 minutes from "I have a Notion database" to "I'm looking at a live Gantt chart with slack simulation" — that's the target.

For multi-user / team-workspace deployments (Supabase + Netlify), follow the deployment notes in `PRIVATE_INFRA.md` (the maintainer's local deployment docs) or request a write-up if you're setting up your own instance.

## Simulation Algorithm

Slack-aware topological cascade. Key points:

- Topologically sort from the pushed task through its dependents.
- For each downstream task, `effectivePush = max(0, predecessorPush - task.slack_days)`.
- Tasks with `slack_days ≥ push` do NOT move.
- Cycle detection must throw a UI error, not silently ignore.

See `js/simulator.js` for the full implementation and `tests/test_cascade.js` for the 9-test coverage matrix.

## When In Doubt

Read `js/simulator.js` and `data/_fixture.json` — most architectural questions answer themselves once you see the cascade logic running against the reference fixture. Beyond that, read `_docs/2026-04-19-handoff-inline-task-editing.md` for the current thinking on where the codebase is headed. If still stuck, open a GitHub issue rather than guessing.
