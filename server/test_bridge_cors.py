"""Tests for bridge CORS allowed-origins builder (F2.2 — WSL2 / Tailscale).

The CORS allowlist is a frozen set at module import time, but the
build logic is exposed via ``_build_allowed_origins()`` so we can
test it without reloading ``server.bridge`` (which would invalidate
the class identity of ``WonderLauncherError`` for sibling tests).
"""

from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer

from server import bridge
from server.bridge import _build_allowed_origins
from server.routes import registry


def test_default_local_origins():
    out = _build_allowed_origins(port=5273, remote=False, remote_origin="", extra_origins="")
    assert "http://localhost:5273" in out
    assert "http://127.0.0.1:5273" in out
    assert len(out) == 2


def test_cors_origins_env_adds_extra():
    """F2.2 regression: WSL2 IP must be accepted without enabling remote."""
    out = _build_allowed_origins(
        port=5273,
        remote=False,
        remote_origin="",
        extra_origins="http://100.123.206.92:5273",
    )
    assert "http://100.123.206.92:5273" in out
    assert "http://localhost:5273" in out
    assert "http://127.0.0.1:5273" in out


def test_cors_origins_env_multiple():
    """F2.2: comma-separated extra origins."""
    out = _build_allowed_origins(
        port=5273,
        remote=False,
        remote_origin="",
        extra_origins=("http://100.123.206.92:5273, http://my-tailscale-host.ts.net:5273"),
    )
    assert "http://100.123.206.92:5273" in out
    assert "http://my-tailscale-host.ts.net:5273" in out


def test_cors_origins_env_strips_whitespace():
    """F2.2: trailing/leading whitespace per origin is trimmed."""
    out = _build_allowed_origins(
        port=5273,
        remote=False,
        remote_origin="",
        extra_origins="  http://100.123.206.92:5273  ",
    )
    assert "http://100.123.206.92:5273" in out


def test_remote_mode_with_remote_origin():
    """REPOCIV_REMOTE_ORIGIN still works (existing behavior)."""
    out = _build_allowed_origins(
        port=5273,
        remote=True,
        remote_origin="https://foo.example.com:5273",
        extra_origins="",
    )
    assert "https://foo.example.com:5273" in out
    # Localhost pair is still added (so Vite dev proxy works)
    assert "http://localhost:5273" in out
    assert "http://127.0.0.1:5273" in out


def test_remote_mode_without_remote_origin_uses_localhost():
    """REPOCIV_REMOTE without REMOTE_ORIGIN falls back to localhost pair."""
    out = _build_allowed_origins(
        port=5273,
        remote=True,
        remote_origin="",
        extra_origins="",
    )
    # Only the localhost pair (not the REMOTE_ORIGIN)
    assert "http://localhost:5273" in out
    assert "http://127.0.0.1:5273" in out
    assert len(out) == 2


def test_remote_mode_combined_with_extra_origins():
    """F2.2: REMOTE_ORIGIN + extra_origins both work together."""
    out = _build_allowed_origins(
        port=5273,
        remote=True,
        remote_origin="https://foo.example.com:5273",
        extra_origins="http://100.123.206.92:5273",
    )
    assert "https://foo.example.com:5273" in out
    assert "http://100.123.206.92:5273" in out
    assert "http://localhost:5273" in out
    assert len(out) == 4


def test_post_origin_boundary(monkeypatch):
    token = "test-token-for-origin-boundary"
    calls = []

    def route(body, _ctx):
        calls.append(body)
        return 200, {"ok": True}

    monkeypatch.setattr(bridge, "REPOCIV_TOKEN", token)
    monkeypatch.setattr(bridge.BridgeHandler, "_rate_limited", lambda self: False)
    monkeypatch.setitem(registry.POST_EXACT, "/origin-test", route)
    server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.BridgeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def request(origins, *, body=b"{}", with_token=True, path="/origin-test"):
        conn = http.client.HTTPConnection(*server.server_address, timeout=2)
        try:
            conn.putrequest("POST", path)
            conn.putheader("Content-Type", "text/plain")
            conn.putheader("Content-Length", str(len(body)))
            if with_token:
                conn.putheader("X-RepoCiv-Token", token)
            for origin in origins:
                conn.putheader("Origin", origin)
            conn.endheaders(body)
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    try:
        allowed = f"http://127.0.0.1:{bridge.REPOCIV_PORT}"
        for origins in (["https://evil.example"], ["null"], [allowed, allowed]):
            status, body = request(origins)
            assert status == 403
            assert body == {"error": "origin_not_allowed"}
        assert calls == []
        conn = http.client.HTTPConnection(*server.server_address, timeout=2)
        try:
            conn.putrequest("POST", "/origin-test")
            conn.putheader("Origin", "https://evil.example")
            conn.putheader("Content-Length", "100")
            conn.endheaders()
            response = conn.getresponse()
            assert response.status == 403
            assert json.loads(response.read()) == {"error": "origin_not_allowed"}
        finally:
            conn.close()
        # Rejection precedes token checks, body parsing and the agent-events special case.
        assert request(
            ["https://evil.example"], body=b"not json", with_token=False, path="/api/agent-events"
        ) == (403, {"error": "origin_not_allowed"})
        assert request([allowed]) == (200, {"ok": True})
        assert request([]) == (200, {"ok": True})
        assert calls == [{}, {}]
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
