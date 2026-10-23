"""Read-only local agent process inventory; never return argv/environment.

Includes recognized agent entrypoints and their complete descendant trees for
this UID. This is an OS snapshot, NOT evidence that an agent is working.
Unrelated daemons (gpg-agent, bt-agent) are deliberately excluded.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

_ENTRYPOINTS = {
    "hermes": "Hermes", "hermes-agent": "Hermes", "hermes_cli": "Hermes",
    "hermes-desktop": "Hermes", "run_agent.py": "Hermes",
    "claude": "Claude Code", "codex": "Codex", "openclaw": "OpenClaw",
    "opencode": "OpenCode",
    "cursor-agent": "Cursor", "aider": "Aider",
}


def _family(argv: list[str], comm: str) -> str | None:
    # Only executable/entrypoint tokens; never inspect prompts or shell -c code.
    if comm in _ENTRYPOINTS:
        return _ENTRYPOINTS[comm]
    if not argv:
        return None
    first = Path(argv[0]).name
    if first in _ENTRYPOINTS:
        return _ENTRYPOINTS[first]
    if first.startswith(("python", "node")):
        tokens = argv[1:3] if len(argv) > 1 and argv[1] == "-m" else argv[1:2]
        for token in tokens:
            name = Path(token).name
            if name in _ENTRYPOINTS:
                return _ENTRYPOINTS[name]
            if name == "cli.js" and any(x in token for x in ("@anthropic-ai/claude-code/", "@openai/codex/")):
                return "Claude Code" if "claude-code" in token else "Codex"
    return None


def process_identity(pid: int, proc_root: Path = Path("/proc")) -> str | None:
    """Boot + PID + kernel start ticks; PID alone is never historical identity."""
    try:
        boot = (proc_root / "sys/kernel/random/boot_id").read_text().strip()
        stat = (proc_root / str(pid) / "stat").read_text()
        ticks = stat[stat.rindex(")") + 2:].split()[19]
        return f"{boot}:{pid}:{ticks}" if boot and ":" not in boot and ticks.isdigit() else None
    except (OSError, ValueError, IndexError):
        return None


def record_process_binding(pid: int, command_id: str, unit_id: str) -> None:
    """Persist explicit owner evidence only, with no argv/env/output."""
    if not isinstance(pid, int) or pid <= 0:
        return
    identity = process_identity(pid)
    if identity is not None:
        from server import event_store
        try:
            event_store.record_event("ProcessBound", {
                "commandId": command_id, "agentId": unit_id,
                "pid": pid, "processIdentity": identity,
            }, command_id=command_id)
        except OSError:
            # Optional correlation must never abort an agent execution.
            import logging
            logging.getLogger(__name__).warning("Process binding unavailable")


def snapshot(proc_root: Path = Path("/proc"), uid: int | None = None) -> dict[str, Any]:
    uid = os.getuid() if uid is None else uid
    table: dict[int, dict[str, Any]] = {}
    unreadable = 0
    try:
        boot = (proc_root / "sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        boot = ""
    try:
        entries = list(proc_root.iterdir())
    except OSError:
        return {"available": False, "processes": [], "scope": "local-uid", "unreadable": 0}
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            if entry.stat().st_uid != uid:
                continue
            stat = (entry / "stat").read_text()
            start, end = stat.index("("), stat.rindex(")")
            comm = stat[start + 1:end]
            fields = stat[end + 2:].split()
            argv = (entry / "cmdline").read_bytes().decode("utf-8", errors="replace").strip("\0").split("\0")
            pid = int(entry.name)
            table[pid] = {"pid": pid, "ppid": int(fields[1]), "name": comm,
                          "state": fields[0], "family": _family(argv, comm),
                          "processIdentity": f"{boot}:{pid}:{fields[19]}" if boot and len(fields) > 19 and fields[19].isdigit() else None}
        except (OSError, ValueError, IndexError):
            unreadable += 1  # Includes exit races; never imply a complete machine census.
    related = {pid: row["family"] for pid, row in table.items() if row["family"]}
    roots = {pid: pid for pid in related}
    changed = True
    while changed:
        changed = False
        for pid, row in table.items():
            if pid not in related and row["ppid"] in related:
                related[pid] = related[row["ppid"]]
                roots[pid] = roots[row["ppid"]]
                changed = True
    rows = [{**table[pid], "family": family, "rootPid": roots[pid],
             "role": "agent" if table[pid]["family"] else "descendant"}
            for pid, family in sorted(related.items())]
    return {"available": True, "processes": rows, "scope": "local-uid", "unreadable": unreadable}


def get_agent_processes(_ctx: dict) -> tuple[int, dict]:
    return 200, snapshot()
