"""Shared executable discovery without importing agent execution or live sessions.

Candidate order is significant. Harness-specific lists stay with their callers,
except Claude's shared list. Callers retain their existing absent-binary contract
(``None`` in agent_runner, an empty string in claude_live).
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Iterable


def first_executable(candidates: Iterable[str | None]) -> str | None:
    """Return the first candidate path that exists and is executable, else None.

    ``None``/empty entries are skipped so callers can feed the output of
    ``shutil.which`` directly into the list.
    """
    for candidate in candidates:
        if candidate and Path(candidate).exists() and os.access(candidate, os.X_OK):
            return candidate
    return None


def claude_candidates() -> list[str | None]:
    """Ordered candidates for the Claude Code CLI, shared by runner + live chat."""
    return [
        shutil.which("claude"),
        str(Path.home() / ".npm-global" / "bin" / "claude"),
        str(Path.home() / ".local" / "bin" / "claude"),
    ]


def find_claude() -> str | None:
    """First executable Claude Code CLI, or ``None`` when absent."""
    return first_executable(claude_candidates())
