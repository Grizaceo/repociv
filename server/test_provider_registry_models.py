"""Regression tests for provider_registry model-list normalization.

These are pure (no hermes-agent, no network): they stub _read_hermes_yaml and
exercise _build_dynamic_providers directly, so they run on public CI too —
unlike test_provider_parity.py, which is skipped without hermes-agent.

Guards the KeyError: 0 crash that happened when a provider's `models:` in
~/.hermes/config.yaml was a mapping (keys = model ids, as `kiraai` uses) instead
of a list. `_build_dynamic_providers` did `yaml_models[0]`. See _yaml_model_ids.
"""

from __future__ import annotations

import pytest

from server import provider_registry as pr


def test_yaml_model_ids_accepts_list_dict_and_junk() -> None:
    assert pr._yaml_model_ids(["a", "b"]) == ["a", "b"]
    # mapping → keys are the model ids (preserves insertion order)
    assert pr._yaml_model_ids({"m/one": {}, "m/two": {}}) == ["m/one", "m/two"]
    assert pr._yaml_model_ids(None) == []
    assert pr._yaml_model_ids("") == []


def test_build_dynamic_providers_handles_dict_models(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dict-shaped `models:` for a provider absent from the static registry
    must not raise (was KeyError: 0 at yaml_models[0]) and must surface its
    model ids from the mapping keys."""
    monkeypatch.setattr(
        pr,
        "_read_hermes_yaml",
        lambda: {
            "providers": {
                "kiraai": {
                    "api_key_env": "KIRAAI_KEY",
                    "models": {"qwen/q-free": {}, "qwen/q-pro": {}},
                }
            }
        },
    )

    _harnesses, providers = pr._build_dynamic_providers()  # must not raise

    kiraai = next((p for p in providers if p["id"] == "kiraai"), None)
    assert kiraai is not None, "dict-models provider should be surfaced"
    assert [m["id"] for m in kiraai["models"]] == ["qwen/q-free", "qwen/q-pro"]
    assert kiraai["defaultModel"] == "qwen/q-free"


def test_build_dynamic_providers_dict_models_for_known_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Dict-shaped `models:` on a provider that IS in the static registry
    (first merge loop) must also enrich cleanly rather than crash."""
    monkeypatch.setattr(
        pr,
        "_read_hermes_yaml",
        lambda: {"providers": {"ollama-cloud": {"models": {"extra/model-x": {}}}}},
    )

    _harnesses, providers = pr._build_dynamic_providers()

    ollama = next((p for p in providers if p["id"] == "ollama-cloud"), None)
    assert ollama is not None
    assert "extra/model-x" in [m["id"] for m in ollama["models"]]
