"""Process-owned Claude Code channel — manager, source, adapter, endpoints.

Fase 5 of the live-session chat: the only supported bidirectional surface is
the stream-json pipe of a Claude process RepoCiv spawns itself (evidence:
docs/evidence/2026-09-21-claude-code-channel-research.md).
"""
from __future__ import annotations

import io
import json
import subprocess
import threading
import time
import uuid

import pytest

from server import claude_live, claude_sessions, session_liveness
from server.claude_live import ClaudeLiveError, ClaudeLiveManager, ClaudeLiveSource
from server.suvadu_tracker import ExternalAgentTracker, Observation, TrackerConfig

FAKE_CLAUDE = """
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    print(json.dumps({"type": "result", "subtype": "success", "result": json.dumps(msg, sort_keys=True)}), flush=True)
"""


@pytest.fixture(autouse=True)
def _isolate_repociv_config(tmp_path, monkeypatch):
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path / "cfg"))


def _fake_claude(tmp_path) -> str:
    """A stand-in CLI that answers every stream-json line with its echo."""
    path = tmp_path / "fake-claude"
    path.write_text("#!/usr/bin/env python3\n" + FAKE_CLAUDE, encoding="utf-8")
    path.chmod(0o755)
    return str(path)


def _wait_for(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


class FakeStdin:
    def __init__(self) -> None:
        self.writes: list[str] = []
        self.closed = False

    def write(self, text: str) -> None:
        self.writes.append(text)

    def flush(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True


class FakeProc:
    def __init__(self) -> None:
        self.stdin = FakeStdin()
        self.stdout = io.StringIO("")
        self.stderr = io.StringIO("")
        self.returncode = None
        self.killed = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0
        return 0

    def kill(self):
        self.killed = True
        self.returncode = -9


def _observation(session_id: str, *, source: str, live: bool | None) -> Observation:
    return Observation(
        session_id=session_id,
        agent="claude-code",
        native_id=session_id.split("-", 1)[-1],
        cwd="/repo",
        model="",
        first_activity_ms=1,
        last_activity_ms=2,
        command_count=0,
        event_count=0,
        total_tokens=None,
        source=source,
        live=live,
    )


def test_spawn_uses_verified_argv_cwd_and_redacted_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret-sentinel")
    calls = []

    def spawn(argv, **kwargs):
        calls.append((argv, kwargs))
        return FakeProc()

    manager = ClaudeLiveManager(claude_bin="/bin/claude", spawn=spawn)
    result = manager.spawn(str(tmp_path))

    assert len(calls) == 1
    argv, kwargs = calls[0]
    native_id = result["nativeId"]
    uuid.UUID(native_id)  # a real session uuid, not a placeholder
    assert argv == [
        "/bin/claude",
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--session-id",
        native_id,
    ]
    assert result["sessionId"] == f"claude-live-{native_id}"
    assert result["cwd"] == str(tmp_path)
    assert kwargs["cwd"] == str(tmp_path)
    assert kwargs["stdin"] is subprocess.PIPE
    assert kwargs["env"]["ANTHROPIC_API_KEY"] == "<REDACTED_BY_REPOCIV>"
    assert "sk-secret-sentinel" not in json.dumps(kwargs["env"])
    assert kwargs["env"]["HOME"]


def test_spawn_failure_is_reported(tmp_path):
    def spawn(argv, **kwargs):
        raise FileNotFoundError(argv[0])

    manager = ClaudeLiveManager(claude_bin="/nope/claude", spawn=spawn)
    with pytest.raises(ClaudeLiveError) as excinfo:
        manager.spawn(str(tmp_path))
    assert (excinfo.value.status, excinfo.value.code) == (500, "spawn_failed")


def test_spawn_without_claude_is_unavailable(tmp_path):
    manager = ClaudeLiveManager(claude_bin="")
    with pytest.raises(ClaudeLiveError) as excinfo:
        manager.spawn(str(tmp_path))
    assert (excinfo.value.status, excinfo.value.code) == (503, "claude_unavailable")


def test_spawn_rejects_missing_cwd(tmp_path):
    manager = ClaudeLiveManager(claude_bin="/bin/claude", spawn=lambda *a, **k: FakeProc())
    with pytest.raises(ClaudeLiveError) as excinfo:
        manager.spawn(str(tmp_path / "missing"))
    assert (excinfo.value.status, excinfo.value.code) == (400, "invalid_cwd")


def test_send_unknown_session_is_not_found():
    manager = ClaudeLiveManager(claude_bin="/bin/claude", spawn=lambda *a, **k: FakeProc())
    with pytest.raises(ClaudeLiveError) as excinfo:
        manager.send("no-such-session", "hola")
    assert (excinfo.value.status, excinfo.value.code) == (404, "session_not_found")


def test_send_writes_exact_stream_json_line_and_records_turns(tmp_path):
    manager = ClaudeLiveManager(claude_bin=_fake_claude(tmp_path))
    native_id = manager.spawn(str(tmp_path))["nativeId"]
    try:
        manager.send(native_id, "hola")
        assert _wait_for(lambda: len(manager.messages(native_id)) >= 2)
        user, assistant = manager.messages(native_id)[:2]
        assert user["role"] == "user"
        assert user["text"] == "hola"
        assert isinstance(user["at"], int)
        assert assistant["role"] == "assistant"
        assert json.loads(assistant["text"]) == {
            "type": "user",
            "message": {"role": "user", "content": "hola"},
        }
        assert manager.sessions()[0]["alive"] is True
    finally:
        manager.stop(native_id)
    assert manager.sessions()[0]["alive"] is False


def test_concurrent_sends_stay_serialized(tmp_path):
    manager = ClaudeLiveManager(claude_bin=_fake_claude(tmp_path))
    native_id = manager.spawn(str(tmp_path))["nativeId"]
    try:
        threads = [
            threading.Thread(target=manager.send, args=(native_id, f"m{i}")) for i in range(4)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert _wait_for(lambda: len(manager.messages(native_id)) >= 8)
        messages = manager.messages(native_id)
        users = [m for m in messages if m["role"] == "user"]
        assert sorted(m["text"] for m in users) == ["m0", "m1", "m2", "m3"]
        replies = [json.loads(m["text"]) for m in messages if m["role"] == "assistant"]
        assert sorted(r["message"]["content"] for r in replies) == ["m0", "m1", "m2", "m3"]
    finally:
        manager.stop(native_id)


def test_source_declares_live_for_owned_process_sessions(tmp_path):
    manager = ClaudeLiveManager(claude_bin=_fake_claude(tmp_path))
    source = ClaudeLiveSource(manager)
    native_id = manager.spawn(str(tmp_path))["nativeId"]

    (obs,) = source.poll()
    assert obs.session_id == f"claude-live-{native_id}"
    assert obs.agent == "claude-code"
    assert obs.native_id == native_id
    assert obs.source == "claude-live"
    assert obs.cwd == str(tmp_path)
    assert obs.live is True
    assert obs.ended is False

    manager.stop(native_id)
    (dead,) = source.poll()
    assert dead.live is False
    assert dead.ended is True


def test_source_declared_live_survives_the_process_probe():
    tracker = ExternalAgentTracker(
        TrackerConfig(bin_path="suv"),
        send=lambda event: None,
        repo_paths=lambda: [],
        sources=[],
        liveness=lambda: session_liveness.Liveness(
            ok=True, agent_cwds=frozenset(), hermes_sessions=frozenset()
        ),
    )
    declared = _observation("claude-live-1", source="claude-live", live=True)
    unknown = _observation("suvadu-1", source="suvadu", live=None)

    tagged = tracker._with_liveness([declared, unknown])

    assert tagged[0].live is True  # the source holds the process; the probe cannot see it
    assert tagged[1].live is False  # probe ran and found no agent process in that cwd


def test_spawn_marks_the_session_owned(tmp_path):
    manager = ClaudeLiveManager(claude_bin=_fake_claude(tmp_path))
    native_id = manager.spawn(str(tmp_path))["nativeId"]
    try:
        assert native_id in claude_sessions.owned_ids()
    finally:
        manager.stop(native_id)


def test_endpoints_spawn_and_stop(tmp_path, monkeypatch):
    from server.routes.core import post_claude_live_spawn, post_claude_live_stop

    manager = ClaudeLiveManager(claude_bin=_fake_claude(tmp_path))
    monkeypatch.setattr(claude_live, "get_manager", lambda: manager)

    status, body = post_claude_live_spawn({"cwd": str(tmp_path)}, {})
    assert status == 200
    native_id = body["nativeId"]

    status, body = post_claude_live_stop({"sessionId": f"claude-live-{native_id}"}, {})
    assert status == 200
    assert body == {"ok": True, "sessionId": f"claude-live-{native_id}"}

    status, body = post_claude_live_stop({"nativeId": "missing"}, {})
    assert status == 404
    assert body == {"error": "session_not_found"}

    status, body = post_claude_live_spawn({"cwd": "/no/such/repo"}, {})
    assert status == 400
    assert body == {"error": "invalid_cwd"}


def test_route_tables_expose_the_live_channel():
    from server import http_routes
    from server.routes import registry

    assert registry.POST_EXACT["/api/claude-live/spawn"] is http_routes.post_claude_live_spawn
    assert registry.POST_EXACT["/api/claude-live/stop"] is http_routes.post_claude_live_stop
