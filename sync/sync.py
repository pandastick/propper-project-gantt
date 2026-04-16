#!/usr/bin/env python3
"""
sync.py — PPGantt Notion sync CLI.

Usage:
    python sync/sync.py <notion-url> [--output-name=slug]

Examples:
    python sync/sync.py https://www.notion.so/your-workspace/your-database-id
    python sync/sync.py https://www.notion.so/... --output-name=my-project

What it does:
    1. Fetch the Notion database schema.
    2. Map the schema to PPGantt canonical fields (LLM-assisted, cached).
    3. Fetch all pages from the database (paginated).
    4. Two-pass resolve "Blocked by" relation URLs -> task IDs.
    5. Normalise rows into the JSON contract (plan §6).
    6. Write data/<slug>.json.
    7. Update data/_manifest.json.
    8. Append to logs/sync-history.jsonl.

Requirements:
    - .env file in sync/ with NOTION_API_KEY and ANTHROPIC_API_KEY
    - Python 3.11+
    - pip install -r sync/requirements.txt
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

# Load .env from the sync/ directory regardless of where the script is called from
_SYNC_DIR = Path(__file__).parent.resolve()
_PROJECT_DIR = _SYNC_DIR.parent
load_dotenv(_SYNC_DIR / ".env")

# Now safe to import our modules
from notion_fetcher import (  # noqa: E402  (module in same dir)
    NotionDatabaseClient,
    extract_property_value,
    extract_relation_page_ids,
    _extract_database_id,
)
from schema_mapper import get_schema_mapping  # noqa: E402

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CANONICAL_PHASE_PALETTE = {
    "Phase 0.5 - Security": "#E03E3E",
    "Phase 1 - Foundation": "#F59E0B",
    "Phase 2A - User Features": "#3B82F6",
    "Phase 2B - Infrastructure": "#8B5CF6",
    "Phase 2C - White-Label": "#EC4899",
    "Phase 3 - Integration": "#10B981",
    "App Store Track": "#EAB308",
}

FALLBACK_PHASE_COLOR = "#6B7280"  # Tailwind gray-500

DATA_DIR = _PROJECT_DIR / "data"
LOGS_DIR = _PROJECT_DIR / "logs"
MANIFEST_PATH = DATA_DIR / "_manifest.json"
SYNC_LOG_PATH = LOGS_DIR / "sync-history.jsonl"


# ---------------------------------------------------------------------------
# Slug helpers
# ---------------------------------------------------------------------------

def _slugify(text: str) -> str:
    """Convert a string to a URL-safe slug."""
    text = text.lower().strip()
    # Replace spaces and special chars with dashes
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text)
    text = text.strip("-")
    return text


def _phase_slug(phase_name: str) -> str:
    """
    Convert a phase name to a CSS class suffix (without the "phase-" prefix).
    The full class is assembled in _compose_custom_class as "phase-<slug>".

    E.g. "Phase 2A - Storefront" -> "2a-storefront"
         "Phase 0.5 - Security"   -> "05-security"
         "Launch Track"           -> "launch-track"

    We strip a leading "phase-" token if present so the prefix isn't doubled.
    """
    slug = _slugify(phase_name)
    if slug.startswith("phase-"):
        slug = slug[len("phase-"):]
    return slug


# ---------------------------------------------------------------------------
# custom_class composition
# ---------------------------------------------------------------------------

def _compose_custom_class(phase: str, critical: bool, risk: str, milestone: bool) -> str:
    """
    Build the space-separated custom_class string per plan §6.1 rule 5.

    - phase-<slug> from the Phase field
    - critical-path if Critical Path is true
    - risk-<lowercased> from Risk Level
    - milestone if Is Milestone is true
    """
    parts = []
    if phase:
        parts.append(f"phase-{_phase_slug(phase)}")
    if critical:
        parts.append("critical-path")
    if risk and risk.lower() != "none":
        parts.append(f"risk-{risk.lower().replace(' ', '-')}")
    if milestone:
        parts.append("milestone")
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Progress fallback (plan §6.1 rule 4)
# ---------------------------------------------------------------------------

_STATUS_PROGRESS = {
    "not started": 0,
    "in progress": 50,
    "done": 100,
}


def _resolve_progress(progress_val, status_val) -> int:
    """Return integer 0-100. Uses status as fallback if progress_val is None."""
    if progress_val is not None:
        try:
            return max(0, min(100, int(progress_val)))
        except (TypeError, ValueError):
            pass
    if status_val:
        return _STATUS_PROGRESS.get(status_val.lower(), 0)
    return 0


# ---------------------------------------------------------------------------
# Two-pass Blocked-by resolution
# ---------------------------------------------------------------------------

def _build_url_to_id_map(pages: list[dict]) -> dict[str, str]:
    """
    Pass 1: Build {notion_page_url: task_id} map.

    Notion page IDs are in page["id"] (UUID with dashes).
    We build canonical URLs for each page so we can match against
    the URLs that appear in relation properties.
    """
    url_map: dict[str, str] = {}
    for page in pages:
        page_id = page.get("id", "")
        if not page_id:
            continue
        # Notion canonical URL pattern (dashes stripped in path)
        clean = page_id.replace("-", "")
        url_map[f"https://www.notion.so/{clean}"] = page_id
        # Also index the UUID itself (some relation values store ID directly)
        url_map[page_id] = page_id
        url_map[clean] = page_id
    return url_map


def _resolve_dependencies(
    relation_ids: list[str],
    url_to_id: dict[str, str],
    slug: str,
) -> str:
    """
    Pass 2: Convert a list of relation page IDs to a comma-separated
    dependency string of task IDs.

    Skips unresolvable references and logs a warning (plan Risk R6).
    """
    resolved = []
    for ref in relation_ids:
        if not ref:
            continue
        task_id = url_to_id.get(ref)
        if task_id is None:
            # Try stripping dashes
            clean = ref.replace("-", "")
            task_id = url_to_id.get(clean) or url_to_id.get(
                f"https://www.notion.so/{clean}"
            )
        if task_id:
            resolved.append(task_id)
        else:
            print(
                f"[sync] WARNING: Cannot resolve dependency reference '{ref}' "
                f"in '{slug}' — skipping (plan Risk R6).",
                file=sys.stderr,
            )
    return ",".join(resolved)


# ---------------------------------------------------------------------------
# Phase palette builder
# ---------------------------------------------------------------------------

def _build_phase_palette(phases_seen: set[str]) -> tuple[dict[str, str], list[str]]:
    """
    Build the phase_palette for the output JSON.
    Start from the canonical palette; add unknown phases with gray fallback.

    Returns (palette_dict, list_of_unknown_phases).
    """
    palette = dict(CANONICAL_PHASE_PALETTE)
    unknown = []
    for phase in phases_seen:
        if phase and phase not in palette:
            palette[phase] = FALLBACK_PHASE_COLOR
            unknown.append(phase)
    return palette, unknown


# ---------------------------------------------------------------------------
# Row normalisation
# ---------------------------------------------------------------------------

def _normalise_page(
    page: dict,
    mapping: dict,
    url_to_id: dict[str, str],
    slug: str,
) -> dict:
    """
    Convert a raw Notion page object into the PPGantt task dict (plan §6).
    """
    props = page.get("properties", {})
    page_id = page.get("id", "")

    def get_prop(mapping_key: str) -> tuple[str, dict]:
        """Return (notion_field_name, raw_prop_dict) for a canonical field."""
        field_name = mapping.get(mapping_key)
        if not field_name or field_name == "notion_page_id":
            return field_name, {}
        return field_name, props.get(field_name, {})

    # Name
    _, name_prop = get_prop("name_field")
    name = extract_property_value(name_prop) or "(Untitled)"

    # Dates
    _, start_prop = get_prop("start_field")
    start = extract_property_value(start_prop) or ""

    _, end_prop = get_prop("end_field")
    end = extract_property_value(end_prop) or ""

    # Ensure end >= start if end is missing
    if start and not end:
        end = start

    # Progress
    _, progress_prop = get_prop("progress_field")
    progress_val = extract_property_value(progress_prop)

    status_field, status_prop = get_prop("color_field")  # reuse color_field for status? No.
    # Status is not in the canonical mapping but we check it for progress fallback.
    # Look for a "status" type property in the page.
    status_val = None
    for prop_name, prop_data in props.items():
        if prop_data.get("type") == "status":
            status_val = extract_property_value(prop_data)
            break

    progress = _resolve_progress(progress_val, status_val)

    # Dependencies (relation)
    _, dep_prop = get_prop("dependencies_field")
    relation_ids = extract_relation_page_ids(dep_prop) if dep_prop else []
    dependencies = _resolve_dependencies(relation_ids, url_to_id, slug)

    # Phase (color_field)
    _, phase_prop = get_prop("color_field")
    phase = extract_property_value(phase_prop) or ""

    # Critical Path
    _, critical_prop = get_prop("critical_path_field")
    critical = bool(extract_property_value(critical_prop)) if critical_prop else False

    # Risk Level
    _, risk_prop = get_prop("risk_field")
    risk = extract_property_value(risk_prop) or "None"

    # Is Milestone
    _, milestone_prop = get_prop("milestone_field")
    milestone = bool(extract_property_value(milestone_prop)) if milestone_prop else False

    # Slack days
    _, slack_prop = get_prop("slack_field")
    slack_raw = extract_property_value(slack_prop) if slack_prop else None
    slack_days = int(slack_raw) if slack_raw is not None else None

    # Additional meta fields
    duration_text = None
    duration_days = None
    reference = None
    notes = None

    # Try to extract known extra fields by type scan
    for prop_name, prop_data in props.items():
        ptype = prop_data.get("type")
        val = extract_property_value(prop_data)
        lower = prop_name.lower()
        if "duration" in lower and ptype == "number" and duration_days is None:
            duration_days = val
        elif "duration" in lower and ptype in ("text", "rich_text") and duration_text is None:
            duration_text = val
        elif lower in ("reference", "ref") and ptype in ("text", "rich_text"):
            reference = val
        elif lower == "notes" and ptype in ("text", "rich_text"):
            notes = val

    # Stream / Owner
    stream = None
    owner = None
    for prop_name, prop_data in props.items():
        lower = prop_name.lower()
        ptype = prop_data.get("type")
        val = extract_property_value(prop_data)
        if lower == "stream" and ptype == "select":
            stream = val
        elif lower == "owner" and ptype == "select":
            owner = val

    # Notion page URL
    notion_url = f"https://www.notion.so/{page_id.replace('-', '')}"

    # custom_class
    custom_class = _compose_custom_class(phase, critical, risk, milestone)

    return {
        "id": page_id,
        "name": name,
        "start": start,
        "end": end,
        "progress": progress,
        "dependencies": dependencies,
        "custom_class": custom_class,
        "meta": {
            "phase": phase,
            "stream": stream,
            "owner": owner,
            "status": status_val,
            "risk_level": risk,
            "critical_path": critical,
            "is_milestone": milestone,
            "slack_days": slack_days,
            "duration_days": duration_days,
            "duration_text": duration_text,
            "reference": reference,
            "notes": notes,
            "notion_url": notion_url,
        },
    }


# ---------------------------------------------------------------------------
# Manifest management
# ---------------------------------------------------------------------------

def _load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        with MANIFEST_PATH.open() as f:
            return json.load(f)
    return {"version": 1, "generated_at": "", "files": []}


def _save_manifest(manifest: dict) -> None:
    manifest["generated_at"] = datetime.now(timezone.utc).isoformat()
    with MANIFEST_PATH.open("w") as f:
        json.dump(manifest, f, indent=2)


def _update_manifest(
    slug: str,
    table_name: str,
    notion_url: str,
    data_source_id: str,
    synced_at: str,
    row_count: int,
) -> None:
    manifest = _load_manifest()
    filename = f"{slug}.json"

    # Update existing entry or append
    for entry in manifest["files"]:
        if entry.get("filename") == filename:
            entry.update(
                {
                    "table_name": table_name,
                    "notion_url": notion_url,
                    "data_source_id": data_source_id,
                    "synced_at": synced_at,
                    "row_count": row_count,
                }
            )
            break
    else:
        manifest["files"].append(
            {
                "filename": filename,
                "table_name": table_name,
                "notion_url": notion_url,
                "data_source_id": data_source_id,
                "synced_at": synced_at,
                "row_count": row_count,
            }
        )

    _save_manifest(manifest)


# ---------------------------------------------------------------------------
# Sync history log
# ---------------------------------------------------------------------------

def _append_sync_log(
    notion_url: str,
    slug: str,
    row_count: int,
    success: bool,
    error: str = None,
) -> None:
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "notion_url": notion_url,
        "slug": slug,
        "row_count": row_count,
        "success": success,
    }
    if error:
        record["error"] = error
    with SYNC_LOG_PATH.open("a") as f:
        f.write(json.dumps(record) + "\n")


# ---------------------------------------------------------------------------
# Main sync function
# ---------------------------------------------------------------------------

def sync(notion_url: str, output_name: str = None) -> None:
    notion_api_key = os.getenv("NOTION_API_KEY")
    anthropic_api_key = os.getenv("ANTHROPIC_API_KEY")

    if not notion_api_key:
        raise EnvironmentError(
            "NOTION_API_KEY not set. Copy sync/.env.example to sync/.env and fill it in."
        )
    if not anthropic_api_key:
        raise EnvironmentError(
            "ANTHROPIC_API_KEY not set. Copy sync/.env.example to sync/.env and fill it in."
        )

    synced_at = datetime.now(timezone.utc).isoformat()
    slug = None
    row_count = 0

    try:
        # --- Step 1: Fetch schema ---
        print(f"[sync] Fetching schema from {notion_url} ...")
        client = NotionDatabaseClient(api_key=notion_api_key)
        database_id, schema = client.fetch_schema(notion_url)
        table_name = schema.get("title", "Unknown Database")
        print(f"[sync] Database: '{table_name}' (ID: {database_id})")

        # --- Step 2: Schema mapping ---
        mapping = get_schema_mapping(
            database_id=database_id,
            schema=schema,
            data_dir=DATA_DIR,
            anthropic_api_key=anthropic_api_key,
        )

        # --- Step 3: Fetch all pages ---
        print(f"[sync] Fetching all pages ...")
        pages = client.fetch_all_pages(database_id)
        row_count = len(pages)
        print(f"[sync] Fetched {row_count} pages.")

        # --- Step 4a: Pass 1 - build URL->ID map ---
        url_to_id = _build_url_to_id_map(pages)

        # --- Step 4b: Determine slug ---
        if output_name:
            slug = _slugify(output_name)
        else:
            slug = _slugify(table_name)
        if not slug:
            slug = database_id.replace("-", "")[:16]

        # --- Step 5: Pass 2 - normalise rows ---
        print(f"[sync] Normalising rows ...")
        tasks = [_normalise_page(page, mapping, url_to_id, slug) for page in pages]

        # Sort by start date (empty dates sink to the end), with name as a
        # stable tiebreaker. Viewer also sorts at render time, but having the
        # on-disk order match means any tool reading the JSON directly gets a
        # sensible chronological ordering.
        tasks.sort(key=lambda t: (t.get("start") or "9999-12-31", t.get("name") or ""))

        # --- Step 6: Build phase palette ---
        phases_seen = {t["meta"]["phase"] for t in tasks if t["meta"]["phase"]}
        phase_palette, unknown_phases = _build_phase_palette(phases_seen)
        for phase in unknown_phases:
            print(
                f"[sync] WARNING: Phase '{phase}' not in canonical palette. "
                f"Using fallback color {FALLBACK_PHASE_COLOR}.",
                file=sys.stderr,
            )

        # --- Step 7: Compose output JSON ---
        output = {
            "source": {
                "notion_url": notion_url,
                "data_source_id": f"collection://{database_id}",
                "table_name": table_name,
                "synced_at": synced_at,
                "row_count": row_count,
            },
            "schema_mapping": mapping,
            "phase_palette": phase_palette,
            "tasks": tasks,
        }

        # --- Step 8: Write output JSON ---
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        out_path = DATA_DIR / f"{slug}.json"
        with out_path.open("w") as f:
            json.dump(output, f, indent=2)
        print(f"[sync] Written: {out_path}")

        # --- Step 9: Update manifest ---
        _update_manifest(
            slug=slug,
            table_name=table_name,
            notion_url=notion_url,
            data_source_id=f"collection://{database_id}",
            synced_at=synced_at,
            row_count=row_count,
        )
        print(f"[sync] Manifest updated: {MANIFEST_PATH}")

        # --- Step 10: Append sync log ---
        _append_sync_log(notion_url, slug, row_count, success=True)
        print(f"[sync] Sync log appended: {SYNC_LOG_PATH}")

        # --- Step 11: Push to shared workspace repo (if configured) ---
        roadmap_path = os.environ.get("PPGANTT_ROADMAP_PATH")
        if roadmap_path and slug == "roadmap":
            try:
                _push_to_workspace(out_path, roadmap_path)
            except Exception as ws_err:
                print(f"[sync] workspace: FAILED — {ws_err}", file=sys.stderr)
                # Don't abort the whole sync — the local file is already written.

        print(f"\n[sync] Done. {row_count} tasks written to data/{slug}.json")

    except Exception as e:
        _append_sync_log(
            notion_url,
            slug or "(unknown)",
            row_count,
            success=False,
            error=str(e),
        )
        print(f"\n[sync] ERROR: {e}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)


# ---------------------------------------------------------------------------
# Workspace repo push (optional — driven by PPGANTT_ROADMAP_PATH env var)
# ---------------------------------------------------------------------------

def _find_git_root(path: Path) -> Path | None:
    """Walk up from `path` until we hit a directory containing `.git`."""
    p = path.parent if path.is_file() else path
    while p != p.parent:
        if (p / ".git").exists():
            return p
        p = p.parent
    return None


def _push_to_workspace(source_path: Path, dest_path_str: str) -> None:
    """Copy the synced roadmap to a shared workspace repo, commit, and push.

    Dest path is an absolute filesystem path inside a git repo.
    Aborts with a loud error if the repo's working tree is dirty — we never
    want to auto-commit someone's in-progress edits along with the sync.
    """
    dest = Path(os.path.expanduser(dest_path_str)).resolve()
    repo_root = _find_git_root(dest)
    if not repo_root:
        print(f"[sync] workspace: SKIP — {dest} is not inside a git repo")
        return

    # Refuse to push if the workspace has other uncommitted changes.
    status = subprocess.run(
        ["git", "-C", str(repo_root), "status", "--porcelain"],
        capture_output=True, text=True, check=True,
    )
    # Strip out the dest file itself — we expect that to change.
    rel = dest.relative_to(repo_root)
    dirty_lines = [
        ln for ln in status.stdout.splitlines()
        if ln.strip() and ln[3:].strip() != str(rel)
    ]
    if dirty_lines:
        print(
            f"[sync] workspace: ABORT — {repo_root} has uncommitted changes:",
            file=sys.stderr,
        )
        for ln in dirty_lines:
            print(f"  {ln}", file=sys.stderr)
        print(
            "[sync] workspace: commit or stash those changes, then rerun sync.",
            file=sys.stderr,
        )
        return

    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(source_path, dest)

    subprocess.run(
        ["git", "-C", str(repo_root), "add", str(rel)],
        check=True,
    )

    commit_msg = f"sync: roadmap {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    commit = subprocess.run(
        ["git", "-C", str(repo_root), "commit", "-m", commit_msg],
        capture_output=True, text=True,
    )
    # "nothing to commit" means the file content didn't change — treat as success.
    if commit.returncode != 0:
        if "nothing to commit" in commit.stdout or "nothing to commit" in commit.stderr:
            print(f"[sync] workspace: no change to push (content identical)")
            return
        raise RuntimeError(
            f"workspace commit failed: {commit.stdout}\n{commit.stderr}"
        )

    subprocess.run(
        ["git", "-C", str(repo_root), "push"],
        check=True,
    )
    print(f"[sync] workspace: pushed {rel} to {repo_root.name}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    # Add sync/ to path so we can import sibling modules
    sys.path.insert(0, str(_SYNC_DIR))

    parser = argparse.ArgumentParser(
        description="PPGantt: sync a Notion database to a local JSON file."
    )
    parser.add_argument(
        "notion_url",
        help="URL of the Notion database to sync (e.g. https://www.notion.so/workspace/abcdef...)",
    )
    parser.add_argument(
        "--output-name",
        default=None,
        metavar="SLUG",
        help="Optional output filename slug (default: derived from database title)",
    )
    args = parser.parse_args()

    sync(args.notion_url, output_name=args.output_name)


if __name__ == "__main__":
    main()
