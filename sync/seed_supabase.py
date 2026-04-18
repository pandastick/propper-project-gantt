#!/usr/bin/env python3
"""
seed_supabase.py
================

Standalone seed-SQL generator for the PPGantt Supabase pivot.

Reads `data/roadmap.json` (the Societist roadmap produced by `sync.py`) and
emits a single, idempotent Postgres migration at

    supabase/migrations/20260418_0005_ppgantt_seed_societist.sql

The migration populates the `public.projects`, `public.project_members`,
`ppgantt.phases`, `ppgantt.streams`, `ppgantt.tasks`,
`ppgantt.task_dependencies`, and `ppgantt.notion_schema_mappings` tables
created by migrations 0001-0004.

Two placeholder tokens are left in the emitted SQL for the orchestrator to
substitute via `sed` at apply time (after Peter has signed up via magic link
and his `auth.users.id` is known):

    $SEED_CREATED_BY_UUID$   Peter's auth.users.id (used for created_by,
                             updated_by, and the owner project_members row)
    $SEED_NOW_ISO$           ISO-8601 timestamp used as
                             last_pulled_from_notion_at on every task row

Usage
-----
    python3 sync/seed_supabase.py

No side effects beyond writing the SQL file and printing a summary.  Does
not touch the live database.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# -----------------------------------------------------------------------------
# Paths
# -----------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
ROADMAP_PATH = PROJECT_ROOT / "data" / "roadmap.json"
MIGRATIONS_DIR = PROJECT_ROOT / "supabase" / "migrations"
OUTPUT_PATH = MIGRATIONS_DIR / "20260418_0005_ppgantt_seed_societist.sql"

# -----------------------------------------------------------------------------
# Project-level constants
# -----------------------------------------------------------------------------
PROJECT_SLUG = "societist"
PROJECT_NAME = "Societist"
PROJECT_COLOR = "#3B82F6"   # matches "Phase 2A - User Features" accent
PROJECT_ICON = None          # no icon yet

PLACEHOLDER_USER = "$SEED_CREATED_BY_UUID$"
PLACEHOLDER_NOW = "$SEED_NOW_ISO$"


# -----------------------------------------------------------------------------
# SQL literal helpers
# -----------------------------------------------------------------------------
def sql_text(value) -> str:
    """
    Render a Python value as a Postgres string literal, or NULL.

    Uses dollar-quoting with a tag that is guaranteed not to collide with the
    contents (we pick a random-ish tag and fall back by increasing the tag
    length if we ever see a collision).  Dollar-quoting means we never need
    to escape quotes, backslashes, newlines, or non-ASCII characters.
    """
    if value is None:
        return "NULL"
    if not isinstance(value, str):
        value = str(value)
    tag = "txt"
    # Defensive: bump the tag until it is unique w.r.t. the value.  In
    # practice `$txt$` never appears in roadmap notes, but this keeps us
    # robust against future pathological content.
    while f"${tag}$" in value:
        tag += "x"
    # Postgres dollar-quoting syntax is `$tag$content$tag$` — single `$`
    # on each side of the tag name, NOT double.  `$$tag$$...` would parse
    # as an empty-tag dollar-quote (`$$`) around the literal word `tag`,
    # not a tagged dollar-quote.
    return f"${tag}${value}${tag}$"


def sql_date(value) -> str:
    """Render a YYYY-MM-DD string as a DATE literal, or NULL."""
    if value is None or value == "":
        return "NULL"
    return f"DATE {sql_text(value)}"


def sql_number(value) -> str:
    """Render a numeric value, or NULL."""
    if value is None:
        return "NULL"
    return str(value)


def sql_bool(value) -> str:
    """Render a boolean, or NULL."""
    if value is None:
        return "NULL"
    return "TRUE" if value else "FALSE"


def sql_uuid_literal(value) -> str:
    """Render a UUID string as a quoted literal cast to uuid."""
    if value is None:
        return "NULL"
    return f"'{value}'::uuid"


def sql_jsonb(value) -> str:
    """Render a Python dict/list as a JSONB literal via dollar-quoting."""
    dumped = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return f"{sql_text(dumped)}::jsonb"


# -----------------------------------------------------------------------------
# Load the source roadmap
# -----------------------------------------------------------------------------
def load_roadmap() -> dict:
    if not ROADMAP_PATH.exists():
        print(f"ERROR: roadmap.json not found at {ROADMAP_PATH}", file=sys.stderr)
        sys.exit(1)
    with ROADMAP_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)


# -----------------------------------------------------------------------------
# Stream extraction
# -----------------------------------------------------------------------------
def extract_streams(tasks: list[dict]) -> list[str]:
    """Unique stream names in order of first appearance."""
    seen = set()
    ordered: list[str] = []
    for task in tasks:
        stream = (task.get("meta") or {}).get("stream")
        if stream and stream not in seen:
            seen.add(stream)
            ordered.append(stream)
    return ordered


# -----------------------------------------------------------------------------
# Dependency extraction
# -----------------------------------------------------------------------------
def extract_dependencies(
    tasks: list[dict],
) -> tuple[list[tuple[str, str]], list[str]]:
    """
    Returns (edges, warnings).

    edges is a list of (blocked_task_id, blocker_task_id) tuples, deduped
    and with self-references / orphan references removed.  warnings is a
    human-readable list describing every skipped edge, emitted as SQL
    comments in the final migration.
    """
    all_task_ids = {t["id"] for t in tasks}
    edges: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    warnings: list[str] = []

    for task in tasks:
        blocked_id = task["id"]
        raw = task.get("dependencies") or ""
        if not raw:
            continue
        for blocker_raw in raw.split(","):
            blocker_id = blocker_raw.strip()
            if not blocker_id:
                continue
            if blocker_id == blocked_id:
                warnings.append(
                    f"SKIPPED self-reference: task {blocked_id} "
                    f"listed itself as a dependency."
                )
                continue
            if blocker_id not in all_task_ids:
                warnings.append(
                    f"SKIPPED orphan dependency: task {blocked_id} depends "
                    f"on {blocker_id}, which is not in the imported task set."
                )
                continue
            edge = (blocked_id, blocker_id)
            if edge in seen:
                continue
            seen.add(edge)
            edges.append(edge)

    return edges, warnings


# -----------------------------------------------------------------------------
# SQL block builders
# -----------------------------------------------------------------------------
def build_header(roadmap: dict, generated_at_iso: str) -> str:
    src = roadmap.get("source", {})
    return f"""-- =============================================================================
-- Migration: 20260418_0005_ppgantt_seed_societist
-- Tool:      PPGantt
-- Project:   wzzjozdljxhmrmscevlh  (shared Supabase project)
--
-- AUTO-GENERATED.  Do not hand-edit.
--
-- Generated by:  sync/seed_supabase.py
-- Source:        data/roadmap.json
--                (Notion data source: {src.get("data_source_id", "?")})
--                synced_at: {src.get("synced_at", "?")}
-- Generated at:  {generated_at_iso}
--
-- Placeholders (substituted by the orchestrator at apply time via `sed`):
--   $SEED_CREATED_BY_UUID$   Peter's auth.users.id.  Used as the creator of
--                            the project row, owner membership, and the
--                            created_by / updated_by on every seeded task.
--                            Must exist in auth.users BEFORE this migration
--                            runs (sign-up via magic link first).
--   $SEED_NOW_ISO$           ISO-8601 timestamp used for
--                            last_pulled_from_notion_at on every task (the
--                            moment of the seed import).
--
-- Idempotency
-- -----------
-- Every INSERT uses ON CONFLICT DO NOTHING (or DO UPDATE for the Notion
-- schema mapping row, which is expected to evolve).  The whole migration
-- runs inside a single transaction; a mid-flight failure rolls everything
-- back cleanly.
--
-- Out of scope for this file
-- --------------------------
--   * Schema DDL               → 20260418_0001..0004
--   * RLS policies             → 20260418_0002 and 0004
--   * auth.users row creation  → Supabase magic-link signup (manual, pre-apply)
-- =============================================================================

BEGIN;
"""


def build_project_block() -> str:
    return f"""
-- -----------------------------------------------------------------------------
-- public.projects — one row for the Societist roadmap
-- -----------------------------------------------------------------------------
INSERT INTO public.projects (slug, name, color, icon, created_by)
VALUES (
  {sql_text(PROJECT_SLUG)},
  {sql_text(PROJECT_NAME)},
  {sql_text(PROJECT_COLOR)},
  {sql_text(PROJECT_ICON)},
  {sql_uuid_literal(PLACEHOLDER_USER)}
)
ON CONFLICT (slug) DO NOTHING;

-- -----------------------------------------------------------------------------
-- public.project_members — Peter as owner of the Societist project
-- -----------------------------------------------------------------------------
INSERT INTO public.project_members (project_id, user_id, role)
SELECT id, {sql_uuid_literal(PLACEHOLDER_USER)}, 'owner'
FROM public.projects
WHERE slug = {sql_text(PROJECT_SLUG)}
ON CONFLICT DO NOTHING;
"""


def build_phases_block(phase_palette: dict) -> str:
    lines = [
        "",
        "-- -----------------------------------------------------------------------------",
        "-- ppgantt.phases — one row per entry in roadmap.json:phase_palette",
        "-- Sort order follows the palette definition order.",
        "-- -----------------------------------------------------------------------------",
        "WITH project AS (",
        f"  SELECT id FROM public.projects WHERE slug = {sql_text(PROJECT_SLUG)}",
        ")",
        "INSERT INTO ppgantt.phases (project_id, name, color, sort_order)",
        "VALUES",
    ]
    value_rows = []
    for idx, (name, color) in enumerate(phase_palette.items()):
        value_rows.append(
            f"  ((SELECT id FROM project), {sql_text(name)}, {sql_text(color)}, {idx})"
        )
    lines.append(",\n".join(value_rows))
    lines.append("ON CONFLICT (project_id, name) DO NOTHING;")
    return "\n".join(lines) + "\n"


def build_streams_block(streams: list[str]) -> str:
    lines = [
        "",
        "-- -----------------------------------------------------------------------------",
        "-- ppgantt.streams — unique streams discovered across tasks[].meta.stream",
        "-- Sort order follows the order each stream first appears in the task list.",
        "-- -----------------------------------------------------------------------------",
        "WITH project AS (",
        f"  SELECT id FROM public.projects WHERE slug = {sql_text(PROJECT_SLUG)}",
        ")",
        "INSERT INTO ppgantt.streams (project_id, name, sort_order)",
        "VALUES",
    ]
    value_rows = []
    for idx, stream in enumerate(streams):
        value_rows.append(
            f"  ((SELECT id FROM project), {sql_text(stream)}, {idx})"
        )
    lines.append(",\n".join(value_rows))
    lines.append("ON CONFLICT (project_id, name) DO NOTHING;")
    return "\n".join(lines) + "\n"


def build_tasks_block(tasks: list[dict]) -> str:
    """
    Emits one INSERT per task.  Per-task INSERTs (rather than one giant
    multi-row VALUES) keep each row self-contained and easier to debug if a
    single row fails a CHECK constraint.  All rows use the same three CTEs
    (project / phase / stream) which Postgres re-plans per statement, so the
    cost is tiny at 69 rows.
    """
    chunks = [
        "",
        "-- -----------------------------------------------------------------------------",
        "-- ppgantt.tasks — 69 roadmap rows from roadmap.json:tasks[]",
        "-- Each task reuses the Notion page UUID as the ppgantt.tasks.id PK.",
        "-- notion_page_id mirrors id so bidirectional Notion sync can find the row.",
        "-- created_by / updated_by / last_pulled_from_notion_at use placeholders the",
        "-- orchestrator substitutes at apply time.",
        "-- -----------------------------------------------------------------------------",
    ]

    for task in tasks:
        meta = task.get("meta") or {}
        task_id = task["id"]
        name = task.get("name")
        start = task.get("start")
        end = task.get("end")
        progress = task.get("progress", 0)

        phase = meta.get("phase")
        stream = meta.get("stream")
        owner_label = meta.get("owner")
        status = meta.get("status")
        risk_level = meta.get("risk_level")
        is_milestone = meta.get("is_milestone", False)
        critical_path = meta.get("critical_path", False)
        slack_days = meta.get("slack_days")
        duration_days = meta.get("duration_days")
        duration_text = meta.get("duration_text")
        reference = meta.get("reference")
        notes = meta.get("notes")
        notion_url = meta.get("notion_url")

        # Risk-level: if the roadmap stores 'None' keep it (schema accepts it).
        # If it is an empty string or some other unexpected value, force NULL
        # so we do not violate the CHECK constraint.
        allowed_risks = {"None", "Low", "Medium", "High", "Critical"}
        if risk_level not in allowed_risks:
            risk_level = None

        chunks.append(
            f"""
-- Task: {task_id}
WITH
  project AS (
    SELECT id FROM public.projects WHERE slug = {sql_text(PROJECT_SLUG)}
  ),
  phase AS (
    SELECT id FROM ppgantt.phases
    WHERE project_id = (SELECT id FROM project)
      AND name = {sql_text(phase)}
  ),
  stream AS (
    SELECT id FROM ppgantt.streams
    WHERE project_id = (SELECT id FROM project)
      AND name = {sql_text(stream)}
  )
INSERT INTO ppgantt.tasks (
  id, project_id,
  name, start_date, end_date, progress,
  phase_id, stream_id, owner_label,
  status, risk_level, is_milestone, critical_path,
  slack_days, duration_days, duration_text,
  reference, notes,
  notion_page_id, notion_url,
  last_pulled_from_notion_at, last_pushed_to_notion_at, notion_sync_status,
  created_by, updated_by
) VALUES (
  {sql_uuid_literal(task_id)}, (SELECT id FROM project),
  {sql_text(name)}, {sql_date(start)}, {sql_date(end)}, {sql_number(progress)},
  (SELECT id FROM phase), (SELECT id FROM stream), {sql_text(owner_label)},
  {sql_text(status)}, {sql_text(risk_level)}, {sql_bool(is_milestone)}, {sql_bool(critical_path)},
  {sql_number(slack_days)}, {sql_number(duration_days)}, {sql_text(duration_text)},
  {sql_text(reference)}, {sql_text(notes)},
  {sql_text(task_id)}, {sql_text(notion_url)},
  {sql_text(PLACEHOLDER_NOW)}::timestamptz, NULL, 'clean',
  {sql_uuid_literal(PLACEHOLDER_USER)}, {sql_uuid_literal(PLACEHOLDER_USER)}
)
ON CONFLICT (id) DO NOTHING;
"""
        )

    return "\n".join(chunks)


def build_dependencies_block(
    edges: list[tuple[str, str]], warnings: list[str]
) -> str:
    lines = [
        "",
        "-- -----------------------------------------------------------------------------",
        "-- ppgantt.task_dependencies — edges from tasks[].dependencies",
        "-- One row per (blocked, blocker).  Self-references and edges to task",
        "-- IDs outside the imported set are skipped; see warnings below.",
        "-- -----------------------------------------------------------------------------",
    ]

    for warning in warnings:
        lines.append(f"-- WARNING: {warning}")

    if not edges:
        lines.append("-- (No valid dependency edges to insert.)")
        return "\n".join(lines) + "\n"

    lines.append(
        "INSERT INTO ppgantt.task_dependencies (blocked_task_id, blocker_task_id)"
    )
    lines.append("VALUES")
    rendered = [
        f"  ({sql_uuid_literal(blocked)}, {sql_uuid_literal(blocker)})"
        for (blocked, blocker) in edges
    ]
    lines.append(",\n".join(rendered))
    lines.append("ON CONFLICT DO NOTHING;")
    return "\n".join(lines) + "\n"


def build_mapping_block(roadmap: dict) -> str:
    """
    Insert one row into ppgantt.notion_schema_mappings for the Societist
    project.  Uses ON CONFLICT DO UPDATE so re-running refreshes the mapping
    and palette (but not notion_db_id, which is the project's identity).
    """
    source = roadmap.get("source", {})
    raw_data_source_id = source.get("data_source_id", "")
    # Strip "collection://" prefix so we store the clean UUID.
    notion_db_id = raw_data_source_id
    prefix = "collection://"
    if notion_db_id.startswith(prefix):
        notion_db_id = notion_db_id[len(prefix):]

    mapping = roadmap.get("schema_mapping", {})
    phase_palette = roadmap.get("phase_palette", {})

    return f"""
-- -----------------------------------------------------------------------------
-- ppgantt.notion_schema_mappings — one row for the Societist project.
-- notion_db_id strips the 'collection://' prefix from roadmap.source.data_source_id.
-- Re-running this migration refreshes `mapping` and `phase_palette` in place.
-- -----------------------------------------------------------------------------
INSERT INTO ppgantt.notion_schema_mappings (
  project_id, notion_db_id, mapping, phase_palette
)
SELECT
  id,
  {sql_text(notion_db_id)},
  {sql_jsonb(mapping)},
  {sql_jsonb(phase_palette)}
FROM public.projects
WHERE slug = {sql_text(PROJECT_SLUG)}
ON CONFLICT (project_id) DO UPDATE
  SET mapping = EXCLUDED.mapping,
      phase_palette = EXCLUDED.phase_palette,
      updated_at = now();
"""


def build_footer() -> str:
    return """
COMMIT;

-- End of 20260418_0005_ppgantt_seed_societist.sql
"""


# -----------------------------------------------------------------------------
# Orchestration
# -----------------------------------------------------------------------------
def main() -> None:
    roadmap = load_roadmap()
    tasks = roadmap.get("tasks", [])
    phase_palette = roadmap.get("phase_palette", {})
    streams = extract_streams(tasks)
    edges, warnings = extract_dependencies(tasks)

    generated_at_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")

    parts: list[str] = [
        build_header(roadmap, generated_at_iso),
        build_project_block(),
        build_phases_block(phase_palette),
        build_streams_block(streams),
        build_tasks_block(tasks),
        build_dependencies_block(edges, warnings),
        build_mapping_block(roadmap),
        build_footer(),
    ]
    output = "".join(parts)

    MIGRATIONS_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(output, encoding="utf-8")

    print(f"Wrote {OUTPUT_PATH}")
    print("  phases:       ", len(phase_palette))
    print("  streams:      ", len(streams))
    print("  tasks:        ", len(tasks))
    print("  dependencies: ", len(edges))
    print("  skipped deps: ", len(warnings))
    if warnings:
        for w in warnings:
            print("    -", w)


if __name__ == "__main__":
    main()
