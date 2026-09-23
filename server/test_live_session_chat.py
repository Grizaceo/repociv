"""Live-session chat contract and harness adapters."""
from __future__ import annotations

import subprocess

from server.live_session_chat import (
    MAX_MESSAGE_BYTES,
    ChatError,
    ClaudeLiveChatAdapter,
    CodexLiveChatAdapter,
    HermesLiveChatAdapter,
    LiveSessionChatRouter,
)
from server.suvadu_tracker import ExternalAgentTracker, Observation, TrackerConfig


def _obs(**overrides) -> Observation:
    values = {
        "session_id": "codex-repociv-id",
        "agent": "codex",
        "native_id": "native-thread-id",
        "cwd": "/repo",
        "model": "gpt-test",
        "first_activity_ms": 1,
        "last_activity_ms": 2,
        "command_count": 0,
        "event_count": 0,
        "total_tokens": None,
        "source": "suvadu",
        "live": True,
    }
    values.update(overrides)
    return Observation(**values)


def test_codex_adapter_uses_exact_argv_without_shell() -> None:
    calls = []

    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0, "Queued message", "")

    adapter = CodexLiveChatAdapter(codex_bin="/bin/codex", run=run)
    result = adapter.send(_obs(), "--keep-this-intact", "request-1")

    assert calls == [
        (
            [
                "/bin/codex",
                "queue",
                "--thread=native-thread-id",
                "--message=--keep-this-intact",
            ],
            {"capture_output": True, "text": True, "timeout": adapter.timeout_s},
        )
    ]
    assert result.to_dict() == {
        "state": "accepted",
        "transport": "codex-queue",
        "requestId": "request-1",
    }


def test_router_registers_all_harnesses_and_capabilities_fail_closed() -> None:
    router = LiveSessionChatRouter(
        {
            "codex": CodexLiveChatAdapter(codex_bin="/bin/codex"),
            "hermes": HermesLiveChatAdapter(),
            "claude-code": ClaudeLiveChatAdapter(),
        }
    )

    assert router.capability(_obs()).to_dict() == {
        "state": "available",
        "transport": "codex-queue",
        "reason": None,
    }
    assert router.capability(_obs(agent="hermes", source="hermes")).to_dict() == {
        "state": "unavailable",
        "transport": None,
        "reason": "hermes_not_live_bot_chat",
    }
    assert router.capability(_obs(agent="claude-code")).to_dict() == {
        "state": "unavailable",
        "transport": None,
        "reason": "claude_control_channel_unavailable",
    }


def test_router_rejects_quiet_empty_and_oversized_before_transport() -> None:
    sent = []

    class Adapter:
        def capability(self, session):
            return CodexLiveChatAdapter(codex_bin="/bin/codex").capability(session)

        def send(self, session, text, request_id):
            sent.append(text)
            raise AssertionError("must not send")

    router = LiveSessionChatRouter({"codex": Adapter()})
    cases = [
        (_obs(live=False), "hello", 409, "session_not_live"),
        (_obs(), " \n ", 422, "empty_message"),
        (_obs(), "x" * (MAX_MESSAGE_BYTES + 1), 413, "message_too_large"),
    ]
    for session, text, status, code in cases:
        try:
            router.send(session, text, "request-x")
        except ChatError as exc:
            assert (exc.status, exc.code) == (status, code)
        else:
            raise AssertionError("expected ChatError")
    assert sent == []


def test_codex_timeout_is_not_retried() -> None:
    calls = 0

    def run(argv, **kwargs):
        nonlocal calls
        calls += 1
        raise subprocess.TimeoutExpired(argv, kwargs["timeout"])

    adapter = CodexLiveChatAdapter(codex_bin="/bin/codex", run=run)
    router = LiveSessionChatRouter({"codex": adapter})
    try:
        router.send(_obs(), "hello", "request-timeout")
    except ChatError as exc:
        assert (exc.status, exc.code) == (504, "transport_timeout")
    else:
        raise AssertionError("expected ChatError")
    assert calls == 1


def test_codex_capability_and_failures_are_fail_closed() -> None:
    unavailable = CodexLiveChatAdapter(codex_bin="")
    assert unavailable.capability(_obs()).to_dict() == {
        "state": "unavailable",
        "transport": None,
        "reason": "codex_queue_unavailable",
    }

    def failed(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 7, "sentinel-output", "sentinel-error")

    router = LiveSessionChatRouter({
        "codex": CodexLiveChatAdapter(codex_bin="/bin/codex", run=failed),
    })
    try:
        router.send(_obs(), "hello", "request-failed")
    except ChatError as exc:
        assert (exc.status, exc.code, str(exc)) == (502, "transport_failed", "transport_failed")
        assert "sentinel" not in str(exc)
    else:
        raise AssertionError("expected ChatError")

    unknown = LiveSessionChatRouter({})
    assert unknown.capability(_obs(agent="future-harness")).to_dict() == {
        "state": "unavailable",
        "transport": None,
        "reason": "unsupported_session_source",
    }


def test_tracker_publishes_per_session_capability_and_returns_observation_copy() -> None:
    router = LiveSessionChatRouter({"codex": CodexLiveChatAdapter(codex_bin="/bin/codex")})
    tracker = ExternalAgentTracker(
        TrackerConfig(bin_path="suv"),
        send=lambda event: None,
        repo_paths=lambda: [],
        sources=[],
        live_chat_router=router,
    )
    observation = _obs()
    tracker.reconcile([observation], now_ms=2, repo_paths=[])

    row = tracker.sessions()[0]
    assert row["liveChat"] == {
        "state": "available",
        "transport": "codex-queue",
        "reason": None,
    }
    resolved = tracker.observation("codex-repociv-id")
    assert resolved == observation
    assert resolved is not observation


def test_claude_live_adapter_available_only_for_process_owned_sessions() -> None:
    calls = []

    class Manager:
        def send(self, native_id, text):
            calls.append((native_id, text))

    adapter = ClaudeLiveChatAdapter(manager=Manager())
    owned = _obs(
        agent="claude-code",
        source="claude-live",
        native_id="11111111-1111-4111-8111-111111111111",
    )

    assert adapter.capability(owned).to_dict() == {
        "state": "available",
        "transport": "claude-stream-json",
        "reason": None,
    }
    assert adapter.send(owned, "hello", "request-live").to_dict() == {
        "state": "accepted",
        "transport": "claude-stream-json",
        "requestId": "request-live",
    }
    assert calls == [("11111111-1111-4111-8111-111111111111", "hello")]

    # A terminal session Suvadu saw: observable, not addressable — fail closed.
    assert adapter.capability(_obs(agent="claude-code")).to_dict() == {
        "state": "unavailable",
        "transport": None,
        "reason": "claude_control_channel_unavailable",
    }
    assert adapter.capability(_obs(agent="claude-code", source="claude-live", live=False)).to_dict() == {
        "state": "unavailable",
        "transport": None,
        "reason": "claude_live_not_running",
    }


def test_claude_live_adapter_maps_manager_errors() -> None:
    from server.claude_live import ClaudeLiveError

    class Manager:
        def send(self, native_id, text):
            raise ClaudeLiveError(404, "session_not_found")

    adapter = ClaudeLiveChatAdapter(manager=Manager())
    try:
        adapter.send(_obs(agent="claude-code", source="claude-live"), "hello", "request-x")
    except ChatError as exc:
        assert (exc.status, exc.code) == (404, "session_not_found")
    else:
        raise AssertionError("expected ChatError")


def test_router_routes_claude_live_to_the_process_channel() -> None:
    sent = []

    class Manager:
        def send(self, native_id, text):
            sent.append((native_id, text))

    router = LiveSessionChatRouter({"claude-code": ClaudeLiveChatAdapter(manager=Manager())})
    obs = _obs(
        agent="claude-code",
        source="claude-live",
        native_id="22222222-2222-4222-8222-222222222222",
    )
    result = router.send(obs, "hola", "request-live")
    assert result.to_dict() == {
        "state": "accepted",
        "transport": "claude-stream-json",
        "requestId": "request-live",
    }
    assert sent == [("22222222-2222-4222-8222-222222222222", "hola")]
