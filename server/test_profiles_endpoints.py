"""Tests for the profile-registry HTTP endpoints."""
from __future__ import annotations

import json
from http.server import HTTPServer
import threading
import urllib.error
import urllib.request

import pytest

from server import config_store


class _BridgeThread(threading.Thread):
    """Run the bridge's HTTP handler on a random port for the duration of a test."""

    def __init__(self, handler_cls):
        super().__init__(daemon=True)
        self._server = HTTPServer(("localhost", 0), handler_cls)
        self.port = self._server.server_address[1]

    def run(self) -> None:
        self._server.serve_forever()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()


@pytest.fixture
def bridge(monkeypatch: pytest.MonkeyPatch, tmp_path):
    """Boot the bridge in-process with auth disabled and config dir isolated."""
    # Disable auth so the tests don't need to know the .env token.
    monkeypatch.setattr("server.bridge.REPOCIV_TOKEN", "")
    monkeypatch.setattr(config_store, "_config_path", lambda: tmp_path / "config.json")
    from server.bridge import BridgeHandler
    t = _BridgeThread(BridgeHandler)
    t.start()
    yield t
    t.stop()


def _post(bridge, path: str, body: dict, *, token: str = "") -> tuple[int, dict]:
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-RepoCiv-Token"] = token
    req = urllib.request.Request(
        f"http://localhost:{bridge.port}{path}", data=data, headers=headers, method="POST"
    )
    try:
        resp = urllib.request.urlopen(req, timeout=3)
        return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def _get(bridge, path: str, *, token: str = "") -> tuple[int, dict]:
    headers = {}
    if token:
        headers["X-RepoCiv-Token"] = token
    req = urllib.request.Request(
        f"http://localhost:{bridge.port}{path}", headers=headers, method="GET"
    )
    try:
        resp = urllib.request.urlopen(req, timeout=3)
        return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def test_get_profiles_returns_empty_initially(bridge) -> None:
    status, body = _get(bridge, "/api/profiles", token="test-token")
    assert status == 200
    assert body == {"profiles": {}}


def test_post_profiles_creates_entry(bridge) -> None:
    status, body = _post(bridge, "/api/profiles", {"name": "H", "harness": "hermes"}, token="test-token")
    assert status == 200
    assert body == {"profile": {"harness": "hermes"}}
    status, body = _get(bridge, "/api/profiles", token="test-token")
    assert body == {"profiles": {"H": {"harness": "hermes"}}}


def test_post_profiles_updates_existing(bridge) -> None:
    _post(bridge, "/api/profiles", {"name": "H", "harness": "hermes"}, token="test-token")
    status, body = _post(bridge, "/api/profiles", {"name": "H", "harness": "claude"}, token="test-token")
    assert status == 200
    assert body["profile"] == {"harness": "claude"}


def test_post_profiles_rejects_unknown_harness(bridge) -> None:
    status, body = _post(bridge, "/api/profiles", {"name": "X", "harness": "gpt-99"}, token="test-token")
    assert status == 400
    assert "unknown harness" in body["error"]


def test_post_profiles_rejects_bad_name(bridge) -> None:
    status, _ = _post(bridge, "/api/profiles", {"name": "X!", "harness": "hermes"}, token="test-token")
    assert status == 400


def test_post_profiles_requires_both_fields(bridge) -> None:
    status, _ = _post(bridge, "/api/profiles", {"name": "H"}, token="test-token")
    assert status == 400
    status, _ = _post(bridge, "/api/profiles", {"harness": "hermes"}, token="test-token")
    assert status == 400


def test_post_profiles_delete_removes_entry(bridge) -> None:
    _post(bridge, "/api/profiles", {"name": "H", "harness": "hermes"}, token="test-token")
    status, body = _post(bridge, "/api/profiles/delete", {"name": "H"}, token="test-token")
    assert status == 200
    assert body == {"ok": True}
    status, body = _get(bridge, "/api/profiles", token="test-token")
    assert "H" not in body["profiles"]


def test_post_profiles_delete_unknown_returns_404(bridge) -> None:
    status, body = _post(bridge, "/api/profiles/delete", {"name": "ghost"}, token="test-token")
    assert status == 404


def test_endpoints_require_token_when_token_configured(bridge, monkeypatch) -> None:
    # Simulate enabling auth.
    monkeypatch.setattr("server.bridge.REPOCIV_TOKEN", "real-token")
    # Without the token: 401.
    status, _ = _post(bridge, "/api/profiles", {"name": "H", "harness": "hermes"})
    assert status == 401
    status, _ = _get(bridge, "/api/profiles")
    assert status == 401
    # With the right token: 200.
    status, _ = _post(bridge, "/api/profiles", {"name": "H", "harness": "hermes"}, token="real-token")
    assert status == 200
