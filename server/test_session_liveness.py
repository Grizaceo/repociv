"""Tests for session_liveness: the /proc scan and the Hermes lease registry."""

from __future__ import annotations

import json
import os
from pathlib import Path

from server import session_liveness as sl


def _proc(root: Path, pid: int, argv: list[str], cwd: Path | None = None) -> None:
    """One fake /proc/<pid>: NUL-separated cmdline, cwd as the real symlink it is."""
    entry = root / str(pid)
    entry.mkdir(parents=True)
    (entry / "cmdline").write_bytes(b"\0".join(a.encode() for a in argv) + b"\0")
    if cwd is not None:
        cwd.mkdir(parents=True, exist_ok=True)
        os.symlink(cwd, entry / "cwd")


def _lease(path: Path, entries: list[dict]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"entries": entries}), encoding="utf-8")
    return path


def _probe(tmp_path: Path) -> sl.Liveness:
    return sl.probe(str(tmp_path / "proc"), str(tmp_path / "active_sessions.json"))


# ─── /proc scan (Suvadu agents) ──────────────────────────────────────────────
def test_agent_cwd_is_live(tmp_path):
    work = tmp_path / "w" / "repociv"
    _proc(tmp_path / "proc", 4242, ["claude"], cwd=work)
    _proc(tmp_path / "proc", 4243, ["bash", "-l"], cwd=tmp_path / "w" / "other")
    reading = _probe(tmp_path)

    assert reading.ok
    assert reading.live_for(source="suvadu", native_id="n1", cwd=str(work)) is True
    # A shell in another directory proves nothing about a session there.
    assert reading.live_for(source="suvadu", native_id="n2", cwd=str(tmp_path / "w" / "other")) is False
    assert reading.live_for(source="suvadu", native_id="n3", cwd="") is False


def test_agent_binaries_behind_a_wrapper(tmp_path):
    for pid, argv, name in (
        (10, ["node", "/opt/bin/claude", "--resume"], "claude"),
        (11, ["/usr/local/bin/codex"], "codex"),
        (12, ["/home/u/.local/bin/cursor-agent", "chat"], "cursor"),
    ):
        _proc(tmp_path / "proc", pid, argv, cwd=tmp_path / name)
    reading = _probe(tmp_path)

    for name in ("claude", "codex", "cursor"):
        assert reading.live_for(source="suvadu", native_id="x", cwd=str(tmp_path / name)) is True


def test_unreadable_proc_answers_unknown(tmp_path):
    reading = _probe(tmp_path)  # no fake /proc at all

    assert reading.ok is False
    # Unknown, never "dead": the tracker must fall back to timestamps.
    assert reading.live_for(source="suvadu", native_id="n", cwd="/w") is None
    assert reading.live_for(source="hermes", native_id="n", cwd="/w") is None


def test_process_without_cwd_access_is_skipped(tmp_path):
    # Another user's process: /proc/<pid>/cwd is there but unreadable, so no
    # symlink in the fake tree — the scan must not blow up or invent a cwd.
    _proc(tmp_path / "proc", 77, ["claude"])
    reading = _probe(tmp_path)

    assert reading.ok and reading.agent_cwds == frozenset()


# ─── Hermes lease registry ───────────────────────────────────────────────────
def test_hermes_lease_with_live_pid(tmp_path):
    _proc(tmp_path / "proc", 900, ["/h/venv/bin/python", "/h/hermes", "chat", "--profile", "cobalt"])
    _lease(tmp_path / "active_sessions.json", [
        {"pid": 900, "session_id": "20260919_174051_b5cd89", "surface": "cli",
         "metadata": {"live_session_id": "20260919_174051_child"}},
    ])
    reading = _probe(tmp_path)

    # Both the lease id and the live id it points at: a compressed session
    # continues in a child, and the tracker may observe either.
    assert reading.live_for(source="hermes", native_id="20260919_174051_b5cd89", cwd="") is True
    assert reading.live_for(source="hermes", native_id="20260919_174051_child", cwd="") is True
    assert reading.live_for(source="hermes", native_id="20260101_000000_other", cwd="") is False


def test_stale_lease_whose_process_is_gone(tmp_path):
    _proc(tmp_path / "proc", 900, ["claude"], cwd=tmp_path / "w")
    _lease(tmp_path / "active_sessions.json", [
        {"pid": 901, "session_id": "dead_session"},  # never started, or crashed
    ])
    reading = _probe(tmp_path)

    assert reading.live_for(source="hermes", native_id="dead_session", cwd="") is False


def test_recycled_pid_does_not_resurrect_a_lease(tmp_path):
    # pid 900 is alive, but it is not a hermes process any more.
    _proc(tmp_path / "proc", 900, ["/usr/bin/gcc", "main.c"])
    _lease(tmp_path / "active_sessions.json", [{"pid": 900, "session_id": "old_session"}])
    reading = _probe(tmp_path)

    assert reading.live_for(source="hermes", native_id="old_session", cwd="") is False


def test_malformed_lease_leaves_the_proc_scan_standing(tmp_path):
    _proc(tmp_path / "proc", 900, ["claude"], cwd=tmp_path / "w")
    (tmp_path / "active_sessions.json").write_text("{not json", encoding="utf-8")
    reading = _probe(tmp_path)

    assert reading.ok and reading.hermes_sessions == frozenset()
    assert reading.live_for(source="suvadu", native_id="n", cwd=str(tmp_path / "w")) is True


def test_lease_rows_that_are_not_rows(tmp_path):
    _proc(tmp_path / "proc", 900, ["hermes", "chat"])
    _lease(tmp_path / "active_sessions.json", [
        "junk",  # type: ignore[list-item]
        {"pid": True, "session_id": "boolean_pid"},  # bool is not a pid
        {"pid": "900", "session_id": "string_pid"},
        {"pid": 900, "session_id": "", "metadata": "not a dict"},
        {"pid": 900, "session_id": "good"},
    ])
    reading = _probe(tmp_path)

    assert reading.hermes_sessions == frozenset({"good"})
