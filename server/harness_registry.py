"""RepoCiv — Harness Registry Loader.

Loads shared/harness-registry.json and exposes narrow helpers for the backend.
Validated at runtime; raises ValueError for malformed entries.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

# ─── Path resolution ────────────────────────────────────────────────────────────

_REGISTRY_PATH = Path(__file__).parent.parent / "shared" / "harness-registry.json"

_TRUST_LEVELS: set[str] = {
    "reference_only", "read_only", "local_cli", "sandboxed", "privileged_external"
}
_KINDS: set[str] = {"reference", "agent_runtime", "sandbox", "local_cli", "bridge"}
_TRANSPORTS: set[str] = {"none", "cli", "http", "plugin", "sandbox"}
_HEALTH_KINDS: set[str] = {"static", "command", "http"}
_RECOVERY_MODES: set[str] = {"copy_command", "tmux_attach", "view_logs", "no_recovery_available"}

# ─── Schema version keys (snake_case / camelCase tolerance) ───────────────────

_SNAKE_MAP = {"trust_level": "trustLevel", "recovery_modes": "recoveryModes",
              "allowed_actions": "allowedActions", "blocked_actions": "blockedActions"}


def _normalize(raw: dict[str, Any]) -> dict[str, Any]:
    """Tolerate both snake_case and camelCase JSON keys."""
    out = dict(raw)
    for snake, camel in _SNAKE_MAP.items():
        if snake in out and camel not in out:
            out[camel] = out.pop(snake)
    return out


# ─── Validation ───────────────────────────────────────────────────────────────

class ValidationError(ValueError):
    pass


def _assert_string(val: Any, field: str, harness_id: str) -> str:
    if not isinstance(val, str):
        raise ValidationError(
            f"Harness '{harness_id}': '{field}' must be str, got {type(val).__name__}"
        )
    return val


def _assert_str_list(val: Any, field: str, harness_id: str) -> list[str]:
    if not isinstance(val, list) or not all(isinstance(v, str) for v in val):
        raise ValidationError(
            f"Harness '{harness_id}': '{field}' must be list[str], got {type(val).__name__}"
        )
    return val


def _validate_entry(raw: dict[str, Any]) -> dict[str, Any]:
    entry = _normalize(raw)
    harness_id = entry.get("id", "<unknown>")

    trust_level = _assert_string(entry.get("trustLevel"), "trustLevel", harness_id)
    if trust_level not in _TRUST_LEVELS:
        raise ValidationError(
            f"Harness '{harness_id}': unknown trustLevel '{trust_level}'"
        )

    kind = _assert_string(entry.get("kind"), "kind", harness_id)
    if kind not in _KINDS:
        raise ValidationError(f"Harness '{harness_id}': unknown kind '{kind}'")

    transport = _assert_string(entry.get("transport"), "transport", harness_id)
    if transport not in _TRANSPORTS:
        raise ValidationError(f"Harness '{harness_id}': unknown transport '{transport}'")

    health = entry.get("health")
    if not isinstance(health, dict):
        raise ValidationError(f"Harness '{harness_id}': 'health' must be an object")
    health_kind = _assert_string(health.get("kind"), "health.kind", harness_id)
    if health_kind not in _HEALTH_KINDS:
        raise ValidationError(
            f"Harness '{harness_id}': unknown health.kind '{health_kind}'"
        )

    recovery_modes_raw = entry.get("recoveryModes", [])
    recovery_modes = _assert_str_list(recovery_modes_raw, "recoveryModes", harness_id)
    for m in recovery_modes:
        if m not in _RECOVERY_MODES:
            raise ValidationError(
                f"Harness '{harness_id}': unknown recoveryMode '{m}'"
            )

    _assert_str_list(entry.get("allowedActions", []), "allowedActions", harness_id)
    _assert_str_list(entry.get("blockedActions", []), "blockedActions", harness_id)

    return entry


# ─── Cached load ──────────────────────────────────────────────────────────────

_cache: list[dict[str, Any]] | None = None


def _load() -> list[dict[str, Any]]:
    global _cache
    if _cache is not None:
        return _cache

    path = _REGISTRY_PATH
    if not path.exists():
        raise FileNotFoundError(
            f"Harness registry not found at {path}. "
            "Create shared/harness-registry.json first."
        )

    with path.open() as fh:
        raw = json.load(fh)

    if not isinstance(raw, dict) or "harnesses" not in raw:
        raise ValidationError("Registry must be a dict with a 'harnesses' key")

    harnesses = raw["harnesses"]
    if not isinstance(harnesses, list):
        raise ValidationError("'harnesses' must be a list")

    _cache = [_validate_entry(e) for e in harnesses]
    return _cache


def _reset_cache() -> None:
    global _cache
    _cache = None


# ─── Public API ───────────────────────────────────────────────────────────────

def list_harnesses() -> list[dict[str, Any]]:
    """Return all registered harness descriptors."""
    return list(_load())


def get_harness(harness_id: str) -> dict[str, Any] | None:
    """Return a single harness by id, or None if not found."""
    for h in _load():
        if h.get("id") == harness_id:
            return h
    return None


def infer_harness_for_command(cmd_type: str) -> dict[str, Any] | None:
    """
    Return the preferred harness for a given command type string.

    Strategy: among harnesses where cmd_type is in allowedActions and not in
    blockedActions, pick the highest-trust non-reference harness. Within the
    same trust level prefer more capable transports.
    """
    candidates = [
        h for h in _load()
        if cmd_type in h.get("allowedActions", [])
        and cmd_type not in h.get("blockedActions", [])
    ]
    if not candidates:
        return None

    # Filter out reference_only unless nothing better exists
    non_ref = [h for h in candidates if h.get("trustLevel") != "reference_only"]
    pool = non_ref if non_ref else candidates

    pref = ["privileged_external", "local_cli", "sandboxed", "read_only", "reference_only"]
    pool.sort(key=lambda h: pref.index(h.get("trustLevel", "")))
    return pool[0] if pool else None
