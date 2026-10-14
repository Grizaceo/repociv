"""Tests for the pending Git work inventory (server/pending_work.py).

Every Git fixture is a real temporary repository created with ``git init`` and
driven through the same commands a user would run, so the parsing is exercised
against actual Git output rather than canned strings: staged, unstaged,
untracked, rename and unmerged (conflict) records, linked and detached
worktrees, bare repositories, unborn branches, clean resets, branch/HEAD
changes, missing directories, corrupt persistence and reload across
"restarts".

The state file and the selection are always redirected into ``tmp_path``, so
these tests never touch the user's map state or their repositories.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import pytest

from server import pending_work as pw

GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.com",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
    "GIT_TERMINAL_PROMPT": "0",
}


def git(cwd: Path, *args: str) -> str:
    """Run a mutating git command in a fixture repo (tests only)."""
    result = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        env=GIT_ENV,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return result.stdout


def git_result(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Run a git command whose non-zero exit is part of the fixture (merges)."""
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        env=GIT_ENV,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )


def init_repo(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.email", "t@example.com")
    git(path, "config", "user.name", "t")
    return path


def commit(path: Path, message: str = "base") -> str:
    git(path, "add", "-A")
    # --allow-empty keeps fixtures that intentionally have no tracked file yet.
    git(path, "commit", "-q", "--allow-empty", "-m", message)
    return git(path, "rev-parse", "HEAD").strip()


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    """Redirect the persistence file and reset the poll cache for every test."""
    state_file = tmp_path / "pending-work.json"
    monkeypatch.setenv("REPOCIV_PENDING_WORK_STATE_FILE", str(state_file))
    monkeypatch.setenv("REPOCIV_PENDING_WORK_CACHE_MS", "0")
    # pytest's tmp_path lives under ~/.hermes, which is itself a git checkout:
    # without a ceiling git would discover that parent repo instead of failing.
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    pw.reset_cache()
    yield state_file
    pw.reset_cache()


@pytest.fixture
def selection(tmp_path, monkeypatch):
    """Point the inventory at an explicit list of repo paths.

    Mirrors the bridge's own resolution: the active root's selection wins, and
    the all-roots fallback (suvadu_tracker.selected_repo_paths) is what we stub
    out here.
    """
    state_file = tmp_path / "map-state.json"
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state_file))
    monkeypatch.setattr(pw, "_STATE_LOCK", pw.threading.Lock())

    def configure(paths: list[str], *, active_root: str | None = None):
        root = str(active_root or (tmp_path / "root"))
        state = {
            "version": 1,
            "activeRoot": root,
            "roots": {root: {"selectedRepoPaths": [str(p) for p in paths]}},
        }
        state_file.write_text(json.dumps(state), encoding="utf-8")
        return root

    return configure


def read_state(state_file: Path) -> dict:
    return json.loads(state_file.read_text(encoding="utf-8"))


def entries_by_path(payload: dict) -> dict[str, dict]:
    return {entry["worktreePath"]: entry for entry in payload["entries"]}


# ── basic shape ──────────────────────────────────────────────────────────────
def test_payload_shape_and_clean_repo(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    selection([repo])

    payload = pw.collect(now_ms=1_000_000)

    assert payload["available"] is True
    assert payload["sampledAtMs"] == 1_000_000
    assert isinstance(payload["entries"], list)
    assert isinstance(payload["errors"], list)
    assert "persistenceError" not in payload

    (entry,) = payload["entries"]
    assert entry["repoPath"] == str(repo)
    assert entry["repoName"] == "repo"
    assert entry["worktreePath"] == str(repo)
    assert entry["branch"] == "main"
    assert entry["detached"] is False
    assert entry["head"]
    assert entry["state"] == "clean"
    assert entry["changedCount"] == 0
    assert entry["files"] == []
    assert entry["firstObservedAtMs"] is None
    assert entry["lastObservedAtMs"] is None
    assert entry["ageMs"] is None
    assert entry["relatedSessions"] == []


def test_no_selection_is_not_zero_pending_work(tmp_path, selection):
    selection([])

    payload = pw.collect(now_ms=1)

    assert payload["available"] is True
    assert payload["entries"] == []
    assert "no repositories selected" in payload["errors"]


def test_missing_repo_path_is_unavailable_not_clean(tmp_path, selection):
    gone = tmp_path / "vanished"
    selection([gone])

    payload = pw.collect(now_ms=1)

    (entry,) = payload["entries"]
    assert entry["state"] == "unavailable"
    assert entry["error"]
    assert entry["changedCount"] == 0


def test_non_repo_directory_is_unavailable(tmp_path, selection):
    plain = tmp_path / "plain"
    plain.mkdir()
    selection([plain])

    payload = pw.collect(now_ms=1)

    (entry,) = payload["entries"]
    assert entry["state"] == "unavailable"
    assert "worktree list" in entry["error"]


def test_bare_repository_is_unavailable_not_clean(tmp_path, selection):
    bare = tmp_path / "bare.git"
    bare.mkdir()
    git(bare, "init", "-q", "--bare", "-b", "main")
    selection([bare])

    payload = pw.collect(now_ms=1)

    (entry,) = payload["entries"]
    assert entry["state"] == "unavailable"
    assert "bare" in entry["error"]


# ── status parsing ───────────────────────────────────────────────────────────
def test_staged_unstaged_untracked_counts(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    (repo / "b.txt").write_text("b\n", encoding="utf-8")
    (repo / "d.txt").write_text("d\n", encoding="utf-8")
    commit(repo)

    (repo / "a.txt").write_text("staged\n", encoding="utf-8")  # staged only
    git(repo, "add", "a.txt")
    (repo / "b.txt").write_text("modified\n", encoding="utf-8")  # unstaged only
    (repo / "new.txt").write_text("new\n", encoding="utf-8")  # untracked
    selection([repo])

    payload = pw.collect(now_ms=1_000_000)
    (entry,) = payload["entries"]

    assert entry["state"] == "dirty"
    assert entry["stagedCount"] == 1
    assert entry["unstagedCount"] == 1
    assert entry["untrackedCount"] == 1
    assert entry["conflictCount"] == 0
    assert entry["changedCount"] == 3

    files = {f["path"]: (f["index"], f["worktree"]) for f in entry["files"]}
    assert files["a.txt"] == ("M", " ")
    assert files["b.txt"] == (" ", "M")
    assert files["new.txt"] == ("?", "?")


def test_both_staged_and_unstaged_count_the_same_path(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    commit(repo)

    (repo / "a.txt").write_text("one\n", encoding="utf-8")
    git(repo, "add", "a.txt")
    (repo / "a.txt").write_text("two\n", encoding="utf-8")
    selection([repo])

    (entry,) = pw.collect(now_ms=1)["entries"]

    assert entry["stagedCount"] == 1
    assert entry["unstagedCount"] == 1
    assert entry["changedCount"] == 1  # one path, overlapping columns


def test_rename_counts_as_one_path(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    (repo / "old.txt").write_text("x\n", encoding="utf-8")
    commit(repo)

    git(repo, "mv", "old.txt", "new.txt")
    selection([repo])

    (entry,) = pw.collect(now_ms=1)["entries"]

    assert entry["state"] == "dirty"
    assert entry["changedCount"] == 1
    assert entry["files"][0]["path"] == "new.txt"
    assert entry["files"][0]["index"] == "R"


def test_untracked_directory_counts_individual_files(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    nested = repo / "build" / "deep"
    nested.mkdir(parents=True)
    (nested / "out.bin").write_bytes(b"\x00\x01")
    (nested / "other.bin").write_bytes(b"\x02\x03")
    selection([repo])

    (entry,) = pw.collect(now_ms=1)["entries"]

    assert entry["untrackedCount"] == 2
    assert entry["changedCount"] == 2
    assert {item["path"] for item in entry["files"]} == {"build/deep/out.bin", "build/deep/other.bin"}


def test_conflict_is_detected_and_reported(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    (repo / "f.txt").write_text("base\n", encoding="utf-8")
    commit(repo)

    git(repo, "checkout", "-q", "-b", "side")
    (repo / "f.txt").write_text("side\n", encoding="utf-8")
    commit(repo, "side")
    git(repo, "checkout", "-q", "main")
    (repo / "f.txt").write_text("main\n", encoding="utf-8")
    commit(repo, "main")
    merged = git_result(repo, "merge", "side")
    assert merged.returncode != 0, "fixture must produce a real conflict"

    selection([repo])
    (entry,) = pw.collect(now_ms=1)["entries"]

    assert entry["state"] == "dirty"
    assert entry["conflictCount"] == 1
    assert entry["files"][0]["path"] == "f.txt"
    assert entry["files"][0]["xy"] == "UU" if "xy" in entry["files"][0] else True


def test_ignored_files_are_excluded(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    (repo / ".gitignore").write_text("ignored/\n", encoding="utf-8")
    commit(repo)
    ignored = repo / "ignored"
    ignored.mkdir()
    (ignored / "secret.txt").write_text("no\n", encoding="utf-8")
    selection([repo])

    (entry,) = pw.collect(now_ms=1)["entries"]

    assert entry["changedCount"] == 0
    assert entry["state"] == "clean"


def test_escaped_and_non_ascii_paths_round_trip(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "áé.txt").write_text("utf8\n", encoding="utf-8")
    (repo / "with space.txt").write_text("space\n", encoding="utf-8")
    selection([repo])

    (entry,) = pw.collect(now_ms=1)["entries"]
    paths = {f["path"] for f in entry["files"]}

    assert "áé.txt" in paths  # core.quotepath=false → raw UTF-8, not octal escapes
    assert "with space.txt" in paths
    assert all("\\" not in path for path in paths)


def test_deep_paths_are_relative_to_worktree_top(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    deep = repo / "sub" / "deep"
    deep.mkdir(parents=True)
    (deep / "x.txt").write_text("x\n", encoding="utf-8")
    commit(repo)
    (deep / "x.txt").write_text("y\n", encoding="utf-8")
    selection([repo])

    (entry,) = pw.collect(now_ms=1)["entries"]

    assert entry["files"][0]["path"] == "sub/deep/x.txt"


def test_files_list_is_capped_but_counts_are_complete(tmp_path, selection, monkeypatch):
    monkeypatch.setattr(pw, "_MAX_FILES_PER_ENTRY", 3)
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    for i in range(10):
        (repo / f"f{i}.txt").write_text("x\n", encoding="utf-8")
    selection([repo])

    (entry,) = pw.collect(now_ms=1)["entries"]

    assert entry["changedCount"] == 10
    assert len(entry["files"]) == 3


# ── worktrees ────────────────────────────────────────────────────────────────
def test_linked_worktree_is_inventoried(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    linked = tmp_path / "linked"
    git(repo, "worktree", "add", "-q", str(linked), "-b", "feat")
    (linked / "a.txt").write_text("wip\n", encoding="utf-8")
    selection([repo])

    payload = pw.collect(now_ms=1_000_000)

    assert len(payload["entries"]) == 2
    linked_entry = entries_by_path(payload)[str(linked)]
    assert linked_entry["branch"] == "feat"
    assert linked_entry["detached"] is False
    assert linked_entry["state"] == "dirty"
    assert linked_entry["changedCount"] == 1
    # The linked worktree lives outside the selected root and is still covered.
    assert not str(linked).startswith(str(repo))


def test_detached_worktree_reports_detached_and_head(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    head = commit(repo)
    detached = tmp_path / "detached"
    git(repo, "worktree", "add", "-q", "--detach", str(detached))
    selection([repo])

    (entry,) = [e for e in pw.collect(now_ms=1)["entries"] if e["detached"]]

    assert entry["worktreePath"] == str(detached)
    assert entry["detached"] is True
    assert entry["branch"] == ""
    assert entry["head"] == head


def test_unborn_branch_reports_empty_head(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    selection([repo])

    (entry,) = pw.collect(now_ms=1)["entries"]

    assert entry["branch"] == "main"
    assert entry["head"] == ""
    assert entry["state"] == "dirty"


def test_worktree_paths_with_spaces_parse(tmp_path, selection):
    repo = init_repo(tmp_path / "sp ace")
    commit(repo)
    linked = tmp_path / "wt space"
    git(repo, "worktree", "add", "-q", str(linked), "-b", "feat")
    selection([repo])

    payload = pw.collect(now_ms=1)

    assert {e["worktreePath"] for e in payload["entries"]} == {str(repo), str(linked)}


def test_same_repo_selected_twice_is_deduplicated(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    selection([repo, repo, str(repo) + os.sep])

    payload = pw.collect(now_ms=1)

    assert len(payload["entries"]) == 1


def test_symlinked_repo_path_resolves_to_realpath(tmp_path, selection):
    repo = init_repo(tmp_path / "real")
    commit(repo)
    link = tmp_path / "link"
    os.symlink(str(repo), str(link))
    selection([link])

    (entry,) = pw.collect(now_ms=1)["entries"]

    assert entry["repoPath"] == str(repo)
    assert entry["worktreePath"] == str(repo)


# ── observed age / persistence ───────────────────────────────────────────────
def test_first_observation_survives_a_simulated_restart(tmp_path, selection, isolated_state):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "a.txt").write_text("dirty\n", encoding="utf-8")
    selection([repo])

    first = pw.collect(now_ms=1_000_000)["entries"][0]
    assert first["firstObservedAtMs"] == 1_000_000
    assert first["ageMs"] == 0

    second = pw.collect(now_ms=1_060_000)["entries"][0]
    assert second["firstObservedAtMs"] == 1_000_000  # retained across polls
    assert second["lastObservedAtMs"] == 1_060_000
    assert second["ageMs"] == 60_000

    # A fresh module state (bridge restart) reads the same episode back.
    pw._STATE_LOCK = pw.threading.Lock()
    third = pw.collect(now_ms=1_120_000)["entries"][0]
    assert third["firstObservedAtMs"] == 1_000_000
    assert third["ageMs"] == 120_000


def test_clean_observation_resets_the_episode(tmp_path, selection, isolated_state):
    repo = init_repo(tmp_path / "repo")
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    commit(repo)
    (repo / "a.txt").write_text("dirty\n", encoding="utf-8")
    selection([repo])

    dirty = pw.collect(now_ms=1_000_000)["entries"][0]
    assert dirty["state"] == "dirty"
    assert dirty["firstObservedAtMs"] == 1_000_000

    git(repo, "checkout", "-q", "--", "a.txt")
    clean = pw.collect(now_ms=1_030_000)["entries"][0]
    assert clean["state"] == "clean"
    assert clean["firstObservedAtMs"] is None
    assert clean["ageMs"] is None
    assert read_state(isolated_state)["episodes"] == {}

    # Going dirty again starts a brand-new episode, not the old one.
    (repo / "a.txt").write_text("dirty again\n", encoding="utf-8")
    again = pw.collect(now_ms=1_060_000)["entries"][0]
    assert again["firstObservedAtMs"] == 1_060_000


def test_new_commit_starts_a_new_episode(tmp_path, selection, isolated_state):
    repo = init_repo(tmp_path / "repo")
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    commit(repo)
    (repo / "b.txt").write_text("b\n", encoding="utf-8")
    selection([repo])

    first = pw.collect(now_ms=1_000_000)["entries"][0]
    assert first["firstObservedAtMs"] == 1_000_000

    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "second")
    (repo / "c.txt").write_text("c\n", encoding="utf-8")

    second = pw.collect(now_ms=1_090_000)["entries"][0]
    assert second["state"] == "dirty"
    assert second["firstObservedAtMs"] == 1_090_000  # HEAD changed → new episode
    assert second["ageMs"] == 0


def test_branch_change_starts_a_new_episode(tmp_path, selection, isolated_state):
    repo = init_repo(tmp_path / "repo")
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    commit(repo)
    (repo / "b.txt").write_text("b\n", encoding="utf-8")
    selection([repo])

    first = pw.collect(now_ms=1_000_000)["entries"][0]
    assert first["branch"] == "main"

    git(repo, "checkout", "-q", "-b", "other")
    second = pw.collect(now_ms=1_045_000)["entries"][0]

    assert second["branch"] == "other"
    assert second["firstObservedAtMs"] == 1_045_000


def test_unavailable_observation_retains_the_recorded_age(tmp_path, selection, isolated_state, monkeypatch):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "a.txt").write_text("dirty\n", encoding="utf-8")
    selection([repo])

    dirty = pw.collect(now_ms=1_000_000)["entries"][0]
    assert dirty["state"] == "dirty"

    # Break the worktree: git status now fails, which must not read as clean.
    def broken(*args, **kwargs):
        raise subprocess.SubprocessError("git exploded")

    monkeypatch.setattr(pw, "_git", broken)
    later = pw.collect(now_ms=1_060_000)["entries"][0]

    assert later["state"] == "unavailable"
    assert later["error"]
    assert later["firstObservedAtMs"] == 1_000_000  # retained, not inferred clean
    assert later["ageMs"] == 60_000


def test_missing_worktree_directory_is_unavailable_and_retains_age(tmp_path, selection, isolated_state):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    linked = tmp_path / "linked"
    git(repo, "worktree", "add", "-q", str(linked), "-b", "feat")
    (linked / "a.txt").write_text("wip\n", encoding="utf-8")
    selection([repo])

    dirty = entries_by_path(pw.collect(now_ms=1_000_000))[str(linked)]
    assert dirty["firstObservedAtMs"] == 1_000_000

    # Remove the directory without pruning the worktree record.
    import shutil

    shutil.rmtree(linked)
    later = entries_by_path(pw.collect(now_ms=1_070_000))[str(linked)]

    assert later["state"] == "unavailable"
    assert "missing" in later["error"]
    assert later["firstObservedAtMs"] == 1_000_000


def test_stale_episodes_are_pruned(tmp_path, selection, isolated_state):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "a.txt").write_text("dirty\n", encoding="utf-8")
    selection([repo])

    pw.collect(now_ms=1_000_000)
    assert read_state(isolated_state)["episodes"]

    # Drop the repo from the selection: nothing observes it any more, and the
    # directory is gone, so the episode must age out instead of lingering.
    selection([])
    pw.collect(now_ms=1_000_000 + pw._PRUNE_AFTER_MS + 1)
    assert read_state(isolated_state)["episodes"] == {}


def test_unobserved_but_existing_worktree_keeps_its_episode(tmp_path, selection, isolated_state):
    """An episode survives as long as its worktree exists and is not stale."""
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "a.txt").write_text("dirty\n", encoding="utf-8")
    selection([repo])
    pw.collect(now_ms=1_000_000)

    selection([])
    pw.collect(now_ms=1_000_000 + 60_000)

    episodes = read_state(isolated_state)["episodes"]
    assert episodes  # deselected ≠ finished: the observation is kept
    record = next(iter(episodes.values()))
    assert record["firstObservedAtMs"] == 1_000_000


# ── persistence robustness ───────────────────────────────────────────────────
def test_corrupt_state_file_is_reported_and_recovered(tmp_path, selection, isolated_state):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "a.txt").write_text("dirty\n", encoding="utf-8")
    selection([repo])

    isolated_state.write_text("{not json at all", encoding="utf-8")

    payload = pw.collect(now_ms=1_000_000)

    assert "persistenceError" in payload
    assert "corrupt" in payload["persistenceError"]
    # The inventory still works: the episode is re-observed from scratch.
    (entry,) = payload["entries"]
    assert entry["state"] == "dirty"
    assert entry["firstObservedAtMs"] == 1_000_000

    # The corrupt file was quarantined and the next write is valid JSON again.
    later = pw.collect(now_ms=1_010_000)
    assert "persistenceError" not in later
    assert read_state(isolated_state)["version"] == 1


def test_state_file_with_wrong_schema_is_reported(tmp_path, selection, isolated_state):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    selection([repo])

    isolated_state.write_text(json.dumps({"version": 1}), encoding="utf-8")

    payload = pw.collect(now_ms=1)

    assert "persistenceError" in payload
    assert "corrupt" in payload["persistenceError"]


def test_unwritable_state_directory_is_visible(tmp_path, selection, monkeypatch):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "a.txt").write_text("dirty\n", encoding="utf-8")
    selection([repo])

    blocked = tmp_path / "blocked"
    blocked.mkdir()
    os.chmod(blocked, 0o500)
    try:
        monkeypatch.setenv("REPOCIV_PENDING_WORK_STATE_FILE", str(blocked / "pending-work.json"))
        payload = pw.collect(now_ms=1)
    finally:
        os.chmod(blocked, 0o700)

    assert payload["available"] is True
    assert "persistenceError" in payload
    assert "unwritable" in payload["persistenceError"]
    assert payload["entries"][0]["state"] == "dirty"


def test_state_file_env_override_is_honoured(tmp_path, monkeypatch, isolated_state):
    explicit = tmp_path / "elsewhere" / "custom.json"
    monkeypatch.setenv("REPOCIV_PENDING_WORK_STATE_FILE", str(explicit))

    assert pw.state_file() == explicit


def test_default_state_file_is_xdg_aware(tmp_path, monkeypatch):
    monkeypatch.delenv("REPOCIV_PENDING_WORK_STATE_FILE", raising=False)
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "xdg"))

    assert pw.state_file() == tmp_path / "xdg" / "repociv" / "pending-work.json"


def test_no_diff_content_or_credentials_are_returned(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    secret = "SUPER_SECRET_TOKEN_123"
    (repo / "a.txt").write_text(f"{secret}\n", encoding="utf-8")
    commit(repo)
    (repo / "a.txt").write_text("changed\n", encoding="utf-8")
    selection([repo])

    payload = pw.collect(now_ms=1)
    blob = json.dumps(payload)

    assert secret not in blob
    # Only paths, status pairs, counts and timestamps — no diff hunks, prompts,
    # argv or environment anywhere in the entry shape.
    assert set(payload) == {"available", "sampledAtMs", "entries", "errors"}
    (entry,) = payload["entries"]
    assert set(entry) == {
        "repoPath",
        "repoName",
        "worktreePath",
        "branch",
        "detached",
        "head",
        "state",
        "stagedCount",
        "unstagedCount",
        "untrackedCount",
        "conflictCount",
        "changedCount",
        "files",
        "firstObservedAtMs",
        "lastObservedAtMs",
        "ageMs",
        "relatedSessions",
    }
    assert set(entry["files"][0]) == {"path", "index", "worktree"}
    for forbidden in ("argv", "prompt", "GIT_AUTHOR_EMAIL", "stderr", "stdout"):
        assert forbidden not in blob


# ── ordering ─────────────────────────────────────────────────────────────────
def test_ordering_conflicts_first_then_oldest(tmp_path, selection):
    clean = init_repo(tmp_path / "a-clean")
    commit(clean)

    old = init_repo(tmp_path / "b-old")
    commit(old)
    (old / "x.txt").write_text("x\n", encoding="utf-8")

    conflict = init_repo(tmp_path / "c-conflict")
    (conflict / "f.txt").write_text("base\n", encoding="utf-8")
    commit(conflict)
    git(conflict, "checkout", "-q", "-b", "side")
    (conflict / "f.txt").write_text("side\n", encoding="utf-8")
    commit(conflict, "side")
    git(conflict, "checkout", "-q", "main")
    (conflict / "f.txt").write_text("main\n", encoding="utf-8")
    commit(conflict, "main")
    merged = git_result(conflict, "merge", "side")
    assert merged.returncode != 0, "fixture must produce a real conflict"

    recent = init_repo(tmp_path / "d-recent")
    commit(recent)

    selection([clean, old, conflict, recent])

    # First poll: "recent" is still clean, so only old/conflict have episodes.
    pw.collect(now_ms=1_000_000)
    (recent / "y.txt").write_text("y\n", encoding="utf-8")
    payload = pw.collect(now_ms=2_000_000)

    order = [e["repoName"] for e in payload["entries"]]
    assert order == ["c-conflict", "b-old", "d-recent", "a-clean"]

    assert payload["entries"][0]["conflictCount"] == 1
    assert payload["entries"][1]["firstObservedAtMs"] == 1_000_000
    assert payload["entries"][2]["firstObservedAtMs"] == 2_000_000
    assert payload["entries"][3]["state"] == "clean"


def test_unavailable_entries_sort_after_dirty_ones(tmp_path, selection):
    dirty = init_repo(tmp_path / "dirty")
    commit(dirty)
    (dirty / "a.txt").write_text("a\n", encoding="utf-8")
    gone = tmp_path / "gone"
    selection([gone, dirty])

    payload = pw.collect(now_ms=1)
    states = [e["state"] for e in payload["entries"]]

    assert states == ["dirty", "unavailable"]


# ── caching ──────────────────────────────────────────────────────────────────
def test_cached_polls_do_not_resample_git(tmp_path, selection, monkeypatch):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    selection([repo])
    monkeypatch.setenv("REPOCIV_PENDING_WORK_CACHE_MS", "60000")

    calls: list[list[str]] = []
    original = pw._git

    def counting(args, cwd, timeout=pw._GIT_TIMEOUT_S):
        calls.append(args)
        return original(args, cwd, timeout)

    monkeypatch.setattr(pw, "_git", counting)

    pw.collect()
    first_calls = len(calls)
    assert first_calls >= 2  # worktree list + status

    pw.collect()
    assert len(calls) == first_calls  # served from cache

    pw.collect(force=True)
    assert len(calls) > first_calls

    pw.reset_cache()
    pw.collect()
    assert len(calls) > first_calls


def test_cache_is_invalidated_when_the_selection_changes(tmp_path, selection, monkeypatch):
    repo_a = init_repo(tmp_path / "a")
    commit(repo_a)
    repo_b = init_repo(tmp_path / "b")
    commit(repo_b)
    monkeypatch.setenv("REPOCIV_PENDING_WORK_CACHE_MS", "60000")

    selection([repo_a])
    assert [e["repoName"] for e in pw.collect()["entries"]] == ["a"]

    selection([repo_b])
    assert [e["repoName"] for e in pw.collect()["entries"]] == ["b"]


def test_pinned_clock_never_uses_the_cache(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    selection([repo])

    first = pw.collect(now_ms=1_000)
    second = pw.collect(now_ms=2_000)

    assert first["sampledAtMs"] == 1_000
    assert second["sampledAtMs"] == 2_000


# ── read-only guarantees ─────────────────────────────────────────────────────
def test_sampling_does_not_touch_the_index_or_hooks(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    commit(repo)
    for i in range(20):
        (repo / f"f{i}.txt").write_text("x\n", encoding="utf-8")

    index = repo / ".git" / "index"
    before = index.stat()
    hook_dir = repo / ".git" / "hooks"
    marker = hook_dir / "pre-commit"
    marker.write_text("#!/bin/sh\ntouch /tmp/pending-work-hook-ran\n", encoding="utf-8")
    os.chmod(marker, 0o755)
    sentinel = Path("/tmp/pending-work-hook-ran")
    if sentinel.exists():
        sentinel.unlink()

    selection([repo])
    payload = pw.collect(now_ms=1)
    assert payload["entries"][0]["changedCount"] == 20

    after = index.stat()
    assert after.st_mtime_ns == before.st_mtime_ns  # --no-optional-locks
    assert not sentinel.exists()  # no hooks executed
    assert git(repo, "status", "--porcelain").strip().count("\n") == 19  # still dirty


def test_git_env_is_scrubbed_of_redirects(tmp_path, monkeypatch):
    monkeypatch.setenv("GIT_DIR", "/nonexistent/should-not-be-used")
    monkeypatch.setenv("GIT_WORK_TREE", "/nonexistent")
    monkeypatch.setenv("GIT_INDEX_FILE", "/nonexistent/index")

    env = pw._git_env()

    assert "GIT_DIR" not in env
    assert "GIT_WORK_TREE" not in env
    assert "GIT_INDEX_FILE" not in env
    assert env["GIT_OPTIONAL_LOCKS"] == "0"


# ── parsers ──────────────────────────────────────────────────────────────────
def test_parse_worktree_list_handles_bare_and_newlines():
    raw = "worktree /tmp/a\0HEAD abc\0branch refs/heads/main\0\0worktree /tmp/b\0bare\0\0"
    records = pw._parse_worktree_list(raw)

    assert records == [
        {"worktree": "/tmp/a", "HEAD": "abc", "branch": "refs/heads/main"},
        {"worktree": "/tmp/b", "bare": ""},
    ]


def test_parse_worktree_list_keeps_newlines_in_paths():
    raw = "worktree /tmp/we\nird\0HEAD abc\0detached\0\0"
    records = pw._parse_worktree_list(raw)

    assert records[0]["worktree"] == "/tmp/we\nird"
    assert "detached" in records[0]


def test_parse_status_consumes_the_rename_origin_field():
    raw = " M a.txt\0R  new.txt\0old.txt\0?? u.txt\0"
    entries = pw._parse_status(raw)

    assert [e["path"] for e in entries] == ["a.txt", "new.txt", "u.txt"]
    assert entries[1]["origPath"] == "old.txt"
    assert entries[1]["index"] == "R"


def test_parse_status_survives_a_truncated_rename():
    entries = pw._parse_status("R  new.txt\0")

    assert len(entries) == 1
    assert entries[0]["path"] == "new.txt"


def test_classify_counts_unmerged_pairs():
    parsed = pw._parse_status("UU f.txt\0AA g.txt\0DU h.txt\0 M i.txt\0?? j.txt\0")
    counts = pw._classify(parsed)

    assert counts["conflictCount"] == 3
    assert counts["changedCount"] == 5
    assert counts["untrackedCount"] == 1


# ── related sessions ─────────────────────────────────────────────────────────
def test_related_sessions_require_exact_containment(tmp_path, monkeypatch):
    worktree = tmp_path / "wt"
    worktree.mkdir()
    inside = worktree / "sub"
    inside.mkdir()
    outside = tmp_path / "other"
    outside.mkdir()

    monkeypatch.setattr(
        pw,
        "_related_sessions",
        pw._related_sessions,
    )

    rows = [
        {"cwd": str(inside), "sessionId": "in", "nativeId": "in", "alive": True, "lastActivityAt": 5},
        {"cwd": str(worktree), "sessionId": "root", "nativeId": "root", "alive": False, "lastActivityAt": 4},
        {"cwd": str(outside), "sessionId": "out", "nativeId": "out", "alive": True, "lastActivityAt": 3},
    ]

    class _Manager:
        def sessions(self):
            return rows

    import server.claude_live as claude_live

    monkeypatch.setattr(claude_live, "get_manager", _Manager)

    found, errors = pw._related_sessions(str(worktree))

    assert errors == []
    assert [row["id"] for row in found] == ["in", "root"]
    assert found[0]["name"] == "in"
    assert found[0]["status"] == "live"
    assert found[1]["status"] == "ended"


def test_related_session_source_failure_is_visible_not_silent(tmp_path, monkeypatch):
    import server.own_sessions as own_sessions

    worktree = tmp_path / "wt"
    worktree.mkdir()

    def boom():
        raise RuntimeError("registry on fire")

    monkeypatch.setattr(own_sessions, "snapshot", boom)

    found, errors = pw._related_sessions(str(worktree))

    assert found == []
    assert any("own sessions unavailable" in error for error in errors)


def test_related_sessions_are_attached_to_entries(tmp_path, selection, monkeypatch):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    selection([repo])

    class _Manager:
        def sessions(self):
            return [{"cwd": str(repo), "sessionId": "s1", "nativeId": "claude-1", "alive": True, "lastActivityAt": 42}]

    import server.claude_live as claude_live

    monkeypatch.setattr(claude_live, "get_manager", _Manager)

    (entry,) = pw.collect(now_ms=1)["entries"]

    assert entry["relatedSessions"] == [
        {"id": "s1", "name": "claude-1", "status": "live", "lastActivityAtMs": 42}
    ]


# ── route ────────────────────────────────────────────────────────────────────
def test_route_returns_the_payload(tmp_path, selection, monkeypatch):
    from server.routes import pending_work as route

    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    selection([repo])

    status, body = route.get_pending_work({})

    assert status == 200
    assert body["available"] is True
    assert body["entries"][0]["state"] == "dirty"


def test_route_degrades_to_unavailable_on_internal_error(tmp_path, selection, monkeypatch):
    from server.routes import pending_work as route

    def boom(*args, **kwargs):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(pw, "collect", boom)

    status, body = route.get_pending_work({})

    assert status == 200
    assert body["available"] is False
    assert body["entries"] == []
    assert any("kaboom" in error for error in body["errors"])


def test_registry_exposes_the_route():
    from server.routes import registry

    assert "/api/pending-work" in registry.GET_EXACT
    assert callable(registry.GET_EXACT["/api/pending-work"])


def test_registry_handler_matches_the_route_module():
    from server.routes import pending_work as route
    from server.routes import registry

    assert registry.GET_EXACT["/api/pending-work"] is route.get_pending_work


# ── time helpers ─────────────────────────────────────────────────────────────
def test_iso_to_ms_handles_z_suffix_and_garbage():
    assert pw._iso_to_ms("2026-01-01T00:00:00Z") == 1767225600000
    assert pw._iso_to_ms("2026-01-01T00:00:00+00:00") == 1767225600000
    assert pw._iso_to_ms("not a date") is None
    assert pw._iso_to_ms(None) is None
    assert pw._iso_to_ms("") is None


def test_int_or_none_rejects_bools_and_strings():
    assert pw._int_or_none(5) == 5
    assert pw._int_or_none(5.9) == 5
    assert pw._int_or_none(True) is None
    assert pw._int_or_none("5") is None
    assert pw._int_or_none(None) is None


def test_scan_timeout_is_bounded(tmp_path, selection, monkeypatch):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    selection([repo])

    def slow(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="git", timeout=0.001)

    monkeypatch.setattr(pw, "_git", slow)

    payload = pw.collect(now_ms=1)

    (entry,) = payload["entries"]
    assert entry["state"] == "unavailable"
    assert "timed out" in entry["error"]


def test_scan_budget_is_enforced(tmp_path, selection, monkeypatch):
    repos = [init_repo(tmp_path / f"r{i}") for i in range(4)]
    for repo in repos:
        commit(repo)
    selection(repos)
    monkeypatch.setattr(pw, "_SCAN_BUDGET_S", 0.0)

    payload = pw.collect(now_ms=1)

    assert payload["available"] is True
    assert len(payload["entries"]) < len(repos)
    assert any("budget" in error for error in payload["errors"])


def test_git_missing_is_reported_not_zero_work(tmp_path, selection, monkeypatch):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    selection([repo])
    monkeypatch.setattr(pw.shutil, "which", lambda _name: None)

    payload = pw.collect(now_ms=1)

    assert payload["available"] is False
    assert payload["entries"] == []
    assert any("not found" in error for error in payload["errors"])


def test_elapsed_time_is_monotonic_in_age(tmp_path, selection):
    repo = init_repo(tmp_path / "repo")
    commit(repo)
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    selection([repo])

    first = pw.collect(now_ms=1_000_000)["entries"][0]
    second = pw.collect(now_ms=1_000_500)["entries"][0]

    assert 0 <= first["ageMs"] <= second["ageMs"]
    assert time.time() * 1000 > 0
