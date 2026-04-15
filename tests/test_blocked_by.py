"""
test_blocked_by.py — Unit tests for two-pass Blocked-by URL->ID resolution.

Tests:
  - Normal case: relation IDs resolve to task IDs
  - Missing URL: unresolvable reference is skipped with warning
  - Self-reference: a task that depends on itself resolves correctly (or is skipped)
  - External URL: page from another database -> skipped with warning
  - Multiple dependencies: comma-separated output is correct
  - Slug tests: common slug generation cases
"""

import sys
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

# Add sync/ to path
_REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_REPO_ROOT / "sync"))

from sync import (
    _build_url_to_id_map,
    _resolve_dependencies,
    _slugify,
    _phase_slug,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_page(page_id: str) -> dict:
    """Return a minimal Notion page dict with the given ID."""
    return {"id": page_id, "properties": {}}


# Page IDs used in tests
PAGE_A = "aaaaaaaa-0000-0000-0000-000000000001"
PAGE_B = "bbbbbbbb-0000-0000-0000-000000000002"
PAGE_C = "cccccccc-0000-0000-0000-000000000003"
EXTERNAL = "eeeeeeee-ffff-0000-0000-000000000099"  # not in database


# ---------------------------------------------------------------------------
# Tests: _build_url_to_id_map
# ---------------------------------------------------------------------------

class TestBuildUrlToIdMap(unittest.TestCase):
    def test_builds_url_entries(self):
        pages = [_make_page(PAGE_A), _make_page(PAGE_B)]
        url_map = _build_url_to_id_map(pages)

        clean_a = PAGE_A.replace("-", "")
        self.assertIn(f"https://www.notion.so/{clean_a}", url_map)
        self.assertEqual(url_map[f"https://www.notion.so/{clean_a}"], PAGE_A)

    def test_indexes_raw_id(self):
        pages = [_make_page(PAGE_A)]
        url_map = _build_url_to_id_map(pages)
        self.assertIn(PAGE_A, url_map)
        self.assertEqual(url_map[PAGE_A], PAGE_A)

    def test_indexes_clean_id(self):
        pages = [_make_page(PAGE_A)]
        url_map = _build_url_to_id_map(pages)
        clean = PAGE_A.replace("-", "")
        self.assertIn(clean, url_map)

    def test_empty_pages(self):
        url_map = _build_url_to_id_map([])
        self.assertEqual(url_map, {})

    def test_page_with_no_id_skipped(self):
        pages = [{"id": "", "properties": {}}, _make_page(PAGE_B)]
        url_map = _build_url_to_id_map(pages)
        # PAGE_B should be indexed; empty-ID page skipped
        clean_b = PAGE_B.replace("-", "")
        self.assertIn(clean_b, url_map)


# ---------------------------------------------------------------------------
# Tests: _resolve_dependencies
# ---------------------------------------------------------------------------

class TestResolveDependencies(unittest.TestCase):
    def setUp(self):
        pages = [_make_page(PAGE_A), _make_page(PAGE_B), _make_page(PAGE_C)]
        self.url_map = _build_url_to_id_map(pages)

    def test_normal_case(self):
        """Two relation IDs both resolve to task IDs."""
        result = _resolve_dependencies([PAGE_A, PAGE_B], self.url_map, "test")
        parts = result.split(",")
        self.assertIn(PAGE_A, parts)
        self.assertIn(PAGE_B, parts)
        self.assertEqual(len(parts), 2)

    def test_single_dependency(self):
        result = _resolve_dependencies([PAGE_C], self.url_map, "test")
        self.assertEqual(result, PAGE_C)

    def test_empty_dependencies(self):
        result = _resolve_dependencies([], self.url_map, "test")
        self.assertEqual(result, "")

    def test_missing_url_skipped_with_warning(self):
        """Unresolvable reference is skipped and a warning is printed."""
        stderr_capture = StringIO()
        with patch("sys.stderr", stderr_capture):
            result = _resolve_dependencies([EXTERNAL], self.url_map, "test")

        self.assertEqual(result, "")
        warning = stderr_capture.getvalue()
        self.assertIn("WARNING", warning)
        self.assertIn(EXTERNAL, warning)

    def test_self_reference_resolves(self):
        """A task that lists itself as a dependency resolves (not the sync's job to forbid)."""
        result = _resolve_dependencies([PAGE_A], self.url_map, "test")
        self.assertEqual(result, PAGE_A)

    def test_external_url_skipped(self):
        """A page ID from another database (not in url_map) -> skipped."""
        another_external = "ffffffff-1234-5678-9abc-def000000000"
        stderr_capture = StringIO()
        with patch("sys.stderr", stderr_capture):
            result = _resolve_dependencies([another_external], self.url_map, "test")
        self.assertEqual(result, "")

    def test_mixed_valid_and_invalid(self):
        """Some IDs resolve, some don't; only resolved ones appear in output."""
        stderr_capture = StringIO()
        with patch("sys.stderr", stderr_capture):
            result = _resolve_dependencies(
                [PAGE_A, EXTERNAL, PAGE_B], self.url_map, "test"
            )
        parts = result.split(",")
        self.assertIn(PAGE_A, parts)
        self.assertIn(PAGE_B, parts)
        self.assertNotIn(EXTERNAL, parts)
        self.assertIn("WARNING", stderr_capture.getvalue())

    def test_url_format_lookup(self):
        """Notion-style URL (https://www.notion.so/<id-without-dashes>) resolves correctly."""
        clean_b = PAGE_B.replace("-", "")
        notion_url = f"https://www.notion.so/{clean_b}"
        result = _resolve_dependencies([notion_url], self.url_map, "test")
        self.assertEqual(result, PAGE_B)

    def test_none_ref_skipped(self):
        """None/empty string refs are skipped gracefully."""
        result = _resolve_dependencies(["", None], self.url_map, "test")
        self.assertEqual(result, "")


# ---------------------------------------------------------------------------
# Tests: slug generation
# ---------------------------------------------------------------------------

class TestSlugify(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(_slugify("Hello World"), "hello-world")

    def test_special_chars(self):
        self.assertEqual(_slugify("MVP Implementation Gantt V2 (Apr 9)"), "mvp-implementation-gantt-v2-apr-9")

    def test_already_slug(self):
        self.assertEqual(_slugify("my-project"), "my-project")

    def test_multiple_spaces(self):
        self.assertEqual(_slugify("a  b  c"), "a-b-c")

    def test_leading_trailing(self):
        self.assertEqual(_slugify("  hello  "), "hello")

    def test_numbers(self):
        self.assertEqual(_slugify("Phase 2A - Storefront"), "phase-2a-storefront")

    def test_empty(self):
        self.assertEqual(_slugify(""), "")

    def test_unicode_preserved(self):
        # Python's \w includes unicode letters, so they are preserved but lowercased
        result = _slugify("Café au lait")
        self.assertIn("caf", result)
        self.assertIn("au-lait", result)

    def test_underscores_become_dashes(self):
        self.assertEqual(_slugify("hello_world"), "hello-world")


class TestPhaseSlug(unittest.TestCase):
    def test_phase_0_5_security(self):
        # "Phase 0.5 - Security" -> slug "05-security" (phase- prefix stripped)
        self.assertEqual(_phase_slug("Phase 0.5 - Security"), "05-security")

    def test_phase_2a(self):
        # "Phase 2A - Storefront" -> "2a-storefront" (phase- prefix stripped)
        self.assertEqual(_phase_slug("Phase 2A - Storefront"), "2a-storefront")

    def test_launch_track(self):
        # "Launch Track" has no "phase-" prefix -> kept as-is
        self.assertEqual(_phase_slug("Launch Track"), "launch-track")


if __name__ == "__main__":
    unittest.main()
