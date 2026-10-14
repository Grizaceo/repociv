"""Regressions found by parent review, exercised with real Git repositories."""
import json
import shutil
import shlex

import pytest

from server import own_sessions, pending_work as pw, suvadu_tracker
from server import test_pending_work as fixtures
from server.test_pending_work import commit, git, init_repo

isolated_state = fixtures.isolated_state
selection = fixtures.selection


def test_return_to_previous_branch_does_not_resurrect_old_episode(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "new").write_text("dirty")
    selection([repo])
    assert pw.collect(now_ms=1000)["entries"][0]["firstObservedAtMs"] == 1000
    git(repo, "switch", "-c", "other")
    assert pw.collect(now_ms=2000)["entries"][0]["firstObservedAtMs"] == 2000
    git(repo, "switch", "main")
    assert pw.collect(now_ms=3000)["entries"][0]["firstObservedAtMs"] == 3000


def test_linked_worktree_age_retained_when_selected_repo_disappears(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    linked = tmp_path / "elsewhere"
    git(repo, "worktree", "add", "-b", "feature", str(linked))
    (linked / "new").write_text("dirty")
    selection([repo])
    pw.collect(now_ms=1000)
    shutil.rmtree(repo)
    result = pw.collect(now_ms=2000)
    entry = next(row for row in result["entries"] if row["worktreePath"] == str(linked))
    assert entry["state"] == "unavailable"
    assert entry["firstObservedAtMs"] == 1000
    assert entry["lastObservedAtMs"] == 1000


def test_empty_active_map_does_not_scan_another_root(tmp_path, selection, monkeypatch):
    other = init_repo(tmp_path / "other")
    commit(other)
    selection([])
    monkeypatch.setattr(suvadu_tracker, "selected_repo_paths", lambda: [str(other)])
    assert pw.collect(now_ms=1000)["entries"] == []


def test_same_git_family_selected_via_two_worktrees_is_not_double_counted(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    linked = tmp_path / "linked"
    git(repo, "worktree", "add", "-b", "feature", str(linked))
    selection([repo, linked])
    result = pw.collect(now_ms=1000)
    assert len(result["entries"]) == 2
    assert len({entry["worktreePath"] for entry in result["entries"]}) == 2


def test_counts_are_files_not_collapsed_untracked_directories(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "nested").mkdir()
    (repo / "nested" / "one").write_text("one")
    (repo / "nested" / "two").write_text("two")
    selection([repo])
    (entry,) = pw.collect(now_ms=1000)["entries"]
    assert entry["untrackedCount"] == 2
    assert entry["changedCount"] == 2


def test_file_type_change_is_counted_staged(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    path = repo / "file"
    path.write_text("base")
    commit(repo)
    path.unlink()
    path.symlink_to("target")
    git(repo, "add", "file")
    selection([repo])
    (entry,) = pw.collect(now_ms=1000)["entries"]
    assert entry["stagedCount"] == 1


def test_selected_plain_directory_cannot_discover_parent_repo(tmp_path, selection, monkeypatch):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    plain = repo / "not-a-repo"
    plain.mkdir()
    selection([plain])
    monkeypatch.delenv("GIT_CEILING_DIRECTORIES")
    (entry,) = pw.collect(now_ms=1000)["entries"]
    assert entry["state"] == "unavailable"
    assert entry["worktreePath"] == str(plain)


def test_own_session_label_never_contains_mission_text(tmp_path, monkeypatch):
    monkeypatch.setattr(own_sessions, "snapshot", lambda: {"agents": [{
        "unit": "unit-1", "cityRepoPath": str(tmp_path), "mission": "SECRET PROMPT CONTENT",
        "state": "idle", "lastActivityAt": "2026-10-13T12:00:00Z",
    }]})
    rows, _ = pw._related_sessions(str(tmp_path))
    assert rows and "SECRET PROMPT" not in json.dumps(rows)


def test_file_list_cap_is_explicit_not_silent(tmp_path, selection, monkeypatch):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    for i in range(5):
        (repo / str(i)).write_text("x")
    selection([repo])
    monkeypatch.setattr(pw, "_MAX_FILES_PER_ENTRY", 2)
    result = pw.collect(now_ms=1000)
    assert result["entries"][0]["changedCount"] == 5
    assert result["errors"] and any("files" in error for error in result["errors"])


def test_budget_applies_within_one_repo_not_just_between_repos(tmp_path, selection, monkeypatch):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    for i in range(5):
        git(repo, "worktree", "add", "-b", f"feature-{i}", str(tmp_path / f"linked-{i}"))
    selection([repo])
    clock = [0.0]
    original = pw._git
    status_calls = []

    def delayed(args, cwd, **kwargs):
        result = original(args, cwd, **kwargs)
        if args[0] == "status":
            status_calls.append(cwd)
            clock[0] += 1
        return result

    monkeypatch.setattr(pw, "_git", delayed)
    monkeypatch.setattr(pw.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(pw, "_SCAN_BUDGET_S", 2.0)
    result = pw.collect(now_ms=1000)
    assert len(status_calls) <= 2
    assert any("budget" in error for error in result["errors"])
    assert any(row["state"] == "unavailable" for row in result["entries"])


def test_corrupt_timestamps_are_visible_instead_of_invalid_frontend_payload(tmp_path, selection, isolated_state):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "new").write_text("dirty")
    selection([repo])
    pw.collect(now_ms=1000)
    data = json.loads(isolated_state.read_text())
    record = next(iter(data["episodes"].values()))
    record["firstObservedAtMs"] = -100
    isolated_state.write_text(json.dumps(data))
    result = pw.collect(now_ms=2000)
    assert result.get("persistenceError")
    assert result["entries"][0]["firstObservedAtMs"] == 2000


@pytest.mark.parametrize("child_first", [False, True])
def test_nested_repo_fresh_sample_beats_parent_retention(tmp_path, selection, child_first):
    outer = init_repo(tmp_path / "outer")
    commit(outer)
    inner = init_repo(outer / "inner")
    commit(inner)
    (outer / "outer-change").write_text("dirty")
    (inner / "inner-change").write_text("dirty")
    selection([inner, outer] if child_first else [outer, inner])
    pw.collect(now_ms=1000)
    (outer / ".git").rename(outer / ".git-offline")
    result = pw.collect(now_ms=2000)
    by_path = {row["worktreePath"]: row for row in result["entries"]}
    assert len(result["entries"]) == 2
    assert by_path[str(outer)]["state"] == "unavailable"
    assert by_path[str(inner)]["state"] == "dirty"
    assert by_path[str(inner)]["changedCount"] == 1
    assert by_path[str(inner)]["repoPath"] == str(inner)
    assert by_path[str(inner)]["firstObservedAtMs"] == 1000
    assert by_path[str(inner)]["lastObservedAtMs"] == 2000


def test_unreadable_parent_does_not_reintroduce_deselected_nested_repo(tmp_path, selection):
    outer = init_repo(tmp_path / "outer")
    commit(outer)
    inner = init_repo(outer / "inner")
    commit(inner)
    (outer / "outer-change").write_text("dirty")
    (inner / "inner-change").write_text("dirty")
    selection([outer, inner])
    pw.collect(now_ms=1000)
    selection([outer])
    (outer / ".git").rename(outer / ".git-offline")
    result = pw.collect(now_ms=2000)
    assert len(result["entries"]) == 1
    assert result["entries"][0]["worktreePath"] == str(outer)
    assert result["entries"][0]["state"] == "unavailable"


@pytest.mark.parametrize("old_first", [False, True])
def test_publish_prefers_confirmed_state_over_retained_state(tmp_path, old_first):
    fresh = pw._entry(repo_path=str(tmp_path), worktree_path=str(tmp_path), branch="main", detached=False, head="abc", now_ms=2000)
    fresh.update(state="dirty", changedCount=1, firstObservedAtMs=1000, lastObservedAtMs=2000)
    retained = {**fresh, "state": "unavailable", "changedCount": 0, "lastObservedAtMs": 1000}
    rows = [retained, fresh] if old_first else [fresh, retained]
    result = pw._publish(rows, [], None, 2000, (), True)
    assert result["entries"] == [fresh]


def test_sampling_strips_inherited_git_config_injection(monkeypatch):
    injected = {
        "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.fsmonitor",
        "GIT_CONFIG_VALUE_0": "ignored", "GIT_CONFIG_PARAMETERS": "ignored",
    }
    for key, value in injected.items():
        monkeypatch.setenv(key, value)
    assert not set(injected) & set(pw._git_env())


def test_sampling_does_not_execute_configured_fsmonitor_hook(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    marker = tmp_path / "hook-was-run"
    hook = tmp_path / "fsmonitor-hook"
    hook.write_text("#!/bin/sh\nprintf executed > " + shlex.quote(str(marker)) + "\nprintf '\\0'\n")
    hook.chmod(0o755)
    git(repo, "config", "core.fsmonitor", str(hook))
    (repo / "dirty").write_text("x")
    selection([repo])
    result = pw.collect(now_ms=1000)
    assert result["entries"][0]["state"] == "dirty"
    assert not marker.exists()
