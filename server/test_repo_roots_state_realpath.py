"""Tests for repo_roots_state.resolve_selected_repo — realpath equivalence.

Regression: previously the validator compared abspath() against the state,
which failed for paths whose bind-mount view differs syntactically from
the state-stored path even though they resolve to the same directory.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

from server import repo_roots_state as rrs


@pytest.fixture
def fake_state(tmp_path, monkeypatch):
    """Write a state.json with one root and two selected repo paths.

    The fixture isolates the test from any on-disk state at
    ~/.local/state/repociv so we can simulate any layout.
    """
    carcosa_dir = tmp_path / "CARCOSA"
    carcosa_dir.mkdir()
    deep_dir = tmp_path / "some" / "deep" / "path" / "repo"
    deep_dir.mkdir(parents=True)

    state_file = tmp_path / "state.json"
    state = {
        "version": 1,
        "activeRoot": str(tmp_path),
        "roots": {
            str(tmp_path): {
                "selectedRepoPaths": [
                    str(carcosa_dir),
                    str(deep_dir),
                ],
            },
        },
    }
    state_file.write_text(json.dumps(state), encoding="utf-8")

    # Override the loader at the source: redirect _state_file() to the temp file,
    # since resolve_selected_repo calls load_state(), which calls _state_file.
    monkeypatch.setattr(rrs, "_state_file", lambda: state_file)
    return state


def test_canonic_path_passes(fake_state):
    out = rrs.resolve_selected_repo("ignored", str(Path(fake_state["activeRoot"]) / "CARCOSA"))
    assert out is not None
    assert out.endswith("CARCOSA")


def test_basename_lookup_passes(fake_state):
    out = rrs.resolve_selected_repo("CARCOSA", "")
    assert out is not None
    assert out.endswith("CARCOSA")


def test_path_outside_state_returns_none(fake_state):
    out = rrs.resolve_selected_repo("ignored", "/tmp/totally/unrelated/path")
    assert out is None


def test_path_with_trailing_slash_passes(fake_state):
    out = rrs.resolve_selected_repo("ignored",
        str(Path(fake_state["activeRoot"]) / "CARCOSA") + "/")
    assert out is not None


def test_dotdot_is_rejected(fake_state):
    out = rrs.resolve_selected_repo("ignored",
        str(Path(fake_state["activeRoot"]) / "CARCOSA" / ".." / ".."))
    assert out is None


def test_underscore_canonical_handles_nonexistent_paths(fake_state):
    """explicit_path that does not exist on disk: realpath may resolve to a
    different path. The fix must NOT crash; it should still match against
    the state by abspath fallback or refuse cleanly."""
    out = rrs.resolve_selected_repo("ignored",
        "/this/path/does/not/exist/anywhere")
    assert out is None


# --- End-to-end test against actual user state ---
# This test uses the real ~/.local/state/repociv/state.json — it verifies
# the bug fix against your own real config (the workspace + active root).

def test_real_workspace_carcosa_two_paths_both_pass():
    """CARCOSA must validate from BOTH the state.json path AND the
    bind-mount-equivalent path. This is the bug the user hit."""

    state_file = Path("/home/gris/.local/state/repociv/state.json")
    if not state_file.exists():
        pytest.skip("Real state.json not present; integration test only.")

    os.environ["REPOCIV_STATE_FILE"] = str(state_file)

    out_a = rrs.resolve_selected_repo("ignored",
        "/home/gris/.hermes/workspace/ACTIVE/CARCOSA")
    out_b = rrs.resolve_selected_repo("ignored",
        "/home/gris/workspace/ACTIVE/CARCOSA")

    assert out_a is not None, "path matching state.json should pass"
    assert out_b is not None, "alt bind-mount path must also pass (this is the bug fix)"
    # both should canonicalize to the same inode-level path
    assert os.path.realpath(out_a) == os.path.realpath(out_b)


def test_real_unselected_path_still_rejected():
    state_file = Path("/home/gris/.local/state/repociv/state.json")
    if not state_file.exists():
        pytest.skip("Real state.json not present; integration test only.")
    os.environ["REPOCIV_STATE_FILE"] = str(state_file)

    # /tmp is never a selected repo
    out = rrs.resolve_selected_repo("ignored", "/tmp/anything-not-selected")
    assert out is None
