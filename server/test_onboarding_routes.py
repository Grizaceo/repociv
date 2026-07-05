"""Tests for onboarding multi-root endpoints and repo_roots_state write operations."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from server import repo_roots_state as _rrs
from server.routes.onboarding import (
    get_map_roots,
    get_map_root,
    get_repo_selections,
    get_scanned_repos,
    get_selected_repos,
    get_all_roots_repos,
    post_add_map_root,
    post_activate_map_root,
    post_remove_map_root,
    post_persist_selection,
    post_add_selected_repo,
    post_remove_selected_repo,
)


@pytest.fixture
def isolated_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Force state to a fresh tmp file so tests don't touch real state.json."""
    state_file = tmp_path / "state.json"
    monkeypatch.setattr(_rrs, "_state_file", lambda: state_file)
    yield tmp_path


@pytest.fixture
def fake_workspace(tmp_path: Path):
    """Create a fake workspace with 3 repos for scanning tests."""
    root = tmp_path / "workspace"
    root.mkdir()
    # Repo with git
    (root / "repo-alpha").mkdir()
    (root / "repo-alpha" / ".git").mkdir()
    (root / "repo-alpha" / "main.py").write_text("print('hi')")
    # Repo without git
    (root / "repo-beta").mkdir()
    (root / "repo-beta" / "README.md").write_text("# beta")
    # Non-repo (hidden dir should be skipped)
    (root / ".hidden").mkdir()
    # File (should be skipped)
    (root / "random.txt").write_text("not a repo")
    return root


# ── repo_roots_state write operations ───────────────────────────────────────


def test_add_root_creates_entry(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/fake-root")
    state = _rrs.load_state()
    assert "/tmp/fake-root" in state["roots"]
    assert state["roots"]["/tmp/fake-root"]["selectedRepoPaths"] == []


def test_add_root_auto_activates_first(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    state = _rrs.load_state()
    assert state["activeRoot"] == "/tmp/root-a"


def test_add_root_does_not_override_active(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    _rrs.add_root("/tmp/root-b")
    state = _rrs.load_state()
    assert state["activeRoot"] == "/tmp/root-a"


def test_set_active_root(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    _rrs.add_root("/tmp/root-b")
    _rrs.set_active_root("/tmp/root-b")
    assert _rrs.active_root() == "/tmp/root-b"


def test_set_active_root_auto_adds(isolated_state: Path) -> None:
    _rrs.set_active_root("/tmp/new-root")
    state = _rrs.load_state()
    assert "/tmp/new-root" in state["roots"]


def test_remove_root_clears_active_if_needed(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    _rrs.add_root("/tmp/root-b")
    _rrs.set_active_root("/tmp/root-a")
    _rrs.remove_root("/tmp/root-a")
    state = _rrs.load_state()
    assert "/tmp/root-a" not in state["roots"]
    # Should fall back to the other root
    assert state["activeRoot"] == "/tmp/root-b"


def test_remove_last_root_clears_active(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/only-root")
    _rrs.remove_root("/tmp/only-root")
    state = _rrs.load_state()
    assert state["activeRoot"] == ""


def test_set_selection(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    _rrs.set_selection("/tmp/root-a", ["/tmp/root-a/repo1", "/tmp/root-a/repo2"])
    sel = _rrs.get_selection("/tmp/root-a")
    assert sel == ["/tmp/root-a/repo1", "/tmp/root-a/repo2"]


def test_set_selection_creates_root_if_missing(isolated_state: Path) -> None:
    _rrs.set_selection("/tmp/new-root", ["/tmp/new-root/repo1"])
    sel = _rrs.get_selection("/tmp/new-root")
    assert sel == ["/tmp/new-root/repo1"]


def test_add_selected_to_active(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    _rrs.set_active_root("/tmp/root-a")
    _rrs.add_selected("/tmp/root-a/repo1")
    _rrs.add_selected("/tmp/root-a/repo2")
    sel = _rrs.get_selection("/tmp/root-a")
    assert "/tmp/root-a/repo1" in sel
    assert "/tmp/root-a/repo2" in sel


def test_add_selected_no_duplicate(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    _rrs.set_active_root("/tmp/root-a")
    _rrs.add_selected("/tmp/root-a/repo1")
    _rrs.add_selected("/tmp/root-a/repo1")
    sel = _rrs.get_selection("/tmp/root-a")
    assert sel == ["/tmp/root-a/repo1"]


def test_remove_selected(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    _rrs.set_active_root("/tmp/root-a")
    _rrs.add_selected("/tmp/root-a/repo1")
    _rrs.add_selected("/tmp/root-a/repo2")
    _rrs.remove_selected("/tmp/root-a/repo1")
    sel = _rrs.get_selection("/tmp/root-a")
    assert "/tmp/root-a/repo1" not in sel
    assert "/tmp/root-a/repo2" in sel


def test_get_roots_returns_list(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    _rrs.add_root("/tmp/root-b")
    _rrs.set_active_root("/tmp/root-a")
    roots = _rrs.get_roots()
    assert len(roots) == 2
    active = [r for r in roots if r["isActive"]]
    assert len(active) == 1
    assert active[0]["path"] == "/tmp/root-a"


# ── HTTP handlers ───────────────────────────────────────────────────────────


def test_get_map_roots_empty(isolated_state: Path) -> None:
    status, body = get_map_roots({})
    assert status == 200
    assert body["activeRoot"] == ""
    assert body["roots"] == []


def test_get_map_roots_with_data(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    status, body = get_map_roots({})
    assert status == 200
    assert body["activeRoot"] == "/tmp/root-a"
    assert len(body["roots"]) == 1
    assert body["roots"][0]["path"] == "/tmp/root-a"
    assert body["roots"][0]["isActive"] is True


def test_get_map_root_singular(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    status, body = get_map_root({})
    assert status == 200
    assert body["path"] == "/tmp/root-a"


def test_get_repo_selections_empty(isolated_state: Path) -> None:
    status, body = get_repo_selections({})
    assert status == 200
    assert body["hasSelections"] is False
    assert body["roots"] == []


def test_get_repo_selections_with_data(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    _rrs.set_selection("/tmp/root-a", ["/tmp/root-a/repo1"])
    status, body = get_repo_selections({})
    assert status == 200
    assert body["hasSelections"] is True
    assert len(body["roots"]) == 1
    assert body["roots"][0]["selectedRepoPaths"] == ["/tmp/root-a/repo1"]


def test_post_add_map_root_real_dir(
    isolated_state: Path, fake_workspace: Path
) -> None:
    status, body = post_add_map_root({"path": str(fake_workspace)}, {})
    assert status == 200
    assert body["ok"] is True
    assert body["totalRepos"] == 2  # repo-alpha + repo-beta, .hidden skipped


def test_post_add_map_root_nonexistent(isolated_state: Path) -> None:
    status, body = post_add_map_root({"path": "/nonexistent/path"}, {})
    assert status == 400
    assert "error" in body


def test_post_add_map_root_empty_path(isolated_state: Path) -> None:
    status, body = post_add_map_root({"path": ""}, {})
    assert status == 400


def test_post_activate_map_root(
    isolated_state: Path, fake_workspace: Path
) -> None:
    _rrs.add_root("/tmp/other-root")
    status, body = post_activate_map_root({"path": str(fake_workspace)}, {})
    assert status == 200
    assert body["ok"] is True
    assert _rrs.active_root() == str(fake_workspace)


def test_post_activate_map_root_nonexistent(isolated_state: Path) -> None:
    status, body = post_activate_map_root({"path": "/nonexistent"}, {})
    assert status == 400


def test_post_remove_map_root(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    _rrs.add_root("/tmp/root-b")
    status, body = post_remove_map_root({"path": "/tmp/root-a"}, {})
    assert status == 200
    assert body["ok"] is True
    state = _rrs.load_state()
    assert "/tmp/root-a" not in state["roots"]


def test_post_persist_selection(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    status, body = post_persist_selection(
        {"rootPath": "/tmp/root-a", "selectedRepoIds": ["/tmp/root-a/repo1", "/tmp/root-a/repo2"]},
        {},
    )
    assert status == 200
    assert body["hasSelections"] is True
    sel = _rrs.get_selection("/tmp/root-a")
    assert sel == ["/tmp/root-a/repo1", "/tmp/root-a/repo2"]


def test_post_persist_selection_uses_active_root(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    _rrs.set_active_root("/tmp/root-a")
    status, body = post_persist_selection(
        {"selectedRepoIds": ["/tmp/root-a/repo1"]},
        {},
    )
    assert status == 200
    sel = _rrs.get_selection("/tmp/root-a")
    assert "/tmp/root-a/repo1" in sel


def test_post_persist_selection_no_root_no_active(isolated_state: Path) -> None:
    status, body = post_persist_selection(
        {"selectedRepoIds": ["/tmp/repo1"]},
        {},
    )
    assert status == 400


def test_post_add_selected_repo(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    _rrs.set_active_root("/tmp/root-a")
    status, body = post_add_selected_repo({"repoId": "/tmp/root-a/repo1"}, {})
    assert status == 200
    assert body["hasSelections"] is True
    sel = _rrs.get_selection("/tmp/root-a")
    assert "/tmp/root-a/repo1" in sel


def test_post_remove_selected_repo(isolated_state: Path) -> None:
    _rrs.add_root("/tmp/root-a")
    _rrs.set_active_root("/tmp/root-a")
    _rrs.add_selected("/tmp/root-a/repo1")
    _rrs.add_selected("/tmp/root-a/repo2")
    status, body = post_remove_selected_repo({"repoId": "/tmp/root-a/repo1"}, {})
    assert status == 200
    sel = _rrs.get_selection("/tmp/root-a")
    assert "/tmp/root-a/repo1" not in sel
    assert "/tmp/root-a/repo2" in sel


def test_get_scanned_repos(isolated_state: Path, fake_workspace: Path) -> None:
    _rrs.add_root(str(fake_workspace))
    _rrs.set_active_root(str(fake_workspace))
    status, body = get_scanned_repos({})
    assert status == 200
    repos = body["repos"]
    assert len(repos) == 2
    names = [r["name"] for r in repos]
    assert "repo-alpha" in names
    assert "repo-beta" in names
    # .hidden should be skipped
    assert ".hidden" not in names


def test_get_scanned_repos_no_active_root(isolated_state: Path) -> None:
    status, body = get_scanned_repos({})
    assert status == 200
    assert body["repos"] == []


def test_get_scanned_repos_has_git_flag(
    isolated_state: Path, fake_workspace: Path
) -> None:
    _rrs.add_root(str(fake_workspace))
    _rrs.set_active_root(str(fake_workspace))
    status, body = get_scanned_repos({})
    repos = {r["name"]: r for r in body["repos"]}
    assert repos["repo-alpha"]["hasGit"] is True
    assert repos["repo-beta"]["hasGit"] is False


def test_get_selected_repos(
    isolated_state: Path, fake_workspace: Path
) -> None:
    _rrs.add_root(str(fake_workspace))
    _rrs.set_active_root(str(fake_workspace))
    _rrs.set_selection(str(fake_workspace), [str(fake_workspace / "repo-alpha")])
    status, body = get_selected_repos({})
    assert status == 200
    repos = body["repos"]
    assert len(repos) == 1
    assert repos[0]["name"] == "repo-alpha"


def test_get_selected_repos_empty_selection(
    isolated_state: Path, fake_workspace: Path
) -> None:
    _rrs.add_root(str(fake_workspace))
    _rrs.set_active_root(str(fake_workspace))
    status, body = get_selected_repos({})
    assert status == 200
    assert body["repos"] == []


def test_get_all_roots_repos_multiroot(
    isolated_state: Path, fake_workspace: Path
) -> None:
    """GET /api/repos/all-roots returns repos from ALL roots, not just active."""
    # Create a second fake workspace
    second_root = fake_workspace.parent / "second_workspace"
    second_root.mkdir()
    (second_root / "repo-gamma").mkdir()
    (second_root / "repo-gamma" / ".git").mkdir()
    (second_root / "repo-delta").mkdir()

    _rrs.add_root(str(fake_workspace))
    _rrs.add_root(str(second_root))

    # Don't set active root to second — the point is we get repos from both
    status, body = get_all_roots_repos({})
    assert status == 200
    repos = body["repos"]
    names = [r["name"] for r in repos]
    # Should have repos from BOTH roots
    assert "repo-alpha" in names  # from fake_workspace
    assert "repo-beta" in names   # from fake_workspace
    assert "repo-gamma" in names  # from second_root
    assert "repo-delta" in names  # from second_root
    # Each repo should have rootPath set
    for r in repos:
        assert "rootPath" in r
        assert r["rootPath"]  # non-empty
    # Verify rootPath matches the actual root
    alpha = [r for r in repos if r["name"] == "repo-alpha"][0]
    gamma = [r for r in repos if r["name"] == "repo-gamma"][0]
    assert alpha["rootPath"] == str(fake_workspace)
    assert gamma["rootPath"] == str(second_root)


def test_get_all_roots_repos_empty(isolated_state: Path) -> None:
    """No roots registered → empty list."""
    status, body = get_all_roots_repos({})
    assert status == 200
    assert body["repos"] == []