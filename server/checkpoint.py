"""RepoCiv — D1: Task Checkpoint persistence.

Saves/loads/deletes the state of a running task to disk so it can be
resumed after a process restart.

Storage layout:
  <store_dir>/<repo>/<issue_id>.json

Resolution order for the store directory (first hit wins):
  1. Explicit ``init(store_dir)`` call from the bootstrapper.
  2. ``REPOCIV_DATA_DIR`` env var (preferred for tests/CI).
  3. ``REPOCIV_CONFIG_DIR`` env var (already used by bridge).
  4. ``~/.repociv/checkpoints`` (production default).

Writes are atomic: data is written to a tmp file in the same directory and
then renamed, so a partial write never corrupts an existing checkpoint.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def _resolve_default_dir() -> Path:
    """Resolve the checkpoints directory from env or fall back to ~/.repociv."""
    data_dir = os.environ.get("REPOCIV_DATA_DIR")
    if data_dir:
        return Path(os.path.expanduser(data_dir)) / "checkpoints"
    config_dir = os.environ.get("REPOCIV_CONFIG_DIR")
    if config_dir:
        return Path(os.path.expanduser(config_dir)) / "checkpoints"
    return Path(os.path.expanduser("~/.repociv")) / "checkpoints"


# Module-level state. Kept as a module attribute so legacy tests using
# ``patch.object(cp, "_CHECKPOINTS_DIR", ...)`` keep working.
_CHECKPOINTS_DIR: Path = _resolve_default_dir()


def init(store_dir: Path | str) -> None:
    """Override the checkpoints directory at runtime.

    ``store_dir`` is treated as the *parent* (analogous to
    ``workspace_issue.init``); the actual checkpoints live under
    ``store_dir/checkpoints``. Idempotent.
    """
    global _CHECKPOINTS_DIR
    _CHECKPOINTS_DIR = Path(os.path.expanduser(str(store_dir))) / "checkpoints"


def _reset() -> None:
    """Test helper: re-resolve the directory from env (or fall back to default)."""
    global _CHECKPOINTS_DIR
    _CHECKPOINTS_DIR = _resolve_default_dir()


def _checkpoint_path(repo: str, issue_id: str) -> Path:
    return _CHECKPOINTS_DIR / repo / f"{issue_id}.json"


def save_checkpoint(repo: str, issue_id: str, state: dict[str, Any]) -> None:
    """Atomically persist *state* for the given task."""
    path = _checkpoint_path(repo, issue_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(state, ensure_ascii=False, indent=2).encode("utf-8")
    tmp_fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        os.write(tmp_fd, data)
        os.close(tmp_fd)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.close(tmp_fd)
        except Exception:
            pass
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        raise


def load_checkpoint(repo: str, issue_id: str) -> dict[str, Any] | None:
    """Return saved checkpoint dict, or *None* if it does not exist."""
    path = _checkpoint_path(repo, issue_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def delete_checkpoint(repo: str, issue_id: str) -> None:
    """Delete checkpoint if it exists. Silently ignores missing files."""
    path = _checkpoint_path(repo, issue_id)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
