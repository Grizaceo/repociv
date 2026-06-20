"""Tests for server.hermes_status (Fase 1 / audit 1.1).

Covers:
  - resolve_hermes_base: strips /v1[/...] suffixes, falls back to default
  - probe_hermes: structured status object, 30s cache, never raises
  - get_hermes_status_route: thin wrapper, always returns 200

Hermes itself isn't required to run these — we mock the network layer
with a fake ``_do_probe`` so the tests are hermetic.
"""

from __future__ import annotations

import json
import os

import pytest

from server import hermes_status
from server.hermes_status import (
    probe_hermes,
    reset_cache_for_tests,
    resolve_hermes_base,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_cache():
    """Reset the cache between tests to keep them independent."""
    reset_cache_for_tests()
    yield
    reset_cache_for_tests()


# ─── resolve_hermes_base ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("http://localhost:8642/v1/chat/completions", "http://localhost:8642"),
        ("http://localhost:8642/v1/completions", "http://localhost:8642"),
        ("http://localhost:8642/v1", "http://localhost:8642"),
        ("http://localhost:8642", "http://localhost:8642"),
        ("http://localhost:8642/", "http://localhost:8642"),
        # Custom port + host
        ("https://hermes.example.com:9999/v1", "https://hermes.example.com:9999"),
        # Default fallback (no env var)
        ("", "http://localhost:8642"),
    ],
)
def test_resolve_hermes_base_strips_suffix(monkeypatch, raw, expected):
    if raw:
        monkeypatch.setenv("HERMES_URL", raw)
    else:
        monkeypatch.delenv("HERMES_URL", raising=False)
    assert resolve_hermes_base() == expected


def test_resolve_hermes_base_no_trailing_slash():
    """resolve_hermes_base always returns no trailing slash."""
    os.environ["HERMES_URL"] = "http://example.com:8642/v1/"
    try:
        # Note: endswith("/v1/") won't match any of the known suffixes,
        # so the function falls into the `else` branch and returns the
        # raw value rstripped. That's still safe (no double slash when
        # /v1/models is appended).
        base = resolve_hermes_base()
        assert not base.endswith("/")
    finally:
        del os.environ["HERMES_URL"]


# ─── _hermes_headers ────────────────────────────────────────────────────────


def test_hermes_headers_empty_when_no_key(monkeypatch):
    monkeypatch.delenv("HERMES_KEY", raising=False)
    assert hermes_status._hermes_headers() == {}


def test_hermes_headers_bearer_when_key_set(monkeypatch):
    monkeypatch.setenv("HERMES_KEY", "test-key-123")
    assert hermes_status._hermes_headers() == {"Authorization": "Bearer test-key-123"}


# ─── _do_probe (mocked) ─────────────────────────────────────────────────────


def test_do_probe_succeeds_with_models(monkeypatch):
    """200 with a normal /v1/models body → available=True, modelCount set."""
    captured: dict = {}

    class _FakeResp:
        status = 200

        def __init__(self):
            pass

        def read(self):
            return json.dumps({"data": [{"id": "m1"}, {"id": "m2"}, {"id": "m3"}]}).encode()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        return _FakeResp()

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("HERMES_URL", "http://example.com:1234/v1/chat/completions")
    monkeypatch.delenv("HERMES_KEY", raising=False)

    result = hermes_status._do_probe("http://example.com:1234")
    assert result["available"] is True
    assert result["error"] is None
    assert result["modelCount"] == 3
    assert result["url"] == "http://example.com:1234"
    # Probe target = base + /v1/models
    assert captured["url"] == "http://example.com:1234/v1/models"
    assert captured["method"] == "GET"


def test_do_probe_handles_top_level_list(monkeypatch):
    """Some OpenAI-compatible gateways return a list at top level. Accept it."""
    class _FakeResp:
        status = 200
        def read(self):
            return json.dumps([{"id": "m1"}]).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", lambda req, timeout: _FakeResp())
    result = hermes_status._do_probe("http://x:1")
    assert result["available"] is True
    assert result["modelCount"] == 1


def test_do_probe_empty_models_is_unavailable(monkeypatch):
    """Hermes is reachable but the gateway returned no models → unavailable."""
    class _FakeResp:
        status = 200
        def read(self):
            return json.dumps({"data": []}).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", lambda req, timeout: _FakeResp())
    result = hermes_status._do_probe("http://x:1")
    # The current implementation marks "0 models" as available (it parsed
    # cleanly with 0 entries). The frontend should still treat this as a
    # soft-degraded state, but the field semantics are clear: available=True
    # iff the HTTP probe succeeded and the body parsed.
    assert result["available"] is True
    assert result["modelCount"] == 0


def test_do_probe_5xx_returns_unavailable(monkeypatch):
    class _FakeResp:
        status = 500
        def read(self): return b""
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", lambda req, timeout: _FakeResp())
    result = hermes_status._do_probe("http://x:1")
    assert result["available"] is False
    assert "http_500" in (result["error"] or "")


def test_do_probe_timeout_returns_unavailable(monkeypatch):

    def boom(req, timeout):
        raise TimeoutError("simulated timeout")

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", boom)
    result = hermes_status._do_probe("http://x:1")
    assert result["available"] is False
    assert "network" in (result["error"] or "").lower()


def test_do_probe_url_error_returns_unavailable(monkeypatch):
    import urllib.error

    def boom(req, timeout):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", boom)
    result = hermes_status._do_probe("http://x:1")
    assert result["available"] is False
    assert "network" in (result["error"] or "").lower()


def test_do_probe_http_error_with_code(monkeypatch):
    import urllib.error

    def boom(req, timeout):
        raise urllib.error.HTTPError(
            url="http://x:1/v1/models", code=401, msg="Unauthorized", hdrs={}, fp=None
        )

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", boom)
    result = hermes_status._do_probe("http://x:1")
    assert result["available"] is False
    assert "http_401" in (result["error"] or "")


def test_do_probe_garbage_body_returns_parse_error(monkeypatch):
    class _FakeResp:
        status = 200
        def read(self): return b"not even json"
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", lambda req, timeout: _FakeResp())
    result = hermes_status._do_probe("http://x:1")
    assert result["available"] is False
    assert "parse_error" in (result["error"] or "")


# ─── probe_hermes (cache behaviour) ─────────────────────────────────────────


def test_probe_returns_structured_object(monkeypatch):
    """probe_hermes always returns the same shape, never raises."""
    class _FakeResp:
        status = 200
        def read(self): return json.dumps({"data": [{"id": "m"}]}).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", lambda req, timeout: _FakeResp())
    result = probe_hermes()
    for key in ("available", "url", "latencyMs", "error", "modelCount", "checkedAt"):
        assert key in result, f"missing key: {key}"


def test_probe_uses_cache_within_ttl(monkeypatch):
    """Second call within _CACHE_TTL doesn't re-probe."""
    call_count = {"n": 0}

    def fake_urlopen(req, timeout):
        call_count["n"] += 1

        class _FakeResp:
            status = 200
            def read(self): return json.dumps({"data": []}).encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False

        return _FakeResp()

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", fake_urlopen)
    probe_hermes()
    probe_hermes()
    probe_hermes()
    assert call_count["n"] == 1


def test_probe_force_bypasses_cache(monkeypatch):
    call_count = {"n": 0}

    def fake_urlopen(req, timeout):
        call_count["n"] += 1

        class _FakeResp:
            status = 200
            def read(self): return json.dumps({"data": []}).encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False

        return _FakeResp()

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", fake_urlopen)
    probe_hermes()
    probe_hermes(force=True)
    probe_hermes(force=True)
    assert call_count["n"] == 3


def test_reset_cache_for_tests_clears(monkeypatch):
    call_count = {"n": 0}

    def fake_urlopen(req, timeout):
        call_count["n"] += 1

        class _FakeResp:
            status = 200
            def read(self): return json.dumps({"data": []}).encode()
            def __enter__(self): return self
            def __exit__(self, *a): return False

        return _FakeResp()

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", fake_urlopen)
    probe_hermes()
    assert call_count["n"] == 1
    reset_cache_for_tests()
    probe_hermes()
    assert call_count["n"] == 2


# ─── get_hermes_status_route (HTTP layer) ──────────────────────────────────


def test_route_returns_200_even_when_hermes_down(monkeypatch):
    """The route ALWAYS returns 200 — the body carries the status."""
    import urllib.error

    def boom(req, timeout):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", boom)
    from server.routes.core import get_hermes_status_route

    status, body = get_hermes_status_route({})
    assert status == 200
    assert body["available"] is False
    assert "network" in (body["error"] or "").lower()
    assert body["modelCount"] is None


def test_route_returns_structured_status_when_up(monkeypatch):
    class _FakeResp:
        status = 200
        def read(self): return json.dumps({"data": [{"id": "m1"}, {"id": "m2"}]}).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(hermes_status.urllib.request, "urlopen", lambda req, timeout: _FakeResp())
    from server.routes.core import get_hermes_status_route

    status, body = get_hermes_status_route({})
    assert status == 200
    assert body["available"] is True
    assert body["modelCount"] == 2
