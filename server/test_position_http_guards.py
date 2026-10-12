"""Real HTTP position guards; no user config or real missions are modified."""
import json
import urllib.error
import urllib.request

import pytest

from server import bridge
from server.test_bridge_integration import _start_test_server


@pytest.fixture
def http_guard(monkeypatch):
    monkeypatch.setattr(bridge, "REPOCIV_TOKEN", "isolated-test-token-xxxxxxxxxxxxxxxx")
    monkeypatch.setattr(bridge, "_rate_buckets", {})
    if hasattr(bridge, "_position_rate_buckets"):
        monkeypatch.setattr(bridge, "_position_rate_buckets", {})
    monkeypatch.setitem(bridge._registry.POST_EXACT, "/api/agent-events", lambda body, ctx: (200, {"accepted": True}))
    monkeypatch.setitem(bridge._registry.POST_EXACT, "/test-interactive", lambda body, ctx: (200, {"ok": True}))
    server, base = _start_test_server()
    def post(path, *, authenticated=True):
        headers = {"Content-Type": "application/json"}
        if authenticated:
            headers["X-RepoCiv-Token"] = bridge.REPOCIV_TOKEN
        request = urllib.request.Request(base + path, data=b"{}", headers=headers, method="POST")
        try:
            response = urllib.request.urlopen(request, timeout=2)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)
    try:
        yield post
    finally:
        server.shutdown()
        server.server_close()


def test_position_traffic_does_not_starve_interactive_posts(http_guard):
    for _ in range(61):
        assert http_guard("/api/agent-events")[0] == 200
    assert http_guard("/test-interactive") == (200, {"ok": True})


def test_interactive_budget_does_not_starve_positions(http_guard):
    for _ in range(60):
        assert http_guard("/test-interactive")[0] == 200
    assert http_guard("/test-interactive")[0] == 429
    assert http_guard("/api/agent-events?source=hook")[0] == 200


def test_position_endpoint_disabled_without_configured_token(http_guard, monkeypatch):
    monkeypatch.setattr(bridge, "REPOCIV_TOKEN", "")
    assert http_guard("/api/agent-events", authenticated=False) == (503, {"error": "position_auth_required"})
    assert http_guard("/test-interactive", authenticated=False)[0] == 200


def test_unauthenticated_requests_never_consume_budgets(http_guard):
    for _ in range(61):
        assert http_guard("/api/agent-events", authenticated=False)[0] == 401
    assert http_guard("/api/agent-events")[0] == 200
    assert http_guard("/test-interactive")[0] == 200


def test_position_bucket_still_has_its_own_bound(monkeypatch):
    monkeypatch.setattr(bridge, "_rate_buckets", {})
    monkeypatch.setattr(bridge, "_position_rate_buckets", {}, raising=False)
    monkeypatch.setattr(bridge, "_POSITION_RATE_LIMIT", 3, raising=False)
    assert all(bridge._rate_check("isolated", position=True) for _ in range(3))
    assert not bridge._rate_check("isolated", position=True)
    assert bridge._rate_check("isolated")
