from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

from server import bridge


@pytest.fixture
def bridge_http():
    old_token = bridge.REPOCIV_TOKEN
    old_origins = bridge._ALLOWED_ORIGINS
    bridge.REPOCIV_TOKEN = ""
    bridge._ALLOWED_ORIGINS = {
        "http://127.0.0.1:5273",
        "http://localhost:5273",
    }
    server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.BridgeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        bridge.REPOCIV_TOKEN = old_token
        bridge._ALLOWED_ORIGINS = old_origins


def request(port: int, method: str, path: str, *, headers=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    payload = body if isinstance(body, bytes) else json.dumps(body or {}).encode()
    merged = {"Content-Length": str(len(payload)), **(headers or {})}
    conn.request(method, path, body=payload if method == "POST" else None, headers=merged)
    response = conn.getresponse()
    raw = response.read()
    result = response.status, dict(response.getheaders()), raw
    conn.close()
    return result


def test_foreign_and_originless_json_mutations_are_rejected_without_token(bridge_http):
    common = {"Content-Type": "application/json"}
    assert request(
        bridge_http,
        "POST",
        "/commands",
        headers={**common, "Origin": "https://evil.example"},
        body={"type": "unknown"},
    )[0] == 403
    assert request(
        bridge_http,
        "POST",
        "/commands",
        headers=common,
        body={"type": "unknown"},
    )[0] == 403


def test_same_origin_requires_json_and_reaches_command_validation(bridge_http):
    origin = "http://127.0.0.1:5273"
    assert request(
        bridge_http,
        "POST",
        "/commands",
        headers={"Content-Type": "text/plain", "Origin": origin},
        body=b"{}",
    )[0] == 415
    status, headers, _ = request(
        bridge_http,
        "POST",
        "/commands",
        headers={"Content-Type": "application/json", "Origin": origin},
        body={"type": "unknown"},
    )
    assert status == 400
    assert headers.get("Access-Control-Allow-Origin") == origin


def test_preflight_and_sse_reject_foreign_origin(bridge_http):
    assert request(
        bridge_http,
        "OPTIONS",
        "/commands",
        headers={"Origin": "https://evil.example"},
    )[0] == 403
    assert request(
        bridge_http,
        "OPTIONS",
        "/commands",
        headers={"Origin": "http://127.0.0.1:5273"},
    )[0] == 204
    assert request(
        bridge_http,
        "GET",
        "/events?since=0",
        headers={"Origin": "https://evil.example"},
    )[0] == 401
    assert request(
        bridge_http,
        "GET",
        "/events?since=0",
        headers={"Origin": "http://127.0.0.1:5273"},
    )[0] == 200


def test_configured_token_is_required_even_for_same_origin(bridge_http):
    token = "t" * 32
    bridge.REPOCIV_TOKEN = token
    origin_headers = {
        "Content-Type": "application/json",
        "Origin": "http://127.0.0.1:5273",
    }
    assert request(
        bridge_http,
        "POST",
        "/commands",
        headers=origin_headers,
        body={"type": "unknown"},
    )[0] == 401
    assert request(
        bridge_http,
        "POST",
        "/commands",
        headers={
            "Content-Type": "application/json",
            "X-RepoCiv-Token": token,
        },
        body={"type": "unknown"},
    )[0] == 400
