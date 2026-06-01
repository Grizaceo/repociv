"""RepoCiv — Wonder Registry Python Tests."""

from wonder_registry import (
    list_wonders,
    get_wonder,
    check_wonder_health,
)


def test_list_wonders_returns_three():
    all_w = list_wonders()
    assert len(all_w) == 3
    ids = sorted(w["id"] for w in all_w)
    assert ids == ["bibliotheca", "gaceta", "institutum"]


def test_list_wonders_returns_copy():
    a = list_wonders()
    b = list_wonders()
    assert a == b
    # Modification does not affect the other
    a.append({"id": "fake"})
    assert len(b) == 3


def test_get_wonder_returns_manifest():
    m = get_wonder("gaceta")
    assert m is not None
    assert m["id"] == "gaceta"
    assert m["title"] == "La Gaceta Imperial"
    assert m["kind"] == "native"
    assert m["automationLevel"] == "passive"
    assert m["passiveMode"] is True
    assert m["agenticMode"] is False
    assert m["canSuggest"] is False
    assert m["canAct"] is False


def test_get_wonder_bibliotheca():
    m = get_wonder("bibliotheca")
    assert m is not None
    assert m["id"] == "bibliotheca"
    assert m["kind"] == "iframe"
    assert m["automationLevel"] == "passive"
    assert m["canSuggest"] is True
    assert m["canAct"] is False
    assert m["requiresConfirmation"] is True
    assert m["health"] is not None
    assert "/api/health" in m["health"]["url"]
    assert m["ui"] is not None
    assert "url" in m["ui"]


def test_get_wonder_institutum():
    m = get_wonder("institutum")
    assert m is not None
    assert m["id"] == "institutum"
    assert m["kind"] == "iframe"
    assert m["automationLevel"] == "assist"
    assert m["agenticMode"] is True
    assert m["canSuggest"] is True
    assert m["canAct"] is False
    assert m["requiresConfirmation"] is True
    # Should have kill_experiment action with manual risk
    kill_action = [a for a in m["actions"] if a["id"] == "kill_experiment"]
    assert len(kill_action) == 1
    assert kill_action[0]["risk"] == "manual"
    assert kill_action[0]["requiresUserOptIn"] is True


def test_get_wonder_not_found():
    m = get_wonder("nonexistent")
    assert m is None


def test_get_wonder_empty_string():
    m = get_wonder("")
    assert m is None


def test_check_wonder_health_unknown():
    result = check_wonder_health("nonexistent")
    assert result["id"] == "nonexistent"
    assert result["status"] == "unknown"
    assert result["error"] == "not_found"


def test_check_wonder_health_gaceta():
    """Gaceta is native — no health endpoint."""
    result = check_wonder_health("gaceta")
    assert result["id"] == "gaceta"
    assert result["status"] == "native"


def test_manifest_has_optional_features():
    for w in list_wonders():
        for feature in w.get("optionalFeatures", []):
            assert feature["requiresUserOptIn"] is True
            assert feature["defaultEnabled"] is False


def test_manifest_actions_have_required_fields():
    required = {"id", "label", "risk", "requiresUserOptIn"}
    for w in list_wonders():
        for action in w.get("actions", []):
            assert required.issubset(action.keys()), f"Missing fields in {w['id']}.{action.get('id')}"


def test_gaceta_has_foreign_relations_action():
    m = get_wonder("gaceta")
    assert m is not None
    action = next((a for a in m["actions"] if a["id"] == "foreign_relations_report"), None)
    assert action is not None
    assert action["requiresUserOptIn"] is True


def test_institutum_has_hardLocks_feature():
    m = get_wonder("institutum")
    assert m is not None
    feature = next((f for f in m["optionalFeatures"] if f["id"] == "hardLocks"), None)
    assert feature is not None
    assert feature["requiresUserOptIn"] is True
    assert feature["defaultEnabled"] is False


def test_events_are_valid_strings():
    for w in list_wonders():
        for emitted in w.get("events", {}).get("emits", []):
            assert isinstance(emitted, str) and len(emitted) > 0
        for accepted in w.get("events", {}).get("accepts", []):
            assert isinstance(accepted, str) and len(accepted) > 0


def test_mcp_defaults_to_disabled():
    for w in list_wonders():
        assert w["mcp"]["enabled"] is False
        assert w["mcp"]["server"] is None