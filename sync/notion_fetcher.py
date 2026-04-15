"""
notion_fetcher.py — Notion API wrapper for PPGantt sync.

# TWO CODE PATHS
#
# Path 1 (PRIMARY — implemented here):
#   Direct REST API via the `notion-client` Python package.
#   Requires NOTION_API_KEY in .env.
#   Handles pagination automatically (Notion caps at 100 rows per request;
#   we loop with start_cursor until has_more is False).
#
# Path 2 (MCP FALLBACK — for Claude Code sessions only):
#   When running inside a Claude Code session with the Notion MCP loaded,
#   you can skip this script entirely and use MCP tools directly:
#
#     mcp__notion__notion-fetch  -> fetches a page or database schema
#     mcp__notion__notion-search -> queries rows within a data source
#
#   MCP tools are NOT callable from a Python subprocess. They run in the
#   Claude Code process itself. If you want to drive a sync from within
#   Claude Code, use MCP to fetch all rows, copy the resulting JSON,
#   and call schema_mapper.py + the normaliser manually (or pipe the
#   JSON to sync.py via stdin — not yet implemented in v1).
#
#   For the reference database, the MCP path was already validated during
#   plan authoring. The direct REST path is used for automated/CLI syncs.
"""

import re
from typing import Optional

from notion_client import Client as NotionSDKClient


def _extract_database_id(notion_url: str) -> str:
    """
    Extract the Notion database UUID from a URL like:
      https://www.notion.so/your-workspace/your-database-id?v=...

    Returns the 32-char hex ID without dashes.
    Raises ValueError if the URL can't be parsed.
    """
    # Match a 32-char hex segment anywhere in the path
    match = re.search(r"([0-9a-f]{32})", notion_url.replace("-", ""))
    if not match:
        # Also try UUID format with dashes
        match = re.search(
            r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
            notion_url,
        )
    if not match:
        raise ValueError(f"Cannot extract database ID from URL: {notion_url}")
    raw = match.group(1).replace("-", "")
    # Format as canonical UUID
    return f"{raw[:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:]}"


class NotionDatabaseClient:
    """
    Wraps the Notion REST API for PPGantt sync.

    Usage:
        client = NotionDatabaseClient(api_key="secret_...")
        db_id, schema = client.fetch_schema("https://www.notion.so/...")
        pages = client.fetch_all_pages(db_id)
    """

    def __init__(self, api_key: str):
        self._client = NotionSDKClient(auth=api_key)

    def fetch_schema(self, notion_url: str) -> tuple[str, dict]:
        """
        Fetch the database schema (property definitions) from Notion.

        Returns:
            (database_id, schema_dict) where schema_dict is:
            {
                "properties": { "<prop_name>": {"type": "<notion_type>", ...}, ... },
                "title": "<database title>"
            }
        """
        db_id = _extract_database_id(notion_url)
        db = self._client.databases.retrieve(database_id=db_id)

        title_parts = db.get("title", [])
        title = "".join(
            part.get("plain_text", "") for part in title_parts
        )

        # Flatten property metadata to just type + options (keep it minimal)
        properties: dict = {}
        for prop_name, prop_meta in db.get("properties", {}).items():
            prop_type = prop_meta.get("type", "unknown")
            entry: dict = {"type": prop_type}

            # Capture select/multi_select options so the LLM can see them
            if prop_type in ("select", "multi_select", "status"):
                option_key = prop_type  # e.g. "select" -> db["properties"][x]["select"]
                options = prop_meta.get(option_key, {}).get("options", [])
                entry["options"] = [o.get("name") for o in options]

            properties[prop_name] = entry

        schema = {"title": title, "properties": properties}
        return db_id, schema

    def fetch_all_pages(self, database_id: str) -> list[dict]:
        """
        Query all pages in a Notion database, handling pagination.

        Notion returns max 100 rows per call; we loop with start_cursor
        until has_more is False.

        Returns a list of raw Notion page objects.
        """
        pages: list[dict] = []
        start_cursor: Optional[str] = None

        while True:
            kwargs: dict = {"database_id": database_id, "page_size": 100}
            if start_cursor:
                kwargs["start_cursor"] = start_cursor

            response = self._client.databases.query(**kwargs)
            pages.extend(response.get("results", []))

            if response.get("has_more"):
                start_cursor = response.get("next_cursor")
            else:
                break

        return pages


# ---------------------------------------------------------------------------
# Property value extraction helpers
# ---------------------------------------------------------------------------

def extract_property_value(prop: dict) -> object:
    """
    Extract a Python-native value from a raw Notion property dict.

    Handles: title, rich_text, number, select, multi_select, status,
             date, checkbox, url, relation, people, formula, rollup.
    Returns None for unsupported or empty types.
    """
    prop_type = prop.get("type")
    data = prop.get(prop_type)

    if data is None:
        return None

    if prop_type in ("title", "rich_text"):
        return "".join(part.get("plain_text", "") for part in data) or None

    if prop_type == "number":
        return data  # already a number or None

    if prop_type == "select":
        return data.get("name") if data else None

    if prop_type in ("multi_select", "status"):
        if prop_type == "status":
            return data.get("name") if data else None
        return [o.get("name") for o in data] if data else []

    if prop_type == "date":
        if not data:
            return None
        # Return just the start date as YYYY-MM-DD (strip time component)
        start = data.get("start", "")
        return start[:10] if start else None

    if prop_type == "checkbox":
        return bool(data)

    if prop_type == "url":
        return data  # string or None

    if prop_type == "relation":
        # Notion returns [{id: "page-uuid"}, ...] — extract the URLs separately
        # via _extract_relation_urls if needed. Here we return the raw list.
        return [item.get("id") for item in data] if data else []

    if prop_type == "formula":
        formula_type = data.get("type")
        if formula_type:
            return data.get(formula_type)
        return None

    if prop_type == "rollup":
        rollup_type = data.get("type")
        if rollup_type == "array":
            return [extract_property_value(item) for item in data.get("array", [])]
        elif rollup_type:
            return data.get(rollup_type)
        return None

    if prop_type == "people":
        return [p.get("name") for p in data] if data else []

    # Fallback: return raw
    return data


def extract_relation_page_ids(prop: dict) -> list[str]:
    """
    For a relation property, return the list of referenced page IDs.
    These are Notion page UUIDs (with dashes).
    """
    if prop.get("type") != "relation":
        return []
    return [item.get("id", "") for item in prop.get("relation", [])]
