"""Tests for repo_roots_state.resolve_selected_repo — realpath equivalence.

Regression: previously the validator compared abspath() against the state,
which failed for paths whose bind-mount view differs syntactically from
the state-stored path even though they resolve to the same directory.
"""
from __future__ import annotations

import base64
import json
import os
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


def test_encoded_explicit_path_decodes(fake_state):
    """Chronic chat 403: UI sometimes sends repo:<base64> as explicit_path.

    resolve_selected_repo must decode that before filesystem/canonical checks
    so existing worlds with encoded city.repoPath still validate.
    """
    carcosa = Path(fake_state["activeRoot"]) / "CARCOSA"
    encoded = base64.urlsafe_b64encode(str(carcosa).encode()).decode().rstrip("=")
    out = rrs.resolve_selected_repo("ignored", f"repo:{encoded}")
    assert out is not None
    assert out.endswith("CARCOSA")


def test_encoded_explicit_path_unselected_still_rejected(fake_state):
    encoded = base64.urlsafe_b64encode(b"/tmp/not-selected").decode().rstrip("=")
    out = rrs.resolve_selected_repo("ignored", f"repo:{encoded}")
    assert out is None


def test_underscore_canonical_handles_nonexistent_paths(fake_state):
    """explicit_path that does not exist on disk: realpath may resolve to a
    different path. The fix must NOT crash; it should still match against
    the state by abspath fallback or refuse cleanly."""
    out = rrs.resolve_selected_repo("ignored",
        "/this/path/does/not/exist/anywhere")
    assert out is None


# --- End-to-end test against actual user state ---
# These tests use the real ~/.local/state/repociv/state.json — they verify
# the bug fix against your own real config (workspace + active root).
# Portable: home-relative, and they skip when the state has nothing
# selected yet (fresh machine / post-migration).


def _real_state_file() -> Path:
    return Path.home() / ".local" / "state" / "repociv" / "state.json"


def _real_selected_paths() -> list[str]:
    """Repo paths selected in the real state.json ([] when missing/unreadable)."""
    state_file = _real_state_file()
    if not state_file.exists():
        return []
    try:
        data = json.loads(state_file.read_text(encoding="utf-8"))
    except Exception:
        return []
    roots = data.get("roots") or {}
    if not isinstance(roots, dict):
        return []
    return [
        str(p)
        for entry in roots.values()
        if isinstance(entry, dict)
        for p in (entry.get("selectedRepoPaths") or [])
        if isinstance(p, str)
    ]


def test_real_workspace_carcosa_two_paths_both_pass(tmp_path, monkeypatch):
    """CARCOSA must validate from BOTH the state.json path AND an alternate
    view (symlink) of the same directory — the bind-mount equivalence the
    user hit on WSL, kept alive via realpath()."""

    state_file = _real_state_file()
    if not state_file.exists():
        pytest.skip("Real state.json not present; integration test only.")

    carcosa = next(
        (
            p
            for p in _real_selected_paths()
            if os.path.basename(os.path.normpath(p)) == "CARCOSA" and Path(p).exists()
        ),
        None,
    )
    if carcosa is None:
        pytest.skip("Real state.json has no existing CARCOSA selected; integration test only.")

    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state_file))

    out_a = rrs.resolve_selected_repo("ignored", carcosa)

    # Alternate view of the same directory: the symlink resolves to the same
    # inode-level path, so the validator must accept it too (this is the
    # bug fix the test guards).
    alt = tmp_path / "CARCOSA-alt"
    alt.symlink_to(carcosa)
    out_b = rrs.resolve_selected_repo("ignored", str(alt))

    assert out_a is not None, "path matching state.json should pass"
    assert out_b is not None, "alternate view of the same dir must also pass (this is the bug fix)"
    # both should canonicalize to the same inode-level path
    assert os.path.realpath(out_a) == os.path.realpath(out_b)


def test_real_unselected_path_still_rejected(monkeypatch):
    state_file = _real_state_file()
    if not state_file.exists():
        pytest.skip("Real state.json not present; integration test only.")
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state_file))

    # /tmp is never a selected repo
    out = rrs.resolve_selected_repo("ignored", "/tmp/anything-not-selected")
    assert out is None
