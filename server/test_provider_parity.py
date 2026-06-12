"""Provider/model parity tests — RepoCiv bridge vs Hermes /model TUI.

Living ExecPlan: execplan/provider-model-parity-with-hermes-tui.md

Validates that the bridge exposes the same provider/model universe that
`hermes model` shows in the TUI, by importing the same
`build_models_payload` function Hermes uses for its GUI pickers.

Tests are integration-local (read real ~/.hermes). Skipped on hosts
without hermes-agent installed (so the public repo doesn't fail).
"""

from __future__ import annotations

from pathlib import Path

import pytest

HERMES_AGENT = Path.home() / ".hermes" / "hermes-agent"
pytestmark = pytest.mark.skipif(
    not HERMES_AGENT.exists(),
    reason="hermes-agent not installed (skip on public CI)",
)


# ─── T1: import smoke ──────────────────────────────────────────────────────


def test_hermes_import_ok() -> None:
    from server import provider_registry as pr

    assert pr._HERMES_IMPORT_OK, f"import failed: {pr._HERMES_IMPORT_ERROR}"


# ─── T2: parity of slugs vs Hermes payload ─────────────────────────────────


def test_provider_slugs_match_hermes_payload() -> None:
    from server import provider_registry as pr

    payload = pr._hermes_models_payload()
    assert payload is not None, "hermes payload should be available"
    hermes_slugs = {r["slug"] for r in payload["providers"] if r.get("slug")}
    bridge = pr._get_providers()
    assert bridge.get("hermesParity") is True
    bridge_slugs = {p["id"] for p in bridge["providers"]}
    assert bridge_slugs == hermes_slugs, (
        f"slug mismatch — only in bridge: {sorted(bridge_slugs - hermes_slugs)}; "
        f"only in hermes: {sorted(hermes_slugs - bridge_slugs)}"
    )


# ─── T3: parity of ollama-cloud models (bridge vs payload, not vs cache) ───


def test_ollama_cloud_models_match_hermes_payload() -> None:
    from server import provider_registry as pr

    payload = pr._hermes_models_payload()
    hermes_row = next(r for r in payload["providers"] if r["slug"] == "ollama-cloud")
    bridge = pr._get_providers()
    bridge_row = next(p for p in bridge["providers"] if p["id"] == "ollama-cloud")
    assert [m["id"] for m in bridge_row["models"]] == list(hermes_row["models"]), (
        "ollama-cloud model IDs diverged between bridge and Hermes payload"
    )


# ─── T4: grouped slugs carry group_id ──────────────────────────────────────


def test_grouped_slugs_carry_group_id() -> None:
    from server import provider_registry as pr

    bridge = pr._get_providers()
    by_id = {p["id"]: p for p in bridge["providers"]}
    for slug, gid in (
        ("minimax", "minimax"),
        ("minimax-oauth", "minimax"),
        ("kimi-coding", "kimi"),
        ("xai", "xai"),
    ):
        if slug in by_id:
            assert by_id[slug]["group"] == gid, (
                f"{slug} should have group={gid}, got {by_id[slug].get('group')!r}"
            )


# ─── T5: fallback legacy when Hermes import broken ─────────────────────────


def test_fallback_when_hermes_unimportable(monkeypatch: pytest.MonkeyPatch) -> None:
    import server.provider_registry as pr

    # Force-disable the import and clear the payload cache so the next
    # call to _get_providers() actually re-evaluates the fallback path.
    monkeypatch.setattr(pr, "_HERMES_IMPORT_OK", False)
    monkeypatch.setattr(pr, "_hermes_payload_cache", None)
    # Also clear module-level cache used by _get_chat_config.
    if hasattr(pr, "_cache") and pr._cache is not None:
        monkeypatch.setattr(pr, "_cache", None)

    data = pr._get_providers()
    assert data.get("hermesParity") is False
    assert "providers" in data
    assert len(data["providers"]) >= 1, "legacy registry should still serve providers"


# ─── T6: shape of chat-config intact (UI contract) ────────────────────────


def test_chat_config_shape_for_ui() -> None:
    from server.provider_registry import _get_chat_config

    cfg = _get_chat_config()
    for key in ("harnesses", "defaultHarness", "defaultProvider", "providers"):
        assert key in cfg, f"chat_config missing top-level key: {key}"
    assert cfg["providers"], "chat_config.providers must be non-empty"
    p = cfg["providers"][0]
    for key in ("id", "name", "available", "configured", "defaultModel", "models"):
        assert key in p, f"provider row missing key: {key}"
    if p["models"]:
        assert {"id", "name", "harnesses"} <= set(p["models"][0]), (
            "model row missing required keys (id, name, harnesses)"
        )
