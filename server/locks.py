"""RepoCiv — keyed in-process locks.

Small utility to serialize writes to operational state files (sessions, run-state,
workspace state) without introducing external infrastructure.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from typing import Iterator


_lock_registry_guard = threading.Lock()
_lock_registry: dict[str, threading.RLock] = {}


def get_lock(key: str) -> threading.RLock:
    """Return a stable re-entrant lock for a logical key."""
    with _lock_registry_guard:
        lock = _lock_registry.get(key)
        if lock is None:
            lock = threading.RLock()
            _lock_registry[key] = lock
        return lock


@contextmanager
def hold(key: str) -> Iterator[threading.RLock]:
    """Context manager that acquires/releases a keyed lock."""
    lock = get_lock(key)
    lock.acquire()
    try:
        yield lock
    finally:
        lock.release()


def _reset() -> None:
    """Test helper: drop the lock registry."""
    with _lock_registry_guard:
        _lock_registry.clear()
