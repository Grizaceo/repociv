"""Tests for server/websocket_handler.py — WebSocket transport.

Strategy:
  - Start WS server on a random port in a daemon thread per test
  - Connect with websockets.sync.client for synchronous tests
  - Test: connect, broadcast, receive, heartbeat, rate limit
"""

import json
import os
import random
import time

import pytest
import websockets.sync.client

from server import websocket_handler as wsh


@pytest.fixture
def ws_server():
    """Start WS server on a random port, yield the port, teardown."""
    port = random.randint(22000, 28000)
    wsh._connections.clear()
    wsh._start_time = time.time()
    wsh._loop = None

    thread = wsh.start_ws_server(host="127.0.0.1", port=port)
    time.sleep(0.8)  # Wait for server to be ready
    yield port
    # Daemon thread dies with test process


def test_ws_connect_dev_mode(ws_server):
    """In dev mode (no REPOCIV_TOKEN), connect without auth.

    Dev mode auto-authenticates and sends auth_ok immediately.
    """
    port = ws_server
    with websockets.sync.client.connect(f"ws://127.0.0.1:{port}") as ws:
        msg = ws.recv(timeout=5)
        data = json.loads(msg)
        assert data["type"] == "auth_ok"


def test_ws_send_and_receive_ping_pong(ws_server):
    """Client sends ping, server responds with pong."""
    port = ws_server
    with websockets.sync.client.connect(f"ws://127.0.0.1:{port}") as ws:
        ws.recv(timeout=5)  # auth_ok
        ws.send(json.dumps({"type": "ping"}))
        msg = ws.recv(timeout=5)
        data = json.loads(msg)
        assert data["type"] == "pong"


def test_ws_broadcast_reaches_client(ws_server):
    """Events broadcast via wsh.broadcast() reach connected clients."""
    port = ws_server
    with websockets.sync.client.connect(f"ws://127.0.0.1:{port}") as ws:
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
        ws = websockets.sync.client.connect(f"ws://127.0.0.1:{port}")
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


def test_ws_unknown_message_type(ws_server):
    """Server responds with error for unknown message types."""
    port = ws_server
    with websockets.sync.client.connect(f"ws://127.0.0.1:{port}") as ws:
        ws.recv(timeout=5)  # auth_ok
        ws.send(json.dumps({"type": "unknown_type", "foo": "bar"}))
        msg = ws.recv(timeout=5)
        data = json.loads(msg)
        assert data["type"] == "error"
        assert "unknown" in data.get("msg", "")


def test_ws_invalid_json(ws_server):
    """Server responds with error for invalid JSON."""
    port = ws_server
    with websockets.sync.client.connect(f"ws://127.0.0.1:{port}") as ws:
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

        port = random.randint(22000, 28000)
        wsh._connections.clear()
        wsh._start_time = time.time()
        wsh._loop = None
        thread = wsh.start_ws_server(host="127.0.0.1", port=port)
        time.sleep(0.8)

        # Connect without auth — should receive auth_error
        ws = websockets.sync.client.connect(f"ws://127.0.0.1:{port}", close_timeout=10)
        try:
            msg = ws.recv(timeout=10)
            data = json.loads(msg)
            assert data["type"] == "auth_error"
        finally:
            ws.close()

        # Connect with correct token — should succeed
        ws = websockets.sync.client.connect(f"ws://127.0.0.1:{port}")
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
    with websockets.sync.client.connect(f"ws://127.0.0.1:{port}") as ws:
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
