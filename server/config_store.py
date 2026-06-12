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
#
# `stateful` is special: it's a bool, not a str, so it has its own
# branch in _normalize_profile. Controls whether the hermes CLI
# subprocess uses --continue <session-name> (stateful) or starts a
# fresh context each mission (stateless). SCOUT and WORKER are
# stateless by design — see their SOUL.md.
_OPTIONAL_FIELDS: frozenset[str] = frozenset({
    "personality", "system_prompt", "profile_path", "model", "provider",
})
_BOOL_FIELDS: frozenset[str] = frozenset({"stateful"})

# Filesystem layout
# ───────────────────────────────────────────────────────────────────────────

def _config_path() -> Path:
    base = os.environ.get(_CONFIG_DIR_ENV) or os.path.join(
        os.path.expanduser("~"), ".repociv"
    )
    # Belt-and-suspenders: Path() does not expand `~`, so if a caller
    # passes a literal `~/.repociv` (e.g. from a stale .pyc or a test
    # fixture), expand it here. Idempotent on already-expanded paths.
    return Path(os.path.expanduser(str(Path(base) / _CONFIG_FILENAME)))


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
    normalized = harness.strip().lower()
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
    for field in _BOOL_FIELDS:
        if field in raw and raw[field] is not None:
            value = raw[field]
            if not isinstance(value, bool):
                raise ValueError(
                    f"profile {name!r}: field {field!r} must be a bool"
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
    """Read + migrate + return the profiles dict.

    On first read with no config file, the shipped baseline is written
    to disk so the user has the full set out of the box — including the
    built-in civilization units (H, DAVI, MAIN, SCOUT, WORKER, LEXO)
    and the named harness profiles (claude, codex, cursor, openclaw).
    This is a one-shot auto-baseline; later edits to the file take
    precedence, and `reset_to_default()` re-applies the baseline.
    """
    _migrate_legacy_default_harness()
    path = _config_path()
    if not path.exists():
        # First run: write the shipped baseline. From here on the file
        # is the source of truth, so the user can edit or delete entries.
        _write_default_baseline(path)
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


def _write_default_baseline(path: Path) -> None:
    """Write the shipped baseline to disk on first run.

    Idempotent: caller checks `not path.exists()` before calling, and
    atomic rename keeps the file consistent on partial failures.
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return
    payload = {"version": 1, "profiles": _default_profiles()}
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass


# Shipped baseline
# ───────────────────────────────────────────────────────────────────────────

def _default_profiles() -> dict[str, dict[str, Any]]:
    """Shipped baseline.

    Built-in civilization units (SCOUT, WORKER) and the legal subagent
    (LEXO) ship with their own hermes profiles under
    ~/.hermes/profiles/<name>/. Each profile has its own SOUL.md, config,
    skills, and memory — so a SCOUT agent answers as the scout persona,
    not as DAVI.

    The harness card `server/harness_cards/hermes.json` already lists
    WORKER and SCOUT as `built_in_agents`; this function is what wires
    the unit_id prefix → hermes profile path lookup at runtime.
    """
    return {
        # H, DAVI, MAIN are the main-DAVI identity. They deliberately
        # have NO profile_path: the bridge's _execute_streaming falls
        # through to the HTTP hermes gateway (hermes -m chat over HTTP),
        # which serves the active main profile without spawning a
        # subprocess or requiring a --continue session name. This is
        # the path that was working before Issue 2 was reported and
        # should not be changed without understanding the trade-offs
        # (a subprocess hermes-cli with HERMES_HOME=~/.hermes works
        # too, but then DAVI's existing chat history via the
        # gateway is bypassed).
        "H":      {"harness": "hermes"},
        "DAVI":   {"harness": "hermes"},
        "MAIN":   {"harness": "hermes"},
        # Civilization units — each has its own SOUL.md and config.
        # They MUST be invoked via the hermes CLI subprocess with
        # HERMES_HOME pointed at their profile dir, otherwise the HTTP
        # gateway serves DAVI and we lose the persona (Issue 2).
        # SCOUT and WORKER are explicitly stateless: per their SOUL.md
        # ("Sin memoria. No aprendes de esta sesión") each mission
        # starts a fresh context. The hermes CLI omits --continue.
        "SCOUT":  {"harness": "hermes", "profile_path": "~/.hermes/profiles/scout",  "stateful": False},
        "WORKER": {"harness": "hermes", "profile_path": "~/.hermes/profiles/worker", "stateful": False},
        # Legal subagent with its own lexo-alpha profile (stateful:
        # LEXO accumulates context across cases).
        "LEXO":   {"harness": "hermes", "profile_path": "~/.hermes/profiles/lexo-alpha"},
        # External harnesses — no profile_path (each has its own auth/session model).
        "claude":   {"harness": "claude"},
        "codex":    {"harness": "codex"},
        "cursor":   {"harness": "cursor"},
        "openclaw": {"harness": "openclaw"},
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
    stateful: bool | None = None,
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
    if stateful is not None:
        entry["stateful"] = bool(stateful)
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
