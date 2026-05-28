import json
import os
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from server import bridge


def _start_test_server():
    server = ThreadingHTTPServer(("localhost", 0), bridge.BridgeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, f"http://{host}:{port}"


def _auth_headers(extra=None):
    """Mirror a real client: send the token header when the bridge has one.

    bridge.py loads .env on import, so REPOCIV_TOKEN may be set even in local
    dev. Tests that hit auth-gated routes must send the header like the UI does.
    """
    headers = dict(extra or {})
    if bridge.REPOCIV_TOKEN:
        headers["X-RepoCiv-Token"] = bridge.REPOCIV_TOKEN
    return headers


def test_health_endpoint_returns_liveness_shape():
    server, base = _start_test_server()
    try:
        with urllib.request.urlopen(f"{base}/health", timeout=2) as resp:
            data = json.loads(resp.read().decode())
        assert data["ok"] is True
        assert "openclaw" in data
        assert data.get("defaultTransport") == "hermes"
        # Extended health payload (2026-05-13)
        assert "version" in data
        assert "timestamp" in data
        assert "agents" in data
        assert isinstance(data["agents"].get("active"), int)
        assert isinstance(data["agents"].get("total"), int)
        assert isinstance(data["agents"].get("queueDepth"), int)
        assert "gpu" in data
        assert "eventStore" in data
    finally:
        server.shutdown()
        server.server_close()


def test_events_endpoint_serves_history_as_json():
    server, base = _start_test_server()
    try:
        req = urllib.request.Request(f"{base}/events", headers=_auth_headers())
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode())
        assert isinstance(data, list)
    finally:
        server.shutdown()
        server.server_close()


def test_events_endpoint_streams_sse_fanout():
    server, base = _start_test_server()
    try:
        req = urllib.request.Request(
            f"{base}/events", headers=_auth_headers({"Accept": "text/event-stream"})
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            first = resp.readline().decode().strip()
            assert first == 'data: {"type":"ping"}'
            # consume blank line after first SSE frame
            resp.readline()

            bridge.send_to_repociv({"type": "log", "msg": "sse-ok"})
            deadline = time.time() + 2
            seen = ""
            while time.time() < deadline:
                line = resp.readline().decode().strip()
                if line:
                    seen = line
                    break
            assert seen.startswith("data: ")
            payload = json.loads(seen.removeprefix("data: "))
            assert payload == {"type": "log", "msg": "sse-ok"}
    finally:
        server.shutdown()
        server.server_close()


# ─── Remote mode tests ────────────────────────────────────────────────────────

def test_remote_mode_defaults_to_localhost():
    """Without REPOCIV_REMOTE, bridge uses 127.0.0.1 as default host."""
    # The bridge module was loaded without REPOCIV_REMOTE in the test session
    assert bridge.BRIDGE_HOST == "127.0.0.1", f"Expected 127.0.0.1, got {bridge.BRIDGE_HOST}"
    assert bridge.REPOCIV_REMOTE is False


def test_remote_mode_with_token_host_is_0_0_0_0(monkeypatch):
    """With REPOCIV_REMOTE=true + REPOCIV_TOKEN, BRIDGE_HOST is 0.0.0.0."""
    monkeypatch.setenv("REPOCIV_REMOTE", "true")
    monkeypatch.setenv("REPOCIV_TOKEN", "test-token-for-remote-32-chars-min!!")
    import importlib
    importlib.reload(bridge)
    assert bridge.BRIDGE_HOST == "0.0.0.0"
    assert bridge.REPOCIV_REMOTE is True


def test_remote_mode_without_token_raises(monkeypatch):
    """With REPOCIV_REMOTE=true but no REPOCIV_TOKEN, bridge raises SystemExit."""
    monkeypatch.setenv("REPOCIV_REMOTE", "true")
    monkeypatch.setenv("REPOCIV_TOKEN", "")  # Override .env: empty = no token
    import importlib
    with pytest.raises(SystemExit):
        importlib.reload(bridge)


def test_dev_mode_works_without_token(monkeypatch):
    """Without REPOCIV_REMOTE, no token is required (dev mode)."""
    monkeypatch.delenv("REPOCIV_REMOTE", raising=False)
    monkeypatch.setenv("REPOCIV_TOKEN", "")  # Override .env: empty = dev mode
    import importlib
    importlib.reload(bridge)
    assert bridge.REPOCIV_REMOTE is False
    assert bridge.REPOCIV_TOKEN == ""  # Empty = dev mode
    assert bridge.BRIDGE_HOST == "127.0.0.1"
