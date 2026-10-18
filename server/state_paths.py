"""RepoCiv — single resolver for the local state root.

Every persistent store (events, approvals, ledgers, security logs, wonders,
profiles…) lives under one directory. Before this module each store resolved
it on its own — some honored ``REPOCIV_CONFIG_DIR``, some ``REPOCIV_DATA_DIR``
or ``REPOCIV_STATE_DIR``, and roughly fifteen hardcoded ``~/.repociv`` — so a
test run that redirected one variable still wrote into the operator's live
security log and token ledger.

Resolution: ``REPOCIV_CONFIG_DIR`` when set (``~`` expanded), otherwise
``~/.repociv`` resolved through ``$HOME``.

Store-specific overrides (``REPOCIV_DATA_DIR`` for checkpoints,
``REPOCIV_STATE_DIR`` for ledgers, ``REPOCIV_WONDERS_DIR``…) keep working;
they now fall back to this root instead of a hardcoded home path.
"""

from __future__ import annotations

import os
from pathlib import Path

__all__ = ["ROOT_ENV", "repociv_home", "state_path"]

ROOT_ENV = "REPOCIV_CONFIG_DIR"


def _env_path(name: str) -> Path | None:
    value = os.environ.get(name, "").strip()
    return Path(os.path.expanduser(value)) if value else None


def repociv_home() -> Path:
    """Return the RepoCiv state root (not created)."""
    return _env_path(ROOT_ENV) or Path.home() / ".repociv"


def state_path(*parts: str, override_env: str | None = None) -> Path:
    """Return ``<override or repociv_home()>/<parts…>``.

    ``override_env`` names a store-specific variable that, when set, replaces
    the root (e.g. ``REPOCIV_STATE_DIR`` for the ledgers).
    """
    root = _env_path(override_env) if override_env else None
    return (root or repociv_home()).joinpath(*parts)
