"""Tests for server/config_store.py — the profile registry."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from server import config_store


@pytest.fixture
def isolated_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Force the config store to a fresh tmp directory."""
    monkeypatch.setattr(config_store, "_config_path", lambda: tmp_path / "config.json")
    # Reset the migration marker cache if any.
    yield tmp_path


def test_default_registry_is_one_profile_per_harness(isolated_config: Path) -> None:
    # reset_to_default() seeds the shipped baseline on first call.
    profiles = config_store.reset_to_default()
    assert "H" in profiles and profiles["H"]["harness"] == "hermes"
    for name in ("claude", "codex", "cursor", "openclaw"):
        assert name in profiles
        assert profiles[name]["harness"] == name


def test_reset_to_default_populates_shipped_baseline(isolated_config: Path) -> None:
    profiles = config_store.reset_to_default()
    # "H" is the default unit name (uppercase-first sorts first); the
    # other profiles are named after their harness.
    assert "H" in profiles and profiles["H"]["harness"] == "hermes"
    assert "claude" in profiles
    assert "codex" in profiles
    assert "cursor" in profiles
    assert "openclaw" in profiles
    for name in ("claude", "codex", "cursor", "openclaw"):
        assert profiles[name]["harness"] == name


def test_upsert_profile_creates_entry(isolated_config: Path) -> None:
    entry = config_store.upsert_profile("H", "hermes")
    assert entry == {"harness": "hermes"}
    assert config_store.get_profile("H") == {"harness": "hermes"}


def test_upsert_profile_with_optional_fields(isolated_config: Path) -> None:
    entry = config_store.upsert_profile(
        "bigboss", "claude", personality="concise", model="opus-4-5"
    )
    assert entry == {"harness": "claude", "personality": "concise", "model": "opus-4-5"}


def test_upsert_profile_overwrites(isolated_config: Path) -> None:
    config_store.upsert_profile("H", "hermes")
    config_store.upsert_profile("H", "claude")
    assert config_store.get_profile("H") == {"harness": "claude"}


def test_upsert_profile_rejects_unknown_harness(isolated_config: Path) -> None:
    with pytest.raises(ValueError, match="unknown harness"):
        config_store.upsert_profile("H", "gpt-99")


def test_upsert_profile_normalizes_harness_case(isolated_config: Path) -> None:
    entry = config_store.upsert_profile("H", "HERMES")
    assert entry["harness"] == "hermes"


def test_upsert_profile_rejects_bad_name(isolated_config: Path) -> None:
    with pytest.raises(ValueError, match="alphanumeric"):
        config_store.upsert_profile("H!", "hermes")
    with pytest.raises(ValueError, match="non-empty"):
        config_store.upsert_profile("", "hermes")
    with pytest.raises(ValueError, match="exceeds 32"):
        config_store.upsert_profile("a" * 33, "hermes")


def test_delete_profile(isolated_config: Path) -> None:
    config_store.upsert_profile("H", "hermes")
    assert config_store.delete_profile("H") is True
    assert config_store.get_profile("H") is None


def test_delete_profile_missing_returns_false(isolated_config: Path) -> None:
    assert config_store.delete_profile("ghost") is False


def test_get_profile_missing_returns_none(isolated_config: Path) -> None:
    assert config_store.get_profile("ghost") is None


def test_get_harness_for_name(isolated_config: Path) -> None:
    config_store.upsert_profile("H", "hermes")
    assert config_store.get_harness_for_name("H") == "hermes"
    assert config_store.get_harness_for_name("ghost") is None


def test_first_profile_name(isolated_config: Path) -> None:
    # Without auto-baseline, first read returns None.
    assert config_store.first_profile_name() is None
    config_store.upsert_profile("claude-dev", "claude")
    # Only claude-dev exists, so it's first.
    assert config_store.first_profile_name() == "claude-dev"
    # User-inserted uppercase key "A" sorts before claude-dev.
    config_store.upsert_profile("A", "claude")
    assert config_store.first_profile_name() == "A"
    # Test with reset_to_default - "H" is first alphabetically.
    config_store.reset_to_default()
    assert config_store.first_profile_name() == "H"


def test_valid_harnesses_returns_frozenset(isolated_config: Path) -> None:
    harnesses = config_store.valid_harnesses()
    assert "hermes" in harnesses
    assert "claude" in harnesses
    assert "main" not in harnesses
    assert "DAVI" not in harnesses


def test_migrate_legacy_default_harness(isolated_config: Path) -> None:
    # Write the old-format config by hand.
    legacy_path = isolated_config / "config.json"
    legacy_path.write_text(json.dumps({"default_harness": "claude", "user_token": "abc"}))
    profiles = config_store.list_profiles()
    assert "claude" in profiles
    assert profiles["claude"] == {"harness": "claude"}
    # The user_token was carried through.
    raw = json.loads(legacy_path.read_text())
    assert raw["user_token"] == "abc"
    # Migration is idempotent — second call doesn't change anything.
    config_store.list_profiles()
    config_store.list_profiles()
    raw = json.loads(legacy_path.read_text())
    assert "default_harness" not in raw


def test_migrate_legacy_ignores_invalid_harness(isolated_config: Path) -> None:
    legacy_path = isolated_config / "config.json"
    legacy_path.write_text(json.dumps({"default_harness": "gpt-99"}))
    # The legacy field is malformed; the migration marker is written and
    # the registry stays empty.
    profiles = config_store.list_profiles()
    assert profiles == {}
    raw = json.loads(legacy_path.read_text())
    assert "default_harness" in raw  # left untouched; user can fix manually


def test_malformed_profile_entries_are_skipped(isolated_config: Path) -> None:
    """A bad entry in profiles doesn't crash — it's just dropped on read."""
    config_path = isolated_config / "config.json"
    config_path.write_text(json.dumps({
        "version": 1,
        "profiles": {
            "good": {"harness": "hermes"},
            "bad": {"harness": "gpt-99"},          # unknown harness
            "ugly": {"harness": "claude", "personality": 123},  # bad type
            "fine": {"harness": "cursor"},
        },
    }))
    profiles = config_store.list_profiles()
    assert set(profiles.keys()) == {"good", "fine"}


def test_atomic_write_does_not_corrupt_on_partial_failure(
    isolated_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_store.upsert_profile("H", "hermes")
    # Snapshot the file before the failed write.
    config_path = isolated_config / "config.json"
    snapshot = config_path.read_text()
    # Force the atomic rename step to fail. Anything before that (the tmp
    # file write) can still happen, but the on-disk state must be unchanged.
    real_replace = os.replace

    def failing_replace(src: str, dst: str) -> None:
        raise OSError("simulated disk full")

    monkeypatch.setattr(os, "replace", failing_replace)
    try:
        with pytest.raises(OSError, match="simulated disk full"):
            config_store.upsert_profile("H", "claude")
    finally:
        monkeypatch.setattr(os, "replace", real_replace)
    # The file should be unchanged because we use atomic rename.
    assert config_path.read_text() == snapshot
    assert config_store.get_harness_for_name("H") == "hermes"


def test_upsert_persists_to_disk(isolated_config: Path) -> None:
    config_store.upsert_profile("H", "hermes", model="opus-4-5")
    # Read the file directly to confirm persistence.
    raw = json.loads((isolated_config / "config.json").read_text())
    assert raw["profiles"]["H"] == {"harness": "hermes", "model": "opus-4-5"}
    assert raw["version"] == 1


def test_upsert_profile_new_fields(isolated_config: Path) -> None:
    entry = config_store.upsert_profile(
        "reviewer",
        "claude",
        harness_ref="default",
        display_name="Code Reviewer",
        identity_mode="managed",
        slot_order=2,
    )
    assert entry["harness"] == "claude"
    assert entry["harness_ref"] == "default"
    assert entry["display_name"] == "Code Reviewer"
    assert entry["identity_mode"] == "managed"
    assert entry["slot_order"] == 2
    # Round-trip persistence
    loaded = config_store.get_profile("reviewer")
    assert loaded is not None
    assert loaded["slot_order"] == 2
    assert loaded["identity_mode"] == "managed"


def test_upsert_profile_rejects_invalid_identity_mode(isolated_config: Path) -> None:
    with pytest.raises(ValueError, match="identity_mode"):
        config_store.upsert_profile("H", "hermes", identity_mode="unknown")


def test_harness_alias_normalization(isolated_config: Path) -> None:
    entry = config_store.upsert_profile("H", "claude-code")
    assert entry["harness"] == "claude"


def test_get_set_default_harness(isolated_config: Path) -> None:
    # Before setting: should be None
    assert config_store.get_default_harness() is None
    # Set a valid harness
    result = config_store.set_default_harness("claude")
    assert result == "claude"
    assert config_store.get_default_harness() == "claude"
    # Alias normalisation
    result = config_store.set_default_harness("claude-code")
    assert result == "claude"
    assert config_store.get_default_harness() == "claude"


def test_set_default_harness_rejects_unknown(isolated_config: Path) -> None:
    with pytest.raises(ValueError, match="unknown harness"):
        config_store.set_default_harness("gpt-99")
