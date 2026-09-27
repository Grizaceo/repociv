"""Folders a Claude Code / Codex session works in, read from its native transcript.

Suvadu only knows where a session was launched (``cwd``): an agent started from
~ sits at the capital however long it works in a repo. Its own transcript names
the folders:

  * Claude Code — the shell ``cwd`` it logs on every line (it follows ``cd``),
    the ``file_path``/``path`` of its file tools and the absolute paths in its
    Bash commands;
  * Codex — the ``workdir`` of its commands, the absolute paths in them and the
    ``*** Add/Update/Delete File:`` headers of its patches.

Only the newest ``_MAX_CALLS`` tool calls count, newest first, one entry per
mention. File contents, patch bodies, tool outputs and prompts are never read
for paths, and nothing but the folders leaves this module — the tracker turns
them into a repo (``suvadu_tracker.work_place`` / ``busiest``) and only that
repo is ever sent anywhere. Best effort: an unreadable or odd transcript gives
no folders and the session cwd decides.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Iterable, Iterator

_TAIL_BYTES = 2 << 20  # newest part of the transcript read
_MAX_CALLS = 60  # newest tool calls read, like hermes_sessions._WORK_ROWS
# An absolute (or ~) path inside a command: after a space, `=`, `:`, a quote or `(`.
_ABS_PATH_RE = re.compile(r"""(?<![^\s=:"'(])((?:~|/)[^\s"'`;&|()<>\\]*)""")
# `workdir:"…"` or `"workdir":"…"` — Codex has written its tool options both ways.
_WORKDIR_RE = re.compile(r"""\b(?:workdir|working_directory|cwd)["']?\s*:\s*["'`]([^"'`\\]+)""")
_CMD_RE = re.compile(r'\bcmd["\']?\s*:\s*"((?:[^"\\]|\\.)*)"')
_PATCH_FILE_RE = re.compile(r"\*\*\* (?:Add|Update|Delete) File: ((?:~|/)[^\\\n\"]+)")
_CLAUDE_PATH_KEYS = ("file_path", "path", "notebook_path")
_CODEX_PATH_KEYS = ("workdir", "working_directory", "cwd", "path")


def dirs_from_hints(hints: Iterable[str]) -> tuple[str, ...]:
    """Absolute hints → existing folders (a file stands for its folder), in order."""
    dirs: list[str] = []
    for hint in hints:
        if not hint.startswith(("/", "~")):
            continue
        path = os.path.abspath(os.path.expanduser(hint))
        if not os.path.isdir(path):
            path = os.path.dirname(path)
        if path and os.path.isdir(path):
            dirs.append(path)
    return tuple(dirs)


def _command_paths(command: Any) -> list[str]:
    if isinstance(command, list):
        command = " ".join(part for part in command if isinstance(part, str))
    return _ABS_PATH_RE.findall(command) if isinstance(command, str) else []


def _claude_calls(entry: dict[str, Any]) -> Iterator[list[str]]:
    """Hints per tool call of one assistant line, newest first."""
    message = entry.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if entry.get("type") != "assistant" or not isinstance(content, list):
        return
    cwd = entry.get("cwd")
    for item in reversed(content):
        if not isinstance(item, dict) or item.get("type") != "tool_use":
            continue
        args = item.get("input") if isinstance(item.get("input"), dict) else {}
        hints = [v for k in _CLAUDE_PATH_KEYS if isinstance(v := args.get(k), str)]
        hints += _command_paths(args.get("command"))
        if isinstance(cwd, str):
            hints.append(cwd)
        yield hints


def _codex_calls(entry: dict[str, Any]) -> Iterator[list[str]]:
    """Hints of one rollout line's tool call (outputs are other lines)."""
    payload = entry.get("payload")
    kind = payload.get("type") if isinstance(payload, dict) else None
    if kind == "custom_tool_call":  # `exec` (JS calling tools.*) or a bare `apply_patch`
        code = payload.get("input")
        if not isinstance(code, str):
            return
        hints = _PATCH_FILE_RE.findall(code) + _WORKDIR_RE.findall(code)
        for cmd in _CMD_RE.findall(code):
            hints += _command_paths(cmd)
        yield hints
    elif kind == "function_call":  # shell / exec_command
        try:
            args = json.loads(payload.get("arguments") or "{}")
        except (TypeError, ValueError):
            return
        if isinstance(args, dict):
            hints = [v for k in _CODEX_PATH_KEYS if isinstance(v := args.get(k), str)]
            yield hints + _command_paths(args.get("command") or args.get("cmd"))
    elif kind == "local_shell_call":
        action = payload.get("action") if isinstance(payload.get("action"), dict) else {}
        hints = [v] if isinstance(v := action.get("working_directory"), str) else []
        yield hints + _command_paths(action.get("command"))


_PARSERS = {
    "claude-code": (_claude_calls, '"tool_use"'),
    "claude": (_claude_calls, '"tool_use"'),
    "codex": (_codex_calls, '_call"'),
    "openai-codex": (_codex_calls, '_call"'),
}


def _tail_lines(path: str) -> list[str]:
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        fh.seek(max(0, size - _TAIL_BYTES))
        data = fh.read()
    lines = data.decode("utf-8", errors="replace").splitlines()
    return lines[1:] if size > _TAIL_BYTES else lines  # the first one may be cut


def transcript_work_dirs(agent: str, path: str) -> tuple[str, ...]:
    """Folders the newest tool calls of this transcript touched, newest first."""
    parser = _PARSERS.get(agent.lower())
    if parser is None:
        return ()
    calls_of, marker = parser
    try:
        lines = _tail_lines(path)
    except OSError:
        return ()
    hints: list[str] = []
    calls = 0
    for line in reversed(lines):
        if marker not in line:  # cheap skip: tool outputs, usage, reasoning…
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        for call in calls_of(entry):
            hints.extend(call)
            calls += 1
            if calls >= _MAX_CALLS:
                return dirs_from_hints(hints)
    return dirs_from_hints(hints)
