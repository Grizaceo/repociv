"""Shared executable discovery without importing agent execution or live sessions.

Candidate order is significant. Harness-specific search paths live here, while
callers retain their existing absent-binary contract
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


def find_openclaw() -> str | None:
    candidates = [
        shutil.which("openclaw"),
        str(Path.home() / ".npm-global" / "bin" / "openclaw"),
    ]
    return first_executable(candidates)


def find_codex() -> str | None:
    candidates = [
        shutil.which("codex"),
        str(Path.home() / ".npm-global" / "bin" / "codex"),
        str(Path.home() / ".local" / "bin" / "codex"),
        "/usr/local/bin/codex",
    ]
    return first_executable(candidates)


def find_opencode() -> str | None:
    candidates = [
        shutil.which(os.environ.get("REPOCIV_OPENCODE_BIN", "opencode")),
        str(Path.home() / ".local" / "bin" / "opencode"),
        str(Path.home() / ".npm-global" / "bin" / "opencode"),
        "/usr/local/bin/opencode",
    ]
    return first_executable(candidates)


def find_hermes_cli() -> str | None:
    candidates = [
        shutil.which("hermes"),
        str(Path.home() / ".local" / "bin" / "hermes"),
        "/usr/local/bin/hermes",
    ]
    return first_executable(candidates)


def find_cursor_agent() -> str | None:
    """Find the cursor-agent headless binary (NOT the cursor IDE launcher).

    Install via: curl https://cursor.com/install | bash
    Lands at ~/.local/bin/cursor-agent or ~/.cursor/bin/cursor-agent.

    Verified flags against `cursor-agent --help`:
      --print, --trust, --output-format stream-json, --model, --workspace
    """
    candidates = [
        shutil.which("cursor-agent"),
        str(Path.home() / ".local" / "bin" / "cursor-agent"),
        str(Path.home() / ".cursor" / "bin" / "cursor-agent"),
        "/usr/local/bin/cursor-agent",
    ]
    return first_executable(candidates)


def find_cursor_ide() -> str | None:
    """Find the cursor IDE launcher binary (opens the editor, not for headless use)."""
    candidates = [
        shutil.which("cursor"),
        str(Path.home() / ".local" / "bin" / "cursor"),
        "/usr/local/bin/cursor",
    ]
    return first_executable(candidates)
