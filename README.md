# Propper Project Gantt (PPGantt)

A local-first Gantt chart viewer with slack-aware schedule simulation. Reads a Notion database (or any JSON matching the schema below), renders an interactive chart in your browser, and lets you push tasks around and watch the critical path cascade — then exports the proposed changes as a markdown prompt you can paste back into Notion via MCP.

**PPGantt shows you what your project *will* take — not what it should have been.**

## New here?

After you clone, open the repo in an AI coding agent (Claude Code, Cursor, Windsurf, Codex) and say:

> "Onboard me onto PPGantt"

The agent will read [`ONBOARDING.md`](ONBOARDING.md), walk you through the demo fixture, help you import your own roadmap (Notion sync, a JSON you already have, or from scratch), and remove the demo once you're ready. Ten minutes, end-to-end.

If you don't use AI agents, the Quick Start below gets you to the demo; after that, see `ONBOARDING.md` for the manual import steps.

## What It Does

| Capability | What It Looks Like |
|------------|--------------------|
| **Render** | Frappe Gantt chart with 7-phase color coding, dependency arrows, critical-path borders, risk glows, milestones, slack tails |
| **Simulate** | Click a bar → "push by N days" → slack-aware cascade recomputes which downstream tasks actually move. Non-destructive, browser-only. |
| **Overlay** | Stack multiple roadmap scenarios as transparent layers with hue-shifted phase colors and per-layer opacity |
| **Export** | One click copies a change log to your clipboard as a Notion-MCP-ready markdown prompt, for manual write-back via a fresh Claude Code session |

- **Click** any task → popup with all meta fields
- **Zoom** between Day / Week / Month / Quarter
- **Checkbox** multiple files in the sidebar → they stack as overlay layers
- **Push** a task by N days → ghost bars show where things used to be

## Privacy & Security

PPGantt runs **100% locally**. No external API calls from the viewer, no analytics, no telemetry. The Python sync layer (optional) talks to Notion and Anthropic only when you explicitly run `sync/sync.py`.

The entire viewer is under 4,000 lines of vanilla JS across six files you can audit in an afternoon. The only runtime dependency is Express (to serve static files on localhost) — or no dependency at all if you open `index.html` directly in Safari.

## Quick Start

```bash
git clone https://github.com/pandastick/propper-project-gantt.git
cd propper-project-gantt
npm install
npm start
```

Open `http://localhost:8080` in your browser. You'll see the 12-task dev fixture covering all 7 phases, slack variations, critical + off-path tasks, milestones, and a diamond dependency.

### Set Your Port

Pick a port you'll remember and save it in `.env`:

```bash
echo "PORT=8080" > .env
```

### Zero-Install Alternative

The viewer is fully static. If you don't want Node.js, you have two options:

```bash
# Option 1: Python HTTP server (any Python 3 install works)
python3 -m http.server 8080

# Option 2: Open the file directly in Safari
open index.html
```

Both paths load the fixture from the local `data/` folder. DATA_DIR and the `/api/*` endpoints are only available via `npm start`.

### Private Data Directory

By default, PPGantt reads roadmap JSON files from the local `data/` folder. If you want to keep your real project data outside the repo — for example in a Dropbox/iCloud folder, or a private sibling repo — set `DATA_DIR` in your `.env`:

```bash
echo "PORT=8080" > .env
echo "DATA_DIR=/absolute/path/to/your/ppgantt-data" >> .env
```

The server will load `_manifest.json` and individual roadmap files from there instead. This is the recommended pattern if you use PPGantt as your daily driver — it keeps your real schedules outside any Git history.

## Syncing from Notion

PPGantt includes an optional Python sync CLI that reads a Notion database, maps its schema to PPGantt's canonical fields (LLM-assisted on first run, cached after), and writes a JSON file matching the contract below.

### Setup

```bash
cd sync
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
# Edit .env with your NOTION_API_KEY and ANTHROPIC_API_KEY
```

Get a Notion integration token at [notion.so/my-integrations](https://www.notion.so/my-integrations) (make sure you share your target database with the integration). Anthropic API keys live at [console.anthropic.com](https://console.anthropic.com).

### Sync a database

```bash
cd sync
.venv/bin/python sync.py "<your-notion-db-url>" --output-name=<your-slug>
```

On first sync against a new database, Claude Sonnet maps the Notion schema to PPGantt's canonical fields. You'll see the proposed mapping and confirm with `y`. The mapping is cached to `data/_schema_cache/` so subsequent syncs skip the LLM call entirely.

The sync uses the Notion REST API directly (not MCP) — 100 rows per call, so most databases sync in a single request. Output goes to `data/<slug>.json`, the registry is updated in `data/_manifest.json`, and an append-only log is written to `logs/sync-history.jsonl`.

## How It Works

Six layers, each with one job:

1. **Notion** — your source of truth, read-only from PPGantt's side
2. **Sync agent** (Python + Claude Sonnet, optional) — fetches rows, maps the schema, resolves dependencies, writes JSON
3. **Local JSON** — hand-editable files in `data/` matching the contract below
4. **Static viewer** (Frappe Gantt + vanilla JS) — renders the chart with 6 visual dimensions
5. **Simulation sandbox** — slack-aware cascade in browser memory, never touches the JSON files
6. **Change log export** — markdown prompt for Notion write-back via MCP

The canonical JSON contract is:

```json
{
  "source": {
    "notion_url": "...",
    "data_source_id": "...",
    "table_name": "...",
    "synced_at": "2026-04-09T13:00:00Z",
    "row_count": 12
  },
  "schema_mapping": { "...": "canonical field names" },
  "phase_palette": {
    "Phase 1 - Foundation": "#F59E0B",
    "Phase 2 - Build": "#3B82F6"
  },
  "tasks": [
    {
      "id": "notion-page-uuid",
      "name": "Task name",
      "start": "2026-04-14",
      "end": "2026-04-18",
      "progress": 0,
      "dependencies": "other-task-id,another-one",
      "custom_class": "phase-1 critical-path risk-high",
      "meta": {
        "phase": "Phase 1 - Foundation",
        "risk_level": "High",
        "critical_path": true,
        "is_milestone": false,
        "slack_days": 0,
        "duration_days": 5,
        "notion_url": "..."
      }
    }
  ]
}
```

The dev fixture (`data/_fixture.json`) is a complete minimal example — 12 tasks, 7 phases, all 6 visual dimensions exercised, one diamond dependency. Everything the viewer does can be tested against it.

## Visual Dimensions

| Dimension | How It Renders |
|-----------|----------------|
| **Phase** | Bar fill color (from `phase_palette`) |
| **Completion %** | Progress bar inside the bar |
| **Critical Path** | Thick border |
| **Risk Level** | Outer glow (none/yellow/orange/red) |
| **Is Milestone** | Diamond shape instead of bar |
| **Slack days** | Ghost tail extending past the bar end |

## Simulation Algorithm

Click any bar → "Push by N days" → the simulator runs a slack-aware topological cascade:

1. Topologically sort the pushed task and all its dependents
2. For each downstream task: `effectivePush = max(0, predecessorPush - task.slack_days)`
3. Tasks with enough slack do **not** move
4. Others move and the push propagates to their dependents
5. Re-render with ghost bars showing where tasks started
6. Every move is recorded in the change log

All simulation state lives in `sessionStorage`. Refreshing the page discards the simulation. The underlying `data/*.json` files are never modified.

Cycle detection throws a UI error — it will not silently ignore circular dependencies.

## Multi-File & Overlay Mode

Check multiple JSON files in the sidebar to stack them as transparent layers:

- Synchronized scrolling (they share the same scrollable parent)
- Hue-shifted phase colors for non-primary layers (60° per layer) so overlapping phases stay distinguishable
- Per-layer opacity sliders
- Synthetic anchor tasks force all layers onto the same x-axis so bars align in pixel space

Use this to compare two scenarios ("what if we push the build phase back?") or two different projects side-by-side.

## Running Tests

### JavaScript
```bash
node tests/test_cascade.js   # 9 simulator tests
node js/change-log.js        # change-log self-test (7 assertions)
```

### Python
```bash
cd sync
.venv/bin/pip install pytest
cd ..
sync/.venv/bin/python -m pytest tests/test_blocked_by.py tests/test_schema_mapper.py -q
```

51 passing tests total across the stack.

## File Structure

```
propper-project-gantt/
  server.js              Express server with DATA_DIR support (~60 lines)
  package.json           Just express
  index.html             Main viewer
  css/
    frappe-gantt.css     Vendored v0.6.1 (MIT)
    gantt-custom.css     Phase colors, glows, milestones, slack tails
    overlay.css          Sidebar + multi-layer stacking
  js/
    frappe-gantt.min.js  Vendored v0.6.1 (MIT)
    viewer.js            Single-chart renderer
    simulator.js         Slack-aware cascade + ghost rendering
    change-log.js        Markdown export for Notion MCP prompts
    loader.js            Manifest + multi-file loader
    overlay.js           Multi-layer stacking + hue shifting
  sync/
    sync.py              CLI entry point
    notion_fetcher.py    Notion REST client
    schema_mapper.py     LLM-powered schema mapping with cache
    requirements.txt
    .env.example
  data/
    _fixture.json        12-task dev fixture
    _fixture.js          Same fixture as a file:// shim
    _fixture2.json       Second fixture with 14-day push applied
    _manifest.json       Registry of available data files
  tests/
    test_cascade.js      9 simulator tests
    test_blocked_by.py   26 dependency resolution tests
    test_schema_mapper.py 9 schema mapper tests
```

## Non-Negotiables

- **Local-first.** Runs entirely on your machine. No cloud, no auth, no accounts.
- **Read-only from Notion.** Write-back is manual: change log → clipboard → fresh Claude Code session → MCP.
- **Simulation is non-destructive.** Never modifies `data/*.json`.
- **Safari-compatible.** The viewer works opening `index.html` via `file://` — no server required for read-only use.

## Contributing

PRs welcome. Keep it simple — this is intentionally a lightweight tool. Don't add build steps, bundlers, or framework dependencies without a very good reason.

## License

MIT (see LICENSE). Frappe Gantt is MIT-licensed and vendored into `js/` and `css/`.
