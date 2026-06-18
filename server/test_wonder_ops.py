"""RepoCiv — Wonder connect/disconnect route tests (F2/F3).

Covers server.routes.wonder_ops.post_wonder_connect / post_wonder_disconnect:
the disk write, registry visibility, launcher hot-reload, and 4xx mapping.
Isolates REPOCIV_WONDERS_DIR to tmp_path so the dev machine's connected
wonders don't leak in.
"""

from __future__ import annotations

import pytest

from server import wonder_launcher, wonder_registry
from server.routes import wonder_ops


@pytest.fixture(autouse=True)
def isolate_wonders_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("REPOCIV_WONDERS_DIR", str(tmp_path / "wonders"))
    wonder_launcher.reload_custom_specs()
    yield
    wonder_launcher.reload_custom_specs()


def _manifest(wid="mi-srv", launch=None):
    m = {
        "id": wid,
        "title": "Mi Servicio",
        "kind": "iframe",
        "category": "knowledge",
        "version": "0.1.0",
        "defaultEnabled": True,
        "automationLevel": "passive",
        "passiveMode": True,
        "agenticMode": False,
        "canSuggest": False,
        "canAct": False,
        "requiresConfirmation": True,
        "ui": {"url": "http://127.0.0.1:9998"},
        "permissions": {
            "readRepos": False,
            "writeRepos": False,
            "network": "loopback-only",
            "requiresApprovalForMutations": True,
        },
        "optionalFeatures": [],
        "actions": [{"id": "open", "label": "Abrir", "risk": "safe", "requiresUserOptIn": False}],
        "events": {"emits": ["wonder.ready"], "accepts": []},
        "mcp": {"enabled": False, "server": None},
    }
    if launch is not None:
        m["launch"] = launch
    return m


def test_connect_success_lists_in_registry():
    status, body = wonder_ops.post_wonder_connect(_manifest("mi-srv"), {})
    assert status == 200
    assert body["ok"] is True
    assert body["id"] == "mi-srv"
    assert wonder_registry.get_wonder("mi-srv") is not None


def test_connect_accepts_manifest_wrapper():
    status, body = wonder_ops.post_wonder_connect({"manifest": _manifest("wrapped")}, {})
    assert status == 200
    assert wonder_registry.get_wonder("wrapped") is not None


def test_connect_with_launch_becomes_launchable():
    launch = {
        "repo_dir": "~/repo",
        "api_url": "http://127.0.0.1:9999",
        "procs": [{"name": "x", "argv": ["echo", "hi"]}],
    }
    status, _ = wonder_ops.post_wonder_connect(_manifest("mi-srv", launch=launch), {})
    assert status == 200
    assert "mi-srv" in wonder_launcher.list_launchable()


def test_connect_rejects_bad_manifest():
    status, body = wonder_ops.post_wonder_connect({"id": "x"}, {})
    assert status == 400
    assert body["ok"] is False
    assert body["code"] == "invalid_manifest"


def test_connect_rejects_bad_id():
    status, body = wonder_ops.post_wonder_connect(_manifest("../evil"), {})
    assert status == 400
    assert body["ok"] is False


def test_disconnect_success():
    wonder_ops.post_wonder_connect(_manifest("mi-srv"), {})
    status, body = wonder_ops.post_wonder_disconnect({}, {"wonder_id": "mi-srv"})
    assert status == 200
    assert body["ok"] is True
    assert wonder_registry.get_wonder("mi-srv") is None


def test_disconnect_unknown_is_404():
    status, body = wonder_ops.post_wonder_disconnect({}, {"wonder_id": "never"})
    assert status == 404
    assert body["ok"] is False


def test_disconnect_missing_id():
    status, body = wonder_ops.post_wonder_disconnect({}, {})
    assert status == 400
    assert body["ok"] is False
