"""Tests for server/websocket_handler.py — WebSocket transport.

Strategy:
  - Start WS server on a random port in a daemon thread per test
  - Connect with websockets.sync.client for synchronous tests
  - Test: connect, broadcast, receive, heartbeat, rate limit
"""

import json
import os
import socket
import time

import pytest
import websockets.sync.client

from server import websocket_handler as wsh


def _connect(port: int, **kwargs):
    return websockets.sync.client.connect(
        f"ws://127.0.0.1:{port}", origin="http://127.0.0.1:5273", **kwargs
    )


def _find_free_port():
    """Get a free port from the OS (avoids random collisions)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def ws_server():
    """Start WS server on a free port, yield the port, teardown."""
    # Ensure clean auth state (other tests may have set REPOCIV_TOKEN)
    old_token = os.environ.get("REPOCIV_TOKEN", "")
    os.environ.pop("REPOCIV_TOKEN", None)
    wsh.REPOCIV_TOKEN = ""

    port = _find_free_port()
    wsh._connections.clear()
    wsh._start_time = time.time()
    wsh._loop = None
    wsh._ws_server = None

    wsh.start_ws_server(host="127.0.0.1", port=port)
    # Wait for server to be ready (retry-based, not blind sleep)
    deadline = time.time() + 5.0
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except (OSError, ConnectionRefusedError):
            time.sleep(0.05)
    else:
        pytest.fail(f"WS server did not start on port {port} within 5s")

    yield port
    # Stop the WS server cleanly before next test
    wsh.stop_ws_server()
    # Restore auth state
    if old_token:
        os.environ["REPOCIV_TOKEN"] = old_token
        wsh.REPOCIV_TOKEN = old_token
    else:
        os.environ.pop("REPOCIV_TOKEN", None)
        wsh.REPOCIV_TOKEN = ""


def test_ws_connect_dev_mode(ws_server):
    """In dev mode (no REPOCIV_TOKEN), connect without auth.

    Dev mode auto-authenticates and sends auth_ok immediately.
    """
    port = ws_server
    with _connect(port) as ws:
        msg = ws.recv(timeout=5)
        data = json.loads(msg)
        assert data["type"] == "auth_ok"


def test_ws_rejects_missing_origin_when_dev_token_is_empty(ws_server):
    port = ws_server
    with websockets.sync.client.connect(f"ws://127.0.0.1:{port}") as ws:
        data = json.loads(ws.recv(timeout=5))
        assert data["type"] == "auth_error"


def test_ws_rejects_foreign_origin_before_auth_in_token_mode(ws_server, monkeypatch):
    monkeypatch.setattr(wsh, "REPOCIV_TOKEN", "test-token-32-characters-minimum")
    port = ws_server
    with websockets.sync.client.connect(
        f"ws://127.0.0.1:{port}", origin="https://evil.example"
    ) as ws:
        data = json.loads(ws.recv(timeout=5))
        assert data == {"type": "auth_error", "msg": "origin not allowed"}


def test_ws_send_and_receive_ping_pong(ws_server):
    """Client sends ping, server responds with pong."""
    port = ws_server
    with _connect(port) as ws:
        ws.recv(timeout=5)  # auth_ok
        ws.send(json.dumps({"type": "ping"}))
        msg = ws.recv(timeout=5)
        data = json.loads(msg)
        assert data["type"] == "pong"


def test_ws_broadcast_reaches_client(ws_server):
    """Events broadcast via wsh.broadcast() reach connected clients."""
    port = ws_server
    with _connect(port) as ws:
        ws.recv(timeout=5)  # auth_ok
        # Broadcast from sync code
        wsh.broadcast({"type": "log", "msg": "test broadcast", "level": "info"})
        msg = ws.recv(timeout=5)
        data = json.loads(msg)
        assert data["type"] == "log"
        assert data["msg"] == "test broadcast"


def test_ws_multiple_clients_receive_broadcast(ws_server):
    """Multiple WS clients all receive the same broadcast."""
    port = ws_server
    clients = []
    for _ in range(3):
        ws = _connect(port)
        ws.recv(timeout=5)  # auth_ok
        clients.append(ws)

    wsh.broadcast({"type": "log", "msg": "multi-client test", "level": "info"})

    for ws in clients:
        try:
            msg = ws.recv(timeout=5)
            data = json.loads(msg)
            assert data["type"] == "log"
            assert data["msg"] == "multi-client test"
        finally:
            ws.close()


def test_ws_command_envelope_is_unwrapped_before_dispatch(ws_server):
    captured = []
    previous = wsh._command_callback
    wsh.set_command_callback(captured.append)
    try:
        with _connect(ws_server) as ws:
            ws.recv(timeout=5)  # auth_ok
            command = {"type": "enter_local", "target": "city-1", "repoId": "repo-1"}
            ws.send(json.dumps({"type": "command", "data": command}))
            ack = json.loads(ws.recv(timeout=5))

        assert captured == [command]
        assert ack == {"type": "ack", "id": ""}
    finally:
        wsh._command_callback = previous


def test_ws_command_normalize_produces_dispatchable_command():
    """Regression: the WS command path must dispatch, not silently drop.

    websocket_handler unwraps ``{type:"command", data:{...}}`` to the inner dict
    and hands that to the callback, so bridge._normalize_ws_command must shape
    the *inner* command into a valid Command. A prior double-unwrap re-checked
    the already-consumed outer ``"command"`` type, so every WS command was
    ack'd but never validated/dispatched (silent no-op). This exercises the
    layer-2 contract the older stub-callback test never reached.
    """
    from server.bridge import _normalize_ws_command
    from server.command_schema import validate_command

    # Shape 1 — browser envelope {type:"command", data:{...flat...}}.
    envelope = {
        "type": "command",
        "data": {
            "type": "unit_command",
            "unit": "MAIN",
            "city": "main",
            "mission": "do the thing",
            "harness": "claude",
        },
    }
    inner = envelope.get("data", envelope)  # what websocket_handler passes to cb
    normalized = _normalize_ws_command(inner)
    assert normalized["type"] == "unit_command"
    assert normalized["target"] == "main"
    assert normalized["payload"]["unit"] == "MAIN"
    assert normalized["payload"]["mission"] == "do the thing"
    assert normalized["payload"]["harness"] == "claude"
    cmd = validate_command(normalized)  # must not raise
    assert cmd.type == "unit_command"

    # Shape 2 — flat command (WebSocketClient.sendCommand sends this directly,
    # no envelope; websocket_handler's data.get("data", data) returns it as-is).
    flat = {
        "type": "execute_agent",
        "unit": "SCOUT",
        "city": "repo-x",
        "mission": "scan",
        "repoPath": "/tmp/repo-x",
    }
    inner2 = flat.get("data", flat)
    normalized2 = _normalize_ws_command(inner2)
    assert normalized2["type"] == "execute_agent"
    assert normalized2["payload"]["repoPath"] == "/tmp/repo-x"
    cmd2 = validate_command(normalized2)  # must not raise
    assert cmd2.type == "execute_agent"


def test_ws_command_normalize_passes_through_unknown_types():
    """Non unit_command/execute_agent types are returned unchanged for their
    own validator path (no accidental flat→nested remap)."""
    from server.bridge import _normalize_ws_command

    payload = {"type": "quest_add", "target": "main", "title": "x"}
    assert _normalize_ws_command(payload) == payload


def test_ws_unknown_message_type(ws_server):
    """Server responds with error for unknown message types."""
    port = ws_server
    with _connect(port) as ws:
        ws.recv(timeout=5)  # auth_ok
        ws.send(json.dumps({"type": "unknown_type", "foo": "bar"}))
        msg = ws.recv(timeout=5)
        data = json.loads(msg)
        assert data["type"] == "error"
        assert "unknown" in data.get("msg", "")


def test_ws_invalid_json(ws_server):
    """Server responds with error for invalid JSON."""
    port = ws_server
    with _connect(port) as ws:
        ws.recv(timeout=5)  # auth_ok
        ws.send(b"not json at all")
        msg = ws.recv(timeout=5)
        data = json.loads(msg)
        assert data["type"] == "error"
        assert "invalid JSON" in data.get("msg", "")


def test_ws_auth_with_token():
    """When REPOCIV_TOKEN is set, require auth on connect."""
    old_token = os.environ.get("REPOCIV_TOKEN", "")
    old_port = wsh.BRIDGE_WS_PORT
    try:
        os.environ["REPOCIV_TOKEN"] = "test-token-123"
        wsh.REPOCIV_TOKEN = "test-token-123"

        port = _find_free_port()
        wsh._connections.clear()
        wsh._start_time = time.time()
        wsh._loop = None
        wsh.start_ws_server(host="127.0.0.1", port=port)
        # Wait for server ready
        deadline = time.time() + 5.0
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except (OSError, ConnectionRefusedError):
                time.sleep(0.05)
        else:
            pytest.fail(f"WS server did not start on port {port} within 5s")

        # Connect without auth — should receive auth_error
        ws = websockets.sync.client.connect(f"ws://127.0.0.1:{port}", close_timeout=10)
        try:
            msg = ws.recv(timeout=10)
            data = json.loads(msg)
            assert data["type"] == "auth_error"
        finally:
            ws.close()

        # Connect with correct token — should succeed
        ws = _connect(port)
        ws.send(json.dumps({"type": "auth", "token": "test-token-123"}))
        msg = ws.recv(timeout=5)
        data = json.loads(msg)
        assert data["type"] == "auth_ok"
        ws.close()

    finally:
        os.environ["REPOCIV_TOKEN"] = old_token
        wsh.REPOCIV_TOKEN = old_token or ""
        wsh.BRIDGE_WS_PORT = old_port


@pytest.mark.skip(reason="Rate limit test is timing-sensitive; run manually")
def test_ws_rate_limit(ws_server):
    """Sending >60 messages in 60s triggers rate limit."""
    port = ws_server
    with _connect(port) as ws:
        ws.recv(timeout=5)  # auth_ok
        for i in range(61):
            ws.send(json.dumps({"type": "ping"}))
            ws.recv(timeout=1)
        # Next message should be rate-limited
        ws.send(json.dumps({"type": "ping"}))
        msg = ws.recv(timeout=5)
        data = json.loads(msg)
        assert data["type"] == "error"
        assert "rate limited" in data.get("msg", "")
