"""RepoCiv — Profile registry.

Persists user-registered profiles in ~/.repociv/config.json. Each profile
binds a user-facing name to a harness (the engine that runs the unit).
Names and harnesses are independent: the user can have two profiles
backed by the same harness with different display names, and rename
any profile without changing what runs underneath.

Schema:
  {
    "version": 1,
    "profiles": {
      "<name>": {"harness": "<harness>", ...optional},
      ...
    }
  }

The shipped default is one profile per built-in harness. The first
profile (alphabetical, uppercase-first) is the default unit the bridge
spawns when no explicit choice is made. Naming it "H" keeps the short
single-letter convention from the user-facing surface; the harness is
still "hermes".

`reset_to_default()` restores this baseline; `migrate_from_legacy()`
upgrades pre-registry configs (single `default_harness` field) on
first read.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

_CONFIG_DIR_ENV = "REPOCIV_CONFIG_DIR"
_CONFIG_FILENAME = "config.json"

# Built-in harnesses shipped with RepoCiv. The profile registry only
# accepts these as harness values — adding a new harness is a code
# change, not a config change.
_VALID_HARNESSES: frozenset[str] = frozenset({
    "hermes", "claude", "codex", "cursor", "openclaw",
})

# Optional fields accepted in a profile. Validation is permissive —
# unknown fields are passed through untouched so future additions
# don't need a config_store update.
_OPTIONAL_FIELDS: frozenset[str] = frozenset({
    "personality", "system_prompt", "profile_path", "model", "provider",
    # v2 profile fields (agent_profile_command_bar feature)
    "harness_ref", "display_name",
})
_OPTIONAL_INT_FIELDS: frozenset[str] = frozenset({
    "slot_order",
})
_OPTIONAL_ENUM_FIELDS: dict[str, frozenset[str]] = {
    "identity_mode": frozenset({"native", "managed"}),
}

# Canonical harness ID map: normalises display aliases → registry id.
# The registry always stores the short slug; dispatch resolves variants.
HARNESS_ALIASES: dict[str, str] = {
    "claude-code": "claude",
    "claude_code": "claude",
}


def normalize_harness_id(harness: str) -> str:
    """Normalise harness aliases to canonical registry IDs."""
    h = harness.strip().lower()
    return HARNESS_ALIASES.get(h, h)

# Filesystem layout
# ───────────────────────────────────────────────────────────────────────────

def _config_path() -> Path:
    base = os.environ.get(_CONFIG_DIR_ENV) or os.path.join(
        os.path.expanduser("~"), ".repociv"
    )
    return Path(base) / _CONFIG_FILENAME


def _read_raw() -> dict[str, Any]:
    """Best-effort read of the config file. Returns {} on any failure."""
    path = _config_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return {}


def _write_raw(data: dict[str, Any]) -> None:
    """Atomic write of the config file. Creates the directory if needed."""
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _validate_name(name: str) -> str:
    if not isinstance(name, str) or not name.strip():
        raise ValueError("name must be a non-empty string")
    cleaned = name.strip()
    if len(cleaned) > 32:
        raise ValueError(f"name {cleaned!r} exceeds 32 chars")
    if not all(c.isalnum() or c in "-_" for c in cleaned):
        raise ValueError(
            f"name {cleaned!r} must be alphanumeric with optional - or _"
        )
    return cleaned


def _validate_harness(harness: str) -> str:
    if not isinstance(harness, str) or not harness.strip():
        raise ValueError("harness must be a non-empty string")
    normalized = normalize_harness_id(harness)
    if normalized not in _VALID_HARNESSES:
        raise ValueError(
            f"unknown harness {harness!r}; expected one of: "
            f"{', '.join(sorted(_VALID_HARNESSES))}"
        )
    return normalized


def _normalize_profile(raw: dict[str, Any], name: str) -> dict[str, Any]:
    """Validate a single profile entry. Raises ValueError on bad data."""
    if not isinstance(raw, dict):
        raise ValueError(f"profile {name!r} must be an object")
    harness = _validate_harness(raw.get("harness", ""))
    out: dict[str, Any] = {"harness": harness}
    for field in _OPTIONAL_FIELDS:
        if field in raw and raw[field] is not None:
            value = raw[field]
            if not isinstance(value, str):
                raise ValueError(
                    f"profile {name!r}: field {field!r} must be a string"
                )
            out[field] = value
    for field in _OPTIONAL_INT_FIELDS:
        if field in raw and raw[field] is not None:
            value = raw[field]
            if not isinstance(value, int):
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    raise ValueError(
                        f"profile {name!r}: field {field!r} must be an integer"
                    )
            out[field] = value
    for field, allowed in _OPTIONAL_ENUM_FIELDS.items():
        if field in raw and raw[field] is not None:
            value = str(raw[field])
            if value not in allowed:
                raise ValueError(
                    f"profile {name!r}: field {field!r} must be one of: "
                    f"{', '.join(sorted(allowed))}"
                )
            out[field] = value
    return out


# Migration
# ───────────────────────────────────────────────────────────────────────────

_LEGACY_MIGRATION_MARKER = ".migrated-legacy-default-harness"


def _migrate_legacy_default_harness() -> None:
    """One-shot upgrade from the pre-registry config schema.

    Old format: `{"default_harness": "<harness>"}`.
    New format: `{"version": 1, "profiles": {"<name>": {"harness": ...}}}`.

    The old single harness becomes a single profile named after the
    harness itself (e.g. "hermes"). If the user had a saved `default_harness`
    of "claude", the upgraded registry has one entry: "claude" → claude.
    """
    marker = _config_path().parent / _LEGACY_MIGRATION_MARKER
    if marker.exists():
        return
    raw = _read_raw()
    if "default_harness" not in raw:
        marker.touch()
        return
    legacy = raw.get("default_harness")
    if isinstance(legacy, str) and legacy.strip().lower() in _VALID_HARNESSES:
        harness = legacy.strip().lower()
        upgraded = {
            "version": 1,
            "profiles": {harness: {"harness": harness}},
        }
        # Carry over any other legacy fields (e.g. user_token, etc.) untouched.
        for k, v in raw.items():
            if k not in ("default_harness", "profiles", "version"):
                upgraded[k] = v
        _write_raw(upgraded)
    marker.touch()


def _load() -> dict[str, dict[str, Any]]:
    """Read + migrate + return the profiles dict. Empty dict if unset."""
    _migrate_legacy_default_harness()
    raw = _read_raw()
    profiles = raw.get("profiles")
    if not isinstance(profiles, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for name, entry in profiles.items():
        try:
            out[str(name)] = _normalize_profile(entry, str(name))
        except ValueError:
            # Skip malformed entries rather than crash; the user can
            # re-add them via the onboarding UI or a config edit.
            continue
    return out


# Shipped baseline
# ───────────────────────────────────────────────────────────────────────────

def _default_profiles() -> dict[str, dict[str, Any]]:
    """Shipped baseline. "H" is the default unit name (single-letter
    convention matching the TS DEFAULT_UNIT_NAME); the rest are named
    after their harness for clarity in /agents/capabilities.
    """
    return {
        "H": {"harness": "hermes", "harness_ref": "default", "display_name": "MAIN", "slot_order": 0},
        "claude": {"harness": "claude", "harness_ref": "default", "slot_order": 1},
        "codex": {"harness": "codex", "harness_ref": "default", "slot_order": 2},
        "cursor": {"harness": "cursor", "harness_ref": "default", "slot_order": 3},
        "openclaw": {"harness": "openclaw", "harness_ref": "default", "slot_order": 4},
    }


# Public API
# ───────────────────────────────────────────────────────────────────────────

def list_profiles() -> dict[str, dict[str, Any]]:
    """Return the registered profiles. Empty dict if the user has none."""
    return _load()


def get_profile(name: str) -> dict[str, Any] | None:
    """Look up a profile by name. Returns None if not found."""
    profiles = _load()
    return profiles.get(name)


def get_harness_for_name(name: str) -> str | None:
    """Convenience: return the harness for a given profile name."""
    profile = get_profile(name)
    if profile is None:
        return None
    return profile.get("harness")


def first_profile_name() -> str | None:
    """Return the first registered profile (by insertion order, then key)."""
    profiles = _load()
    if not profiles:
        return None
    # Newer Python preserves dict insertion order from JSON load. Sort by
    # key for determinism across Python versions.
    return sorted(profiles.keys())[0]


def upsert_profile(
    name: str,
    harness: str,
    *,
    personality: str | None = None,
    system_prompt: str | None = None,
    profile_path: str | None = None,
    model: str | None = None,
    provider: str | None = None,
    harness_ref: str | None = None,
    display_name: str | None = None,
    identity_mode: str | None = None,
    slot_order: int | None = None,
) -> dict[str, Any]:
    """Create or update a profile. Returns the normalized profile entry."""
    clean_name = _validate_name(name)
    clean_harness = _validate_harness(harness)
    entry: dict[str, Any] = {"harness": clean_harness}
    if personality is not None:
        entry["personality"] = str(personality)
    if system_prompt is not None:
        entry["system_prompt"] = str(system_prompt)
    if profile_path is not None:
        entry["profile_path"] = str(profile_path)
    if model is not None:
        entry["model"] = str(model)
    if provider is not None:
        entry["provider"] = str(provider)
    if harness_ref is not None:
        entry["harness_ref"] = str(harness_ref)
    if display_name is not None:
        entry["display_name"] = str(display_name)
    if identity_mode is not None:
        allowed = _OPTIONAL_ENUM_FIELDS["identity_mode"]
        if identity_mode not in allowed:
            raise ValueError(
                f"identity_mode must be one of: {', '.join(sorted(allowed))}"
            )
        entry["identity_mode"] = identity_mode
    if slot_order is not None:
        entry["slot_order"] = int(slot_order)
    raw = _read_raw()
    profiles = raw.get("profiles", {})
    if not isinstance(profiles, dict):
        profiles = {}
    profiles[clean_name] = entry
    raw["profiles"] = profiles
    raw["version"] = 1
    _write_raw(raw)
    return entry


def delete_profile(name: str) -> bool:
    """Delete a profile by name. Returns True if it existed."""
    clean_name = _validate_name(name)
    raw = _read_raw()
    profiles = raw.get("profiles", {})
    if not isinstance(profiles, dict) or clean_name not in profiles:
        return False
    del profiles[clean_name]
    raw["profiles"] = profiles
    _write_raw(raw)
    return True


def reset_to_default() -> dict[str, dict[str, Any]]:
    """Restore the shipped baseline. Returns the new registry."""
    fresh = _default_profiles()
    raw = _read_raw()
    raw["profiles"] = fresh
    raw["version"] = 1
    _write_raw(raw)
    return fresh


def valid_harnesses() -> frozenset[str]:
    """The set of harness ids accepted by the registry."""
    return _VALID_HARNESSES


def get_default_harness() -> str | None:
    """Return the user's preferred default harness (stored in config.json).

    Written by onboarding (POST /api/config/default-harness). Returns None
    if the user has not yet chosen, in which case the bridge falls back to
    its own cascade (hermes → claude-code → openclaw).
    """
    raw = _read_raw()
    harness = raw.get("default_harness")
    if isinstance(harness, str) and harness.strip().lower() in _VALID_HARNESSES:
        return harness.strip().lower()
    return None


def set_default_harness(harness: str) -> str:
    """Persist the user's preferred default harness. Returns the normalised value."""
    normalized = _validate_harness(harness)
    raw = _read_raw()
    raw["default_harness"] = normalized
    _write_raw(raw)
    return normalized
