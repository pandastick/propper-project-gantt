# PPGantt — Agent Rules

> Rules for any AI coding agent (Claude Code, Cursor, etc.) working on this project. Read this before making changes.

## Context

PPGantt is a local-first Gantt chart viewer that syncs from Notion databases, simulates schedule changes with slack-aware critical path propagation, and exports change logs as Notion-MCP-ready prompts for manual write-back.

## Non-Negotiables

1. **The JSON contract in this file is LOCKED.** Every component (sync, viewer, simulator, change log) must conform to it. If you need to change the contract, stop and ask the maintainer — changing it in one place breaks everything.

2. **No two-way sync to Notion.** The tool is read-only from Notion. Write-back is manual via the change log export → paste into a separate Claude Code session → MCP writes. This is a deliberate safety valve, not a limitation waiting to be removed.

3. **Local-first.** Everything runs on the user's machine. No cloud, no auth, no accounts, no SaaS. Python for sync only. Browser for viewer. That's it.

4. **Simulation is non-destructive.** Simulating a push NEVER modifies `data/*.json`. All simulation state is browser-memory only (sessionStorage).

5. **Frappe Gantt is the rendering library.** Vendored into `js/` and `css/`. MIT license. Do not swap it for another library.

6. **Safari-compatible.** Opening `index.html` via `file://` must work without any server running, without npm install, without Python. The JSONP `.js` shims in `data/` exist for this reason — regenerate them alongside JSON files in the sync pipeline.

## JSON Contract

Every task in a synced JSON file has this shape:

```json
{
  "id": "notion-page-uuid",
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
    "notion_url": "..."
  }
}
```

The top-level file wraps a `tasks` array alongside `source`, `schema_mapping`, and `phase_palette` metadata. See `data/_fixture.json` for a complete minimal example.

## Development Fixture

`data/_fixture.json` is a hand-written 12-task fixture covering all 7 phases, critical + off-path tasks, slack variations, milestones, risk levels, and a diamond dependency (fix-010 is blocked by both fix-008 and fix-009). Build and test against this fixture — it's designed to exercise every visual and logical code path.

`data/_fixture2.json` is the same fixture with a 14-day push applied, useful for testing the overlay mode.

## Visual Dimensions (all 6 must render)

1. **Phase** → bar fill color
2. **Completion %** → progress bar fill inside the bar
3. **Critical Path** → thick border
4. **Risk Level** → outer glow (none/yellow/orange/red)
5. **Is Milestone** → diamond shape
6. **Slack days** → ghost tail after bar end

## Simulation Algorithm

Slack-aware topological cascade. Key points:

- Topologically sort from the pushed task through its dependents
- For each downstream task, `effectivePush = max(0, predecessorPush - task.slack_days)`
- Tasks with slack ≥ push amount do NOT move
- Cycle detection must throw a UI error, not silently ignore

See `js/simulator.js` for the full implementation and `tests/test_cascade.js` for the 9-test coverage matrix.

## Testing

```bash
node tests/test_cascade.js   # JS simulator tests
node js/change-log.js        # change-log self-test
sync/.venv/bin/python -m pytest tests/ -q   # Python sync tests
```

51 passing tests total. All tests run offline against the fixture — no API calls.

## Setting Up For A New User

If you're an AI agent helping a new user onboard:

1. Ask them for a Notion database URL they want to track as a Gantt chart
2. Help them get a Notion integration token at `notion.so/my-integrations`
3. Help them share the target database with the integration
4. Set up the Python sync venv and `.env` with their keys
5. Run a first sync — the LLM-assisted schema mapper will ask them to confirm field mappings, then cache the result
6. Open the viewer (`npm start` or `python3 -m http.server 8080`)

The tool is designed so that a single sync gets someone from "I have a Notion database" to "I'm looking at a live Gantt chart with slack simulation" in under 5 minutes.

## When In Doubt

Read `js/simulator.js` and `data/_fixture.json` — most architectural questions answer themselves once you see the cascade logic running against the reference fixture. If you're still stuck, open a GitHub issue rather than guessing.
