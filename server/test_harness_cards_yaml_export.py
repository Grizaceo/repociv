"""Tests for server.harness_cards_yaml_export — omnigent-style adapter export."""
from __future__ import annotations
import yaml

import json
from pathlib import Path

import pytest

from server import harness_cards_yaml_export as exp


@pytest.fixture
def cards_dir(tmp_path: Path) -> Path:
    cards = tmp_path / "harness_cards"
    cards.mkdir()
    return cards


def _write_card(cards_dir: Path, card_id: str, payload: dict) -> None:
    (cards_dir / f"{card_id}.json").write_text(
        json.dumps(payload, indent=2), encoding="utf-8"
    )


def test_export_one_minimal_card(cards_dir):
    _write_card(cards_dir, "hermes", {
        "id": "hermes",
        "type": "harness",
        "name": "Hermes",
        "description": "Primary harness",
        "transport": ["http", "cli"],
        "discovery": {
            "binary": "hermes",
            "http": {"env": "HERMES_URL", "default": "http://localhost:8642/v1/chat/completions"},
            "cli": {"binary": "hermes", "search_paths": ["$PATH"]},
        },
        "auth": {"http": {"type": "bearer", "env": "HERMES_KEY"}, "cli": "none"},
        "status": "stable",
    })
    text = exp.export_one("hermes", cards_dir=cards_dir)
    assert text is not None
    parsed = yaml.safe_load(text)  # noqa: F821 - the import is in an earlier line
    assert parsed["spec_version"] == 1
    assert parsed["name"] == "hermes"
    assert parsed["display_name"] == "Hermes"
    assert parsed["description"] == "Primary harness"
    assert parsed["executor"]["type"] == "omnigent"
    assert parsed["executor"]["config"]["harness"] == "hermes-native"
    assert parsed["executor"]["config"]["binary"] == "hermes"
    assert parsed["executor"]["config"]["auth_type"] == "bearer"


def test_export_one_returns_none_for_missing(cards_dir):
    assert exp.export_one("nope", cards_dir=cards_dir) is None


def test_export_all_returns_id_to_yaml_dict(cards_dir):
    _write_card(cards_dir, "a", {"id": "a", "name": "A", "description": "alpha",
                                    "transport": ["cli"], "discovery": {"binary": "a-cli"},
                                    "status": "stable"})
    _write_card(cards_dir, "b", {"id": "b", "name": "B", "description": "bravo",
                                    "transport": ["cli"], "discovery": {"binary": "b-cli"},
                                    "status": "stable"})
    # export_all with explicit ids (so test does not need harness_registry)
    out = exp.export_all(["a", "b"], cards_dir=cards_dir)
    assert set(out.keys()) == {"a", "b"}
    assert "name: a" in out["a"]
    assert "name: b" in out["b"]


def test_export_all_skips_missing(cards_dir):
    _write_card(cards_dir, "a", {"id": "a", "name": "A", "description": "alpha",
                                    "transport": ["cli"], "discovery": {"binary": "a-cli"},
                                    "status": "stable"})
    out = exp.export_all(["a", "missing"], cards_dir=cards_dir)
    assert "a" in out
    assert "missing" not in out


def test_write_all_creates_files(cards_dir, tmp_path):
    _write_card(cards_dir, "hermes", {"id": "hermes", "name": "Hermes",
                                        "description": "x", "transport": ["http"],
                                        "discovery": {"http": {"env": "HERMES_URL"}},
                                        "status": "stable"})
    _write_card(cards_dir, "claude", {"id": "claude", "name": "Claude Code",
                                        "description": "y", "transport": ["cli"],
                                        "discovery": {"binary": "claude"},
                                        "status": "stable"})
    out_dir = tmp_path / "yaml_out"
    written = exp.write_all(out_dir, card_ids=["hermes", "claude"], cards_dir=cards_dir)
    assert sorted(p.name for p in written) == ["claude.yaml", "hermes.yaml"]
    assert (out_dir / "hermes.yaml").exists()
    # The YAML file is parseable
    import yaml
    content = (out_dir / "hermes.yaml").read_text(encoding="utf-8")
    loaded = yaml.safe_load(content)
    assert loaded["name"] == "hermes"
    assert loaded["executor"]["config"]["harness"] == "hermes-native"


def test_write_all_creates_outdir_if_missing(cards_dir, tmp_path):
    out_dir = tmp_path / "nested" / "yaml" / "out"
    assert not out_dir.exists()
    _write_card(cards_dir, "openclaw", {"id": "openclaw", "name": "OpenClaw",
                                          "description": "z", "transport": ["cli"],
                                          "discovery": {"binary": "openclaw"},
                                          "status": "stable"})
    written = exp.write_all(out_dir, card_ids=["openclaw"], cards_dir=cards_dir)
    assert out_dir.exists()
    assert len(written) == 1


def test_harness_id_mapping_for_known(cards_dir):
    _write_card(cards_dir, "claude", {
        "id": "claude", "name": "Claude Code", "description": "x",
        "transport": ["cli"], "discovery": {"binary": "claude"}, "status": "stable",
    })
    text = exp.export_one("claude", cards_dir=cards_dir) or ""
    assert "harness: claude-code" in text


def test_harness_id_passthrough_for_unknown(cards_dir):
    _write_card(cards_dir, "custom-thing", {
        "id": "custom-thing", "name": "Custom", "description": "x",
        "transport": ["cli"], "discovery": {"binary": "custom"}, "status": "stable",
    })
    text = exp.export_one("custom-thing", cards_dir=cards_dir) or ""
    assert "harness: custom-thing" in text


def test_profile_binding_block_propagation(cards_dir):
    pb = {
        "harness_ref_semantics": "Name of subdirectory under ~/.hermes/profiles/<harness_ref>",
        "identity_mode": {
            "native": "Read/write ~/.hermes/profiles/<harness_ref>/SOUL.md",
            "managed": "Read/write ~/.repociv/profiles/<name>/identity.md",
        },
        "dispatch_env": "HERMES_HOME=~/.hermes/profiles/{harness_ref}",
    }
    _write_card(cards_dir, "hermes", {
        "id": "hermes", "name": "Hermes", "description": "x",
        "transport": ["http"], "discovery": {"http": {"env": "HERMES_URL"}},
        "auth": "none", "status": "stable", "profile_binding": pb,
    })
    import yaml
    text = exp.export_one("hermes", cards_dir=cards_dir)
    parsed = yaml.safe_load(text)
    assert "profile_binding" in parsed
    pb_out = parsed["profile_binding"]
    assert pb_out["harness_ref_semantics"].startswith("Name of subdirectory")
    assert "Read/write ~/.hermes" in pb_out["identity_native"]
    assert "Read/write ~/.repociv" in pb_out["identity_managed"]
    assert pb_out["dispatch_env"] == "HERMES_HOME=~/.hermes/profiles/{harness_ref}"


def test_yaml_output_is_stable(cards_dir):
    """Calling export_one twice produces identical text — no time-based drift."""
    _write_card(cards_dir, "hermes", {"id": "hermes", "name": "Hermes",
                                        "description": "x", "transport": ["http"],
                                        "discovery": {"http": {"env": "HERMES_URL"}},
                                        "status": "stable"})
    a = exp.export_one("hermes", cards_dir=cards_dir)
    b = exp.export_one("hermes", cards_dir=cards_dir)
    assert a == b
