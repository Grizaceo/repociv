"""RepoCiv — Wonder Registry Python Tests.

New model (2026-06-17): only the native gaceta is a built-in. iframe wonders
(bibliotheca, institutum, custom services) are connected by writing a manifest
to ~/.repociv/wonders/<id>.json via save_custom_manifest(). Tests isolate that
dir to a tmp_path so the dev machine's real connected wonders don't leak in.
"""

import json

import pytest

from wonder_registry import (
    check_wonder_health,
    delete_custom_manifest,
    get_wonder,
    list_wonders,
    save_custom_manifest,
)


@pytest.fixture(autouse=True)
def isolate_wonders_dir(tmp_path, monkeypatch):
    """Point the custom-manifest dir at an empty tmp dir for every test."""
    monkeypatch.setenv("REPOCIV_WONDERS_DIR", str(tmp_path / "wonders"))
    yield


def _example_manifest(wid="mi-srv", launch=None):
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
        "health": {"url": "http://127.0.0.1:9999/health", "timeoutMs": 4000, "degradedAllowed": True},
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


# ─── Default registry (gaceta-only) ───────────────────────────────────────────


def test_default_registry_is_gaceta_only():
    all_w = list_wonders()
    ids = sorted(w["id"] for w in all_w)
    assert ids == ["gaceta"]


def test_get_wonder_returns_manifest():
    m = get_wonder("gaceta")
    assert m is not None
    assert m["id"] == "gaceta"
    assert m["title"] == "La Gaceta Imperial"
    assert m["kind"] == "native"
    assert m["automationLevel"] == "passive"


def test_iframe_wonders_absent_until_connected():
    assert get_wonder("bibliotheca") is None
    assert get_wonder("institutum") is None


def test_get_wonder_not_found():
    assert get_wonder("nonexistent") is None


def test_get_wonder_empty_string():
    assert get_wonder("") is None


def test_check_wonder_health_unknown():
    result = check_wonder_health("nonexistent")
    assert result["id"] == "nonexistent"
    assert result["status"] == "unknown"
    assert result["error"] == "not_found"


def test_check_wonder_health_gaceta():
    result = check_wonder_health("gaceta")
    assert result["id"] == "gaceta"
    assert result["status"] == "native"


# ─── Connect / disconnect ─────────────────────────────────────────────────────


def test_connect_persists_and_lists():
    saved, err = save_custom_manifest(_example_manifest("mi-srv"))
    assert err is None
    assert saved is not None and saved["id"] == "mi-srv"
    assert get_wonder("mi-srv") is not None
    ids = sorted(w["id"] for w in list_wonders())
    assert ids == ["gaceta", "mi-srv"]


def test_connect_writes_file(tmp_path):
    save_custom_manifest(_example_manifest("mi-srv"))
    path = tmp_path / "wonders" / "mi-srv.json"
    assert path.exists()
    data = json.loads(path.read_text())
    assert data["id"] == "mi-srv"


def test_connect_expands_launch_paths():
    saved, err = save_custom_manifest(
        _example_manifest(
            "mi-srv",
            launch={
                "repo_dir": "~/repo",
                "api_url": "http://127.0.0.1:9999",
                "procs": [{"name": "x", "argv": ["echo", "hi"], "cwd": "~/repo/frontend"}],
            },
        )
    )
    assert err is None and saved is not None
    assert not saved["launch"]["repo_dir"].startswith("~")
    assert not saved["launch"]["procs"][0]["cwd"].startswith("~")


def test_connect_rejects_bad_id():
    saved, err = save_custom_manifest(_example_manifest("../evil"))
    assert saved is None
    assert err is not None


def test_connect_rejects_missing_fields():
    saved, err = save_custom_manifest({"id": "x"})
    assert saved is None
    assert "missing required fields" in err


def test_connect_rejects_non_object():
    saved, err = save_custom_manifest("not a dict")
    assert saved is None
    assert err is not None


def test_disconnect_removes():
    save_custom_manifest(_example_manifest("mi-srv"))
    assert get_wonder("mi-srv") is not None
    ok, err = delete_custom_manifest("mi-srv")
    assert ok is True and err is None
    assert get_wonder("mi-srv") is None


def test_disconnect_unknown():
    ok, err = delete_custom_manifest("never-connected")
    assert ok is False
    assert err == "not connected"


def test_disconnect_bad_id():
    ok, err = delete_custom_manifest("../etc/passwd")
    assert ok is False
    assert err == "invalid id"


# ─── Invariants over whatever is registered ───────────────────────────────────


def test_manifest_has_optional_features():
    save_custom_manifest(_example_manifest("mi-srv"))
    for w in list_wonders():
        for feature in w.get("optionalFeatures", []):
            assert feature["requiresUserOptIn"] is True
            assert feature["defaultEnabled"] is False


def test_manifest_actions_have_required_fields():
    save_custom_manifest(_example_manifest("mi-srv"))
    required = {"id", "label", "risk", "requiresUserOptIn"}
    for w in list_wonders():
        for action in w.get("actions", []):
            assert required.issubset(action.keys())


def test_gaceta_has_foreign_relations_action():
    m = get_wonder("gaceta")
    assert m is not None
    action = next((a for a in m["actions"] if a["id"] == "foreign_relations_report"), None)
    assert action is not None
    assert action["requiresUserOptIn"] is True


def test_mcp_defaults_to_disabled():
    save_custom_manifest(_example_manifest("mi-srv"))
    for w in list_wonders():
        assert w["mcp"]["enabled"] is False
        assert w["mcp"]["server"] is None
