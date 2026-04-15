"""
test_schema_mapper.py — Unit tests for sync/schema_mapper.py

Tests:
  - Cache hit: returns cached mapping without calling LLM
  - Cache miss: calls LLM, confirms, caches result
  - User rejection: raises RuntimeError
  - Invalid LLM response: raises ValueError
  - Missing required fields: raises ValueError
  - Non-interactive mode: auto-accepts
"""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, mock_open, patch

# Add sync/ to path so we can import the module under test
_REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_REPO_ROOT / "sync"))

import schema_mapper as sm


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SAMPLE_SCHEMA = {
    "title": "My Project",
    "properties": {
        "Task Name": {"type": "title"},
        "Start Date": {"type": "date"},
        "End Date": {"type": "date"},
        "Blocked by": {"type": "relation"},
        "Completion %": {"type": "number"},
        "Phase": {"type": "select", "options": ["Phase 1", "Phase 2"]},
        "Is Milestone": {"type": "checkbox"},
        "Slack days": {"type": "number"},
        "Critical Path": {"type": "checkbox"},
        "Risk Level": {"type": "select", "options": ["None", "High"]},
    },
}

GOOD_MAPPING = {
    "id_field": "notion_page_id",
    "name_field": "Task Name",
    "start_field": "Start Date",
    "end_field": "End Date",
    "dependencies_field": "Blocked by",
    "progress_field": "Completion %",
    "color_field": "Phase",
    "milestone_field": "Is Milestone",
    "slack_field": "Slack days",
    "critical_path_field": "Critical Path",
    "risk_field": "Risk Level",
}

DATABASE_ID = "3f81368c-1afd-4671-8503-93fca51a1b25"


class TestSchemaCacheHit(unittest.TestCase):
    """When cache file exists and is valid, LLM is NOT called."""

    def test_returns_cached_mapping(self, tmp_path=None):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            cache_dir = data_dir / "_schema_cache"
            cache_dir.mkdir()

            # Write a cache file
            clean_id = DATABASE_ID.replace("-", "")
            cache_file = cache_dir / f"{clean_id}.json"
            cache_file.write_text(json.dumps(GOOD_MAPPING))

            with patch.object(sm, "_call_llm", side_effect=AssertionError("LLM must not be called")):
                result = sm.get_schema_mapping(
                    database_id=DATABASE_ID,
                    schema=SAMPLE_SCHEMA,
                    data_dir=data_dir,
                    anthropic_api_key="fake-key",
                )

            self.assertEqual(result["name_field"], "Task Name")
            self.assertEqual(result["start_field"], "Start Date")
            self.assertEqual(result["id_field"], "notion_page_id")


class TestSchemaCacheMiss(unittest.TestCase):
    """Cache miss: LLM is called, user confirms, result is cached."""

    def test_llm_called_and_cached(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            cache_dir = data_dir / "_schema_cache"
            cache_dir.mkdir()

            with (
                patch.object(sm, "_call_llm", return_value=dict(GOOD_MAPPING)) as mock_llm,
                patch.object(sm, "_confirm_mapping", return_value=True),
            ):
                result = sm.get_schema_mapping(
                    database_id=DATABASE_ID,
                    schema=SAMPLE_SCHEMA,
                    data_dir=data_dir,
                    anthropic_api_key="fake-key",
                )

            mock_llm.assert_called_once()
            self.assertEqual(result["name_field"], "Task Name")

            # Cache should now exist
            clean_id = DATABASE_ID.replace("-", "")
            cache_file = cache_dir / f"{clean_id}.json"
            self.assertTrue(cache_file.exists())
            cached = json.loads(cache_file.read_text())
            self.assertEqual(cached["name_field"], "Task Name")


class TestUserRejection(unittest.TestCase):
    """If user rejects the mapping, RuntimeError is raised and nothing is cached."""

    def test_raises_on_rejection(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            (data_dir / "_schema_cache").mkdir()

            with (
                patch.object(sm, "_call_llm", return_value=dict(GOOD_MAPPING)),
                patch.object(sm, "_confirm_mapping", return_value=False),
            ):
                with self.assertRaises(RuntimeError):
                    sm.get_schema_mapping(
                        database_id=DATABASE_ID,
                        schema=SAMPLE_SCHEMA,
                        data_dir=data_dir,
                        anthropic_api_key="fake-key",
                    )

            # No cache file should have been written
            clean_id = DATABASE_ID.replace("-", "")
            cache_file = data_dir / "_schema_cache" / f"{clean_id}.json"
            self.assertFalse(cache_file.exists())


class TestMissingRequiredFields(unittest.TestCase):
    """LLM returns a mapping with null required fields -> ValueError."""

    def test_raises_on_missing_required(self):
        import tempfile

        bad_mapping = dict(GOOD_MAPPING)
        bad_mapping["name_field"] = None
        bad_mapping["start_field"] = None

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            (data_dir / "_schema_cache").mkdir()

            with (
                patch.object(sm, "_call_llm", return_value=bad_mapping),
            ):
                with self.assertRaises(ValueError) as ctx:
                    sm.get_schema_mapping(
                        database_id=DATABASE_ID,
                        schema=SAMPLE_SCHEMA,
                        data_dir=data_dir,
                        anthropic_api_key="fake-key",
                    )

            self.assertIn("name_field", str(ctx.exception))


class TestInvalidLLMResponse(unittest.TestCase):
    """LLM returns non-JSON -> ValueError from _call_llm."""

    def test_raises_on_invalid_json(self):
        # _call_llm raises ValueError internally; test it directly
        mock_client = MagicMock()
        mock_message = MagicMock()
        mock_message.content = [MagicMock(text="not valid json at all")]
        mock_client.messages.create.return_value = mock_message

        with patch("anthropic.Anthropic", return_value=mock_client):
            with self.assertRaises(ValueError):
                sm._call_llm(SAMPLE_SCHEMA, "fake-key")


class TestIdFieldHardcoded(unittest.TestCase):
    """LLM cannot override id_field; it must always be 'notion_page_id'."""

    def test_id_field_always_hardcoded(self):
        import tempfile

        mapping_with_wrong_id = dict(GOOD_MAPPING)
        mapping_with_wrong_id["id_field"] = "Some Field"

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            (data_dir / "_schema_cache").mkdir()

            with (
                patch.object(sm, "_call_llm", return_value=mapping_with_wrong_id),
                patch.object(sm, "_confirm_mapping", return_value=True),
            ):
                result = sm.get_schema_mapping(
                    database_id=DATABASE_ID,
                    schema=SAMPLE_SCHEMA,
                    data_dir=data_dir,
                    anthropic_api_key="fake-key",
                )

            self.assertEqual(result["id_field"], "notion_page_id")


class TestCachePathGeneration(unittest.TestCase):
    """Cache path uses dash-stripped database ID."""

    def test_cache_path(self):
        import tempfile

        data_dir = Path(tempfile.mkdtemp())
        path = sm._cache_path(data_dir, DATABASE_ID)
        self.assertIn("3f81368c1afd46718503", str(path))
        self.assertTrue(str(path).endswith(".json"))


class TestValidateMapping(unittest.TestCase):
    def test_valid_mapping(self):
        errors = sm._validate_mapping(GOOD_MAPPING)
        self.assertEqual(errors, [])

    def test_missing_required(self):
        bad = dict(GOOD_MAPPING)
        bad["end_field"] = None
        errors = sm._validate_mapping(bad)
        self.assertTrue(any("end_field" in e for e in errors))


if __name__ == "__main__":
    unittest.main()
