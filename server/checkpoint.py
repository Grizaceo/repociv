"""RepoCiv — D1: Task Checkpoint persistence.

Saves/loads/deletes the state of a running task to disk so it can be
resumed after a process restart.

Storage layout:
  ~/.repociv/checkpoints/<repo>/<issue_id>.json

Writes are atomic: data is written to a tmp file in the same directory and
then renamed, so a partial write never corrupts an existing checkpoint.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

_CHECKPOINTS_DIR: Path = Path(os.path.expanduser("~/.repociv")) / "checkpoints"


def _checkpoint_path(repo: str, issue_id: str) -> Path:
    return _CHECKPOINTS_DIR / repo / f"{issue_id}.json"


def save_checkpoint(repo: str, issue_id: str, state: dict[str, Any]) -> None:
    """Atomically persist *state* for the given task."""
    path = _checkpoint_path(repo, issue_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(state, ensure_ascii=False, indent=2).encode("utf-8")
    # Atomic write: write to tmp file in same dir then rename
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
