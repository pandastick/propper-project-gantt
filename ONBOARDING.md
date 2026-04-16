# Onboarding — for AI agents helping a new user set up PPGantt

> **You are an AI coding agent** (Claude Code, Cursor, Windsurf, Codex, etc.) and the user has just cloned this repo. Your job is to walk them from "I just cloned PPGantt" to "I'm looking at my own roadmap, not the demo."

Follow this playbook in order. Don't skip steps. Don't assume the user knows what a "manifest" is or that `_fixture.json` is a demo.

---

## Step 1 — Start with the demo (don't touch their data yet)

On first contact, verify the user can **run the tool with the default demo fixture**. This proves the install works and gives them a feel for the UI before they commit to importing their own data.

Commands the user runs (not you):

```bash
npm install
npm start
```

Then they open `http://localhost:8080` in a browser. They should see:

- A Gantt chart titled **"PPGantt Demo Roadmap (Simulation)"**
- 12 tasks (task-001 through task-012), owned by Alice / Bob / Carol
- The first task's tooltip says `SIMULATION — this is a demo roadmap...`
- Clicking any task opens a popup with its details
- Shift-clicking a task enters directed-lineage focus mode (the tool's headline feature)

If any of that doesn't work, **debug before continuing**. Don't try to import real data on top of a broken install.

## Step 2 — Ask what kind of data they want to import

Exactly one question, delivered naturally in conversation:

> "Where does your real roadmap data live? I can help you connect it. Most people have one of these:
>
> 1. A **Notion database** with tasks, dates, and dependencies
> 2. A **JSON file** they've already prepared (maybe exported from another tool)
> 3. **Nothing yet** — they want to build a roadmap from scratch inside PPGantt"

Their answer determines the path:
- **Notion database** → Step 3 (sync path)
- **JSON file** → Step 4 (drop-in path)
- **Nothing yet** → Step 5 (manual path)

## Step 3 — Notion sync path

Prerequisites the user needs:
- A **Notion integration token** (they get it from `https://www.notion.so/my-integrations`, 2 min)
- An **Anthropic API key** for the LLM-assisted schema mapping (`https://console.anthropic.com/`)
- The target database must be **shared with the integration** (Notion → database → ... menu → "Add connections")

Your job:

1. **Check `sync/.env.example`** and help them create `sync/.env` with their keys. That file is git-ignored — never commit it.
2. **Set up the Python venv**: `cd sync && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
3. **Run a first sync**:
   ```bash
   cd sync
   .venv/bin/python sync.py "<their-notion-database-url>" --output-name=<their-slug>
   ```
   The first run calls Claude Sonnet to propose a field mapping (Task Name → name, Start Date → start, etc.). Show the user the proposed mapping and confirm.
4. **Check the manifest**: after sync, `data/_manifest.json` should list their new `<slug>.json` file alongside the fixtures.
5. **Hit the refresh button** in the viewer's file sidebar, or hard-reload the page. Their roadmap should appear as a selectable file.

Now go to Step 6.

## Step 4 — JSON drop-in path

The user has a JSON file they want to visualize. They don't need Notion or Anthropic keys.

1. **Show them the JSON schema** by opening `data/_fixture.json` and explaining each field. The contract is in `agent.md` under "JSON Contract". Key fields: `id`, `name`, `start`, `end`, `dependencies`, `custom_class`, `meta.phase`, `meta.stream`, `meta.owner`.
2. **Help them rewrite their file to match** if it doesn't already. This may require a transform script (Python/Node one-liner).
3. **Place the file** at `data/<their-slug>.json`.
4. **Click the refresh-manifest button** in the viewer's sidebar. The viewer should pick up the new file automatically.
5. **If they have no `_manifest.json` entry** after refresh, something's wrong — check the JSON is valid, the filename starts with a letter (not `_`, which marks fixtures), and the server's `DATA_DIR` is set correctly.

Now go to Step 6.

## Step 5 — Starting from scratch path

They don't have data yet. Walk them through creating a minimal 3-task JSON:

```json
{
  "source": {"table_name": "My Roadmap", "synced_at": "2026-01-01T00:00:00Z", "row_count": 3},
  "schema_mapping": {"id_field": "id", "name_field": "name", "start_field": "start", "end_field": "end"},
  "phase_palette": {"Phase 1": "#3B82F6", "Phase 2": "#10B981"},
  "tasks": [
    {"id": "t1", "name": "First task", "start": "2026-01-01", "end": "2026-01-03", "progress": 0, "dependencies": "", "custom_class": "phase-1", "meta": {"phase": "Phase 1", "owner": "me"}},
    {"id": "t2", "name": "Second task", "start": "2026-01-04", "end": "2026-01-07", "progress": 0, "dependencies": "t1", "custom_class": "phase-1", "meta": {"phase": "Phase 1", "owner": "me"}},
    {"id": "t3", "name": "Launch", "start": "2026-01-08", "end": "2026-01-08", "progress": 0, "dependencies": "t2", "custom_class": "phase-2 milestone", "meta": {"phase": "Phase 2", "owner": "me", "is_milestone": true}}
  ]
}
```

Save as `data/my-roadmap.json`, click refresh in the sidebar, done. Now go to Step 6.

## Step 6 — Remove the demo (once they confirm their data works)

**Only do this step after the user has successfully viewed their own data.** Removing the demo prematurely leaves them with nothing to see if their import failed.

Confirm with the user:

> "You've got your roadmap showing up. Do you want me to remove the demo roadmap so it doesn't clutter your sidebar? You can always restore it later from git."

If yes:

```bash
# 1. Move the fixtures out of data/ (keep them around in case they change their mind)
mkdir -p data/_archived_fixtures
git mv data/_fixture.json data/_fixture.js data/_fixture2.json data/_fixture2.js data/_archived_fixtures/

# 2. Rebuild the manifest so it only shows the user's roadmap(s)
# If the server is running, just click the refresh button in the sidebar.
# Otherwise, the next `npm start` will auto-regenerate the manifest from disk.

# 3. Commit (to the user's fork, not to pandastick/propper-project-gantt)
git add data/
git commit -m "Remove demo fixture — using own roadmap now"
```

**Important**: if the user cloned this repo to modify it, their changes should go to their own fork, not the upstream `pandastick/propper-project-gantt` repo. Check their `git remote -v` if unsure.

## Step 7 — Suggest a shared-team workflow (optional)

If the user mentions they work with a team and want others to see the roadmap, mention that PPGantt's `sync/sync.py` supports an optional `PPGANTT_ROADMAP_PATH` env var that writes the synced JSON to a second location and git-commits it. Useful for keeping a shared repo in sync.

Pattern: create a separate private git repo for shared team files, add `PPGANTT_ROADMAP_PATH=/path/to/team-repo/roadmap/roadmap.json` to `sync/.env`. Every sync auto-commits + pushes to the team repo.

See `sync/.env.example` for the setup.

---

## Detecting demo vs real data programmatically

You can check whether a user is still on the default fixtures:

```js
// In the viewer, any roadmap JSON with source.is_simulation === true
// is a shipped demo. If the user's active roadmap has is_simulation: true,
// they haven't imported their own data yet.
```

Use this flag to decide whether to prompt the user with "ready to import your own data?" or stay out of their way.

## Don't do these things

- **Don't import the user's real data on top of the demo without warning them.** Ask first.
- **Don't commit the user's real data to any public repo.** Their `data/<slug>.json` is theirs — it should either go to a private git repo they own, or stay uncommitted locally.
- **Don't delete `_fixture.json` / `_fixture2.json` without confirming.** These are useful references for how the JSON contract should look. Move them to `data/_archived_fixtures/` instead of deleting.
- **Don't assume the user knows git.** Walk them through each commit explicitly. Explain what `git add` and `git commit` do if they're unfamiliar.
- **Don't run `sync.py` or any command without showing the user the command first.** They need to see what's happening so they can learn the tool.

## When to refer to other files

- `README.md` — high-level overview, features, install instructions. Good for context.
- `agent.md` — rules for agents *modifying* PPGantt's codebase (not onboarding users). Read if you need to touch source files.
- `sync/.env.example` — environment variable template for the sync CLI.
- `data/_fixture.json` — canonical example of the JSON contract. Point users here when explaining the schema.

---

**End of onboarding playbook.**
