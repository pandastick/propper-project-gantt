"""
schema_mapper.py — LLM-powered Notion schema -> PPGantt canonical field mapper.

Flow:
  1. Receive a Notion schema dict (property names + types).
  2. Compute a stable cache key from the database UUID.
  3. Check data/_schema_cache/<database-id>.json.
     - If found and valid: return cached mapping.
  4. If absent: call Claude Sonnet via Anthropic SDK to propose a mapping.
  5. Print proposed mapping, ask user for y/n confirmation (plan Risk R2).
  6. If confirmed, save to cache and return.
  7. If rejected, raise RuntimeError so the caller can abort.
"""

import json
import os
import sys
from pathlib import Path
from typing import Optional

import anthropic

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REQUIRED_FIELDS = {"name_field", "start_field", "end_field", "dependencies_field"}

CANONICAL_FIELDS = {
    "id_field": "page ID (always notion_page_id - hardcoded, do not change)",
    "name_field": "title property - the main task name",
    "start_field": "start date (date type)",
    "end_field": "end date (date type)",
    "dependencies_field": "self-referential relation (Blocked by / depends on)",
    "progress_field": "completion percentage, number 0-100",
    "color_field": "phase / category select for bar color",
    "milestone_field": "is-milestone checkbox (optional)",
    "slack_field": "float/slack days number (optional)",
    "critical_path_field": "critical path checkbox (optional)",
    "risk_field": "risk level select (optional)",
    "updated_by_field": "rich_text property stamped with the pusher's name when PPGantt writes back (optional; required for Push to Notion)",
    "last_sync_field": "date property stamped with the ISO datetime of the PPGantt write-back (optional; required for Push to Notion)",
}

MAPPING_PROMPT_TEMPLATE = """You are a schema mapper for a Gantt chart tool called PPGantt.

Given this Notion database schema:
{schema_json}

Map its fields to the following canonical PPGantt Gantt fields.
For each canonical field, provide the exact Notion property name that best matches it.
If a canonical field has no reasonable match, set it to null.

Canonical fields and their meanings:
{canonical_fields}

Rules:
- "id_field" must ALWAYS be set to the literal string "notion_page_id" (not a property name).
- For "name_field", choose the title-type property.
- For "start_field" and "end_field", choose date-type properties.
- For "dependencies_field", choose a relation-type property (self-referential preferred).
- For "progress_field", choose a number property representing 0-100 completion.
- For "color_field", choose a select property representing phase or category.
- Optional fields (milestone_field, slack_field, critical_path_field, risk_field) can be null.
- For "updated_by_field", look for a rich_text property whose name contains "Updated By" (e.g. "PPG Last Updated By"). Null if absent.
- For "last_sync_field", look for a date property whose name contains "Last Sync" or "PPG" (e.g. "PPG Last Sync"). This is DISTINCT from any "MCP update" or "Last edited time" field — do not reuse those. Null if absent.

Return ONLY a valid JSON object with these exact keys:
{{
  "id_field": "notion_page_id",
  "name_field": "<Notion property name or null>",
  "start_field": "<Notion property name or null>",
  "end_field": "<Notion property name or null>",
  "dependencies_field": "<Notion property name or null>",
  "progress_field": "<Notion property name or null>",
  "color_field": "<Notion property name or null>",
  "milestone_field": "<Notion property name or null>",
  "slack_field": "<Notion property name or null>",
  "critical_path_field": "<Notion property name or null>",
  "risk_field": "<Notion property name or null>",
  "updated_by_field": "<Notion property name or null>",
  "last_sync_field": "<Notion property name or null>"
}}

Do not include any explanation or markdown — only the JSON object.
"""


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

def _cache_path(data_dir: Path, database_id: str) -> Path:
    """Return the cache file path for a given database ID."""
    # Normalise: strip dashes for the filename
    clean_id = database_id.replace("-", "")
    return data_dir / "_schema_cache" / f"{clean_id}.json"


def _load_cache(cache_file: Path) -> Optional[dict]:
    """Return cached mapping dict or None if absent/invalid."""
    if not cache_file.exists():
        return None
    try:
        with cache_file.open() as f:
            mapping = json.load(f)
        # Minimal validity check
        if "id_field" in mapping and "name_field" in mapping:
            return mapping
    except (json.JSONDecodeError, OSError):
        pass
    return None


def _save_cache(cache_file: Path, mapping: dict) -> None:
    """Write mapping to cache file (creates parents if needed)."""
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    with cache_file.open("w") as f:
        json.dump(mapping, f, indent=2)


# ---------------------------------------------------------------------------
# LLM call
# ---------------------------------------------------------------------------

def _call_llm(schema: dict, api_key: str) -> dict:
    """
    Call Claude Sonnet to propose a schema mapping.
    Returns the parsed JSON mapping dict.
    Raises ValueError if the response can't be parsed or is invalid.
    """
    client = anthropic.Anthropic(api_key=api_key)

    canonical_desc = "\n".join(
        f"- {key}: {desc}" for key, desc in CANONICAL_FIELDS.items()
    )
    prompt = MAPPING_PROMPT_TEMPLATE.format(
        schema_json=json.dumps(schema, indent=2),
        canonical_fields=canonical_desc,
    )

    message = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = message.content[0].text.strip()

    # Strip markdown code fences if present
    if raw.startswith("```"):
        lines = raw.splitlines()
        raw = "\n".join(lines[1:-1] if lines[-1] == "```" else lines[1:])

    try:
        mapping = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"LLM returned invalid JSON: {e}\nRaw response:\n{raw}") from e

    # Ensure id_field is hardcoded correctly
    mapping["id_field"] = "notion_page_id"

    return mapping


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _validate_mapping(mapping: dict) -> list[str]:
    """
    Return a list of validation error strings.
    Empty list means the mapping is valid.
    """
    errors = []
    for field in REQUIRED_FIELDS:
        if not mapping.get(field):
            errors.append(f"Required field '{field}' is null or missing.")
    return errors


# ---------------------------------------------------------------------------
# User confirmation (plan Risk R2 mitigation)
# ---------------------------------------------------------------------------

def _confirm_mapping(mapping: dict, schema: dict) -> bool:
    """
    Print the proposed mapping and ask the user to confirm.
    Returns True if confirmed, False if rejected.
    Skips confirmation if stdin is not a TTY (non-interactive mode).
    """
    print("\n" + "=" * 60)
    print("PROPOSED SCHEMA MAPPING")
    print("=" * 60)
    print(f"Database: {schema.get('title', '(unknown)')}")
    print("\nMapping (Notion property name -> PPGantt canonical field):")
    for key, value in mapping.items():
        marker = " [REQUIRED]" if key in REQUIRED_FIELDS else ""
        print(f"  {key:<25} = {value}{marker}")
    print("=" * 60)

    if not sys.stdin.isatty():
        print("[Non-interactive mode] Auto-accepting mapping.")
        return True

    while True:
        answer = input("\nAccept this mapping? [y/n]: ").strip().lower()
        if answer in ("y", "yes"):
            return True
        if answer in ("n", "no"):
            return False
        print("Please enter y or n.")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_schema_mapping(
    database_id: str,
    schema: dict,
    data_dir: Path,
    anthropic_api_key: str,
) -> dict:
    """
    Return the canonical PPGantt field mapping for the given Notion schema.

    Uses the cache if available; otherwise calls the LLM, confirms with the
    user, validates, then caches and returns.

    Args:
        database_id:      Notion database UUID (with or without dashes).
        schema:           Schema dict from NotionDatabaseClient.fetch_schema().
        data_dir:         Path to the data/ directory (for cache storage).
        anthropic_api_key: Anthropic API key for the LLM call.

    Returns:
        dict with keys: id_field, name_field, start_field, end_field,
        dependencies_field, progress_field, color_field, milestone_field,
        slack_field, critical_path_field, risk_field.

    Raises:
        ValueError: if the mapping is invalid or the user rejects it.
        RuntimeError: if the user declines the proposed mapping.
    """
    cache_file = _cache_path(data_dir, database_id)

    # Cache hit
    cached = _load_cache(cache_file)
    if cached is not None:
        print(f"[schema_mapper] Using cached mapping from {cache_file}")
        return cached

    # LLM call
    print(f"[schema_mapper] No cached mapping found. Calling Claude Sonnet...")
    mapping = _call_llm(schema, anthropic_api_key)

    # Ensure id_field is always hardcoded (LLM cannot override this)
    mapping["id_field"] = "notion_page_id"

    # Validate
    errors = _validate_mapping(mapping)
    if errors:
        raise ValueError(
            "LLM returned an invalid mapping:\n"
            + "\n".join(f"  - {e}" for e in errors)
        )

    # User confirmation
    accepted = _confirm_mapping(mapping, schema)
    if not accepted:
        raise RuntimeError(
            "Schema mapping rejected by user. "
            "Edit the mapping manually or re-run to try again."
        )

    # Save to cache
    _save_cache(cache_file, mapping)
    print(f"[schema_mapper] Mapping saved to {cache_file}")

    return mapping
