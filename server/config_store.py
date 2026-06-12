"""RepoCiv — Config store.

Persists user-level configuration in ~/.repociv/config.json.

PR 1 introduces the module as a stub so server/capabilities.py can import
`get_default_harness()` without a NameError. PR 2 implements the real
onboarding-driven persistence.

The JSON schema lives at ~/.repociv/config.json:
  {
    "default_harness": "hermes" | "claude" | "codex" | "cursor" | "openclaw"
  }
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

_CONFIG_DIR_ENV = "REPOCIV_CONFIG_DIR"
_CONFIG_FILENAME = "config.json"

_VALID_HARNESSES = frozenset({"hermes", "claude", "codex", "cursor", "openclaw"})


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
        import json
        return json.loads(path.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return {}


def _write_raw(data: dict[str, Any]) -> None:
    """Atomic write of the config file. Creates the directory if needed."""
    import json
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def get_default_harness() -> str | None:
    """Return the user's chosen default harness, or None if not configured.

    Returns one of: "hermes", "claude", "codex", "cursor", "openclaw".
    Returns None if the file is missing, malformed, or the value is invalid.
    """
    data = _read_raw()
    harness = data.get("default_harness")
    if not isinstance(harness, str):
        return None
    harness_lower = harness.strip().lower()
    if harness_lower not in _VALID_HARNESSES:
        return None
    return harness_lower


def set_default_harness(harness: str) -> str:
    """Persist the user's chosen default harness. Returns the normalized value.

    Raises ValueError if the harness is not in the known set.
    """
    if not isinstance(harness, str):
        raise ValueError(f"harness must be a string, got {type(harness).__name__}")
    normalized = harness.strip().lower()
    if normalized not in _VALID_HARNESSES:
        raise ValueError(
            f"Unknown harness '{harness}'. Expected one of: "
            f"{', '.join(sorted(_VALID_HARNESSES))}"
        )
    data = _read_raw()
    data["default_harness"] = normalized
    _write_raw(data)
    return normalized
