"""RepoCiv — crash-safe file replacement for local stores.

``Path.write_text`` truncates first and writes second: a crash in between
leaves an empty or half-written store, and the loaders treat corrupt JSON as
"no data" (an empty queue, no missions). These helpers write a sibling temp
file and ``os.replace`` it into place, so readers see the old or the new
content, never a mix.

``durable=True`` also fsyncs the data and the directory entry, for low-churn
stores where losing the last write to a power cut matters (scheduler queue,
mission history). High-frequency counters skip it.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

__all__ = ["atomic_write_json", "atomic_write_text"]

_DEFAULT_MODE = 0o600  # new state files are private to the operator


def atomic_write_text(
    path: Path | str, content: str, *, durable: bool = False, mode: int | None = None,
) -> None:
    """Replace ``path`` with ``content`` atomically.

    Keeps the existing file's permission bits unless ``mode`` is given; a new
    file defaults to 0600.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if mode is None:
        try:
            mode = target.stat().st_mode & 0o777
        except FileNotFoundError:
            mode = _DEFAULT_MODE
    fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            if durable:
                stream.flush()
                os.fsync(stream.fileno())
        os.chmod(tmp_name, mode)
        os.replace(tmp_name, target)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise
    if durable:
        dir_fd = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


def atomic_write_json(
    path: Path | str, data: Any, *, durable: bool = False, mode: int | None = None,
    **dumps_kwargs: Any,
) -> None:
    """``json.dumps(data, **dumps_kwargs)`` written via :func:`atomic_write_text`."""
    atomic_write_text(path, json.dumps(data, **dumps_kwargs), durable=durable, mode=mode)
