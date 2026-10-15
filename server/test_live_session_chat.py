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


def test_router_registers_all_harnesses_and_capabilities_fail_closed(tmp_path) -> None:
    router = LiveSessionChatRouter(
        {
            "codex": CodexLiveChatAdapter(codex_bin="/bin/codex"),
            "openai-codex": CodexLiveChatAdapter(codex_bin="/bin/codex"),
            "hermes": HermesLiveChatAdapter(
                hermes_home=str(tmp_path / "hermes"),
                lock_dir=str(tmp_path / "locks"),
                proc_root=str(tmp_path / "proc"),
                tmux_bin="",
            ),
            "claude-code": ClaudeLiveChatAdapter(),
        }
    )

    assert router.capability(_obs()).to_dict() == {
        "state": "available",
        "transport": "codex-queue",
        "reason": None,
    }
    assert router.capability(_obs(agent="openai-codex")).to_dict() == {
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


def _seed_hermes_proc(proc_root, pid: int, start_ticks: int = 744391, ppid: int = 1, tty: str = "") -> None:
    import os

    entry = proc_root / str(pid)
    entry.mkdir(parents=True, exist_ok=True)
    (entry / "cmdline").write_bytes(b"/usr/bin/python3\0/h/hermes_cli/main.py\0serve\0")
    # Field 1: pid, Field 2: (comm), Field 3: state, Field 4: ppid ... Field 22 (idx 19 after ')'): starttime
    after_comm = ["S", str(ppid)] + ["0"] * 17 + [str(start_ticks)]
    (entry / "stat").write_text(f"{pid} (hermes) {' '.join(after_comm)}\n", encoding="utf-8")
    if tty:
        fd_dir = entry / "fd"
        fd_dir.mkdir(exist_ok=True)
        try:
            os.symlink(tty, fd_dir / "0")
        except OSError:
            pass


def test_hermes_serve_ws_adopts_existing_desktop_and_compressed_sessions(tmp_path) -> None:
    import hashlib
    import json

    proc_root = tmp_path / "proc"
    hermes_home = tmp_path / "hermes"
    lock_dir = tmp_path / "locks"
    lock_dir.mkdir(parents=True)
    _seed_hermes_proc(proc_root, 1566377, start_ticks=744391)

    token = "secret-session-token-for-desktop-serve"
    fp = hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]
    (lock_dir / "host-desktop-serve.json").write_text(
        json.dumps(
            {
                "role": "desktop-serve",
                "pid": 1566377,
                "startTime": 744391,
                "host": "127.0.0.1",
                "port": 45339,
                "protocolVersion": 1,
                "tokenFingerprint": fp,
            }
        ),
        encoding="utf-8",
    )
    (lock_dir / "host-desktop-serve.token").write_text(token + "\n", encoding="utf-8")

    # Root lease uses pre-compression session_id; named profile 'eidos' has its own lease file
    rt_default = hermes_home / "runtime"
    rt_default.mkdir(parents=True)
    (rt_default / "active_sessions.json").write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "pid": 1566377,
                        "session_id": "20261015_root_id",
                        "surface": "desktop",
                        "metadata": {"live_session_id": "4a500c22", "bot_live_delivery_consumer": True},
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    rt_eidos = hermes_home / "profiles" / "eidos" / "runtime"
    rt_eidos.mkdir(parents=True)
    (rt_eidos / "active_sessions.json").write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "pid": 1566377,
                        "session_id": "20261015_eidos_id",
                        "surface": "desktop",
                        "metadata": {"live_session_id": "7ab323cc", "bot_live_delivery_consumer": True},
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    ws_calls: list[dict] = []

    def fake_ws_send(**kwargs):
        ws_calls.append(kwargs)

    adapter = HermesLiveChatAdapter(
        hermes_home=str(hermes_home),
        lock_dir=str(lock_dir),
        proc_root=str(proc_root),
        tmux_bin="",
        ws_send=fake_ws_send,
    )

    compressed_obs = _obs(
        session_id="hermes-default-20261015_root_id",
        agent="hermes",
        source="hermes",
        profile="default",
        native_id="20261015_tip_child",
        related_native_ids=("20261015_root_id", "20261015_tip_child"),
    )
    assert adapter.capability(compressed_obs).to_dict() == {
        "state": "available",
        "transport": "hermes-serve-ws",
        "reason": None,
    }
    res = adapter.send(compressed_obs, "continúa con el fix", "req-hermes-1")
    assert res.to_dict() == {
        "state": "accepted",
        "transport": "hermes-serve-ws",
        "requestId": "req-hermes-1",
    }
    assert ws_calls == [
        {
            "port": 45339,
            "token": token,
            "live_session_id": "4a500c22",
            "profile": "default",
            "text": "continúa con el fix",
            "request_id": "req-hermes-1",
            "timeout_s": adapter.timeout_s,
        }
    ]

    eidos_obs = _obs(
        session_id="hermes-eidos-20261015_eidos_id",
        agent="hermes",
        source="hermes",
        profile="eidos",
        native_id="20261015_eidos_id",
    )
    assert adapter.capability(eidos_obs).to_dict() == {
        "state": "available",
        "transport": "hermes-serve-ws",
        "reason": None,
    }


def test_hermes_tmux_adopts_existing_cli_session_with_separate_send_keys(tmp_path) -> None:
    import json

    proc_root = tmp_path / "proc"
    hermes_home = tmp_path / "hermes"
    _seed_hermes_proc(proc_root, 2200, ppid=2100)
    rt = hermes_home / "runtime"
    rt.mkdir(parents=True)
    (rt / "active_sessions.json").write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "pid": 2200,
                        "session_id": "20261015_cli_tmux",
                        "surface": "cli",
                        "metadata": {"live_session_id": "20261015_cli_tmux"},
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    tmux_calls: list[list[str]] = []

    def fake_run(argv, **kwargs):
        if "list-panes" in argv:
            return subprocess.CompletedProcess(argv, 0, "%3\t2100\t/dev/pts/9\n", "")
        tmux_calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    adapter = HermesLiveChatAdapter(
        hermes_home=str(hermes_home),
        lock_dir=str(tmp_path / "no-locks"),
        proc_root=str(proc_root),
        tmux_bin="/usr/bin/tmux",
        run=fake_run,
    )
    obs = _obs(
        session_id="hermes-default-20261015_cli_tmux",
        agent="hermes",
        source="hermes",
        profile="default",
        native_id="20261015_cli_tmux",
    )
    assert adapter.capability(obs).to_dict() == {
        "state": "available",
        "transport": "hermes-tmux",
        "reason": None,
    }
    res = adapter.send(obs, "hola desde F8", "req-tmux-1")
    assert res.to_dict() == {
        "state": "accepted",
        "transport": "hermes-tmux",
        "requestId": "req-tmux-1",
    }
    assert tmux_calls == [
        ["/usr/bin/tmux", "send-keys", "-t", "%3", "-l", "--", "hola desde F8"],
        ["/usr/bin/tmux", "send-keys", "-t", "%3", "Enter"],
    ]


def test_ws_prompt_submit_handshake_and_rpc_over_loopback() -> None:
    import json
    import socket
    import struct
    import threading
    from server.live_session_chat import _ws_prompt_submit

    received_rpc: list[dict] = []

    server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_sock.bind(("127.0.0.1", 0))
    server_sock.listen(1)
    port = server_sock.getsockname()[1]

    def _serve_once() -> None:
        conn, _ = server_sock.accept()
        with conn:
            req = b""
            while b"\r\n\r\n" not in req:
                req += conn.recv(4096)
            assert b"GET /api/ws?token=tok123 HTTP/1.1" in req
            conn.sendall(
                b"HTTP/1.1 101 Switching Protocols\r\n"
                b"Upgrade: websocket\r\n"
                b"Connection: Upgrade\r\n\r\n"
            )
            # Send gateway.ready frame (unmasked server -> client)
            ready = json.dumps(
                {"jsonrpc": "2.0", "method": "event", "params": {"type": "gateway.ready"}}
            ).encode("utf-8")
            conn.sendall(bytes([0x81, len(ready)]) + ready)

            # Read client masked frame
            hdr = conn.recv(2)
            ln = hdr[1] & 0x7F
            if ln == 126:
                (ln,) = struct.unpack("!H", conn.recv(2))
            mask = conn.recv(4)
            enc = conn.recv(ln)
            dec = bytes(b ^ mask[i & 3] for i, b in enumerate(enc))
            rpc = json.loads(dec.decode("utf-8"))
            received_rpc.append(rpc)

            reply = json.dumps(
                {"jsonrpc": "2.0", "id": rpc["id"], "result": {"status": "queued"}}
            ).encode("utf-8")
            conn.sendall(bytes([0x81, len(reply)]) + reply)

    t = threading.Thread(target=_serve_once, daemon=True)
    t.start()
    try:
        _ws_prompt_submit(
            port=port,
            token="tok123",
            live_session_id="e1cf31e0",
            profile="eidos",
            text="mensaje de prueba",
            request_id="req-ws-1",
            timeout_s=5.0,
        )
    finally:
        server_sock.close()
        t.join(timeout=2.0)

    assert received_rpc == [
        {
            "jsonrpc": "2.0",
            "id": "req-ws-1",
            "method": "prompt.submit",
            "params": {
                "session_id": "e1cf31e0",
                "text": "mensaje de prueba",
                "queued": True,
                "profile": "eidos",
            },
        }
    ]

