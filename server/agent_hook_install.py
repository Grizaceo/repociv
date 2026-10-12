"""Ownership-scoped installer for default-profile CLI position hooks.

No core edits, no automatic Codex trust bypass, no other Hermes profiles.
The installer backs up existing files privately and supports selective removal.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import shlex
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

CLI_EVENTS = {
    "SessionStart": "session_start", "UserPromptSubmit": "turn_start",
    "PostToolUse": "tool_use", "PostToolUseFailure": "tool_use",
    "Stop": "turn_end", "SessionEnd": "session_end",
}
# Hermes on_session_end fires at the end of each TURN, not CLI shutdown.
HERMES_EVENTS = {
    "on_session_start": "session_start", "post_tool_call": "tool_use",
    "on_session_end": "turn_end", "on_session_finalize": "session_end",
}


def commands(repo: Path, python: str) -> dict[str, dict[str, str]]:
    prefix = f"{shlex.quote(python)} {shlex.quote(str(repo / 'server/agent_hook_client.py'))}"
    return {cli: {event: f"{prefix} {cli} {mapped}" for event, mapped in events.items()}
            for cli, events in (("claude", CLI_EVENTS), ("codex", {k: v for k, v in CLI_EVENTS.items() if k != "PostToolUseFailure"}),
                                ("hermes", HERMES_EVENTS))}


def _same_hook(candidate: str, command: str) -> bool:
    """Match only this exact script/CLI/event, independent of interpreter path.

    Keep the first existing command byte-for-byte so Codex/Hermes consent and
    foreign clones are not rewritten. Never use a broad substring match.
    """
    if candidate == command:
        return True
    try:
        left, right = shlex.split(candidate), shlex.split(command)
    except (ValueError, TypeError):
        return False
    return len(left) == len(right) == 4 and left[1:] == right[1:]


def merge_json_hooks(data: dict, specs: dict[str, str], *, remove=False) -> dict:
    out = copy.deepcopy(data)
    hooks = out.setdefault("hooks", {})
    for event, command in specs.items():
        groups = hooks.setdefault(event, [])
        cleaned, found = [], False
        for group in groups:
            kept = []
            for entry in group.get("hooks", []):
                if _same_hook(entry.get("command", ""), command):
                    if remove or found:
                        continue
                    found = True
                kept.append(entry)
            if kept or not group.get("hooks", []):
                g = copy.deepcopy(group)
                g["hooks"] = kept
                cleaned.append(g)
        if not remove and not found:
            group = {"hooks": [{"type": "command", "command": command, "timeout": 2}]}
            if event.startswith("PostTool"):
                group["matcher"] = ".*"
            cleaned.append(group)
        if cleaned:
            hooks[event] = cleaned
        else:
            hooks.pop(event, None)
    return out


def merge_yaml_hooks(text: str, specs: dict[str, str], *, remove=False) -> str:
    """Rewrite only the hooks node; preserve unrelated YAML bytes and secrets."""
    data = yaml.safe_load(text) or {}
    hooks = copy.deepcopy(data.get("hooks", {}))
    for event, command in specs.items():
        entries = hooks.setdefault(event, [])
        kept, found = [], False
        for entry in entries:
            if _same_hook(entry.get("command", ""), command):
                if remove or found:
                    continue
                found = True
            kept.append(entry)
        if not remove and not found:
            kept.append({"command": command, "timeout": 2})
        if kept:
            hooks[event] = kept
        else:
            hooks.pop(event, None)
    if hooks == data.get("hooks", {}):
        return text
    replacement = yaml.safe_dump({"hooks": hooks}, sort_keys=False, allow_unicode=True)
    node = yaml.compose(text)
    if not data:
        return replacement
    if node is not None and node.flow_style:
        raise ValueError("flow-style config must be converted to block YAML before adding hooks")
    if node is not None:
        for key, value in node.value:
            if key.value == "hooks":
                return text[:key.start_mark.index] + replacement + text[value.end_mark.index:]
    return text.rstrip() + "\n\n" + replacement


def private_write(path: Path, content: str, mode=0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".repociv-new")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w") as stream:
        stream.write(content)
    tmp.replace(path)


def install(home: Path, repo: Path, python: str, *, remove=False) -> dict:
    specs = commands(repo, python)
    targets = [(home / ".claude/settings.json", "claude"),
               (home / ".codex/hooks.json", "codex"),
               (home / ".hermes/config.yaml", "hermes")]
    updates = []
    for path, cli in targets:
        if not path.exists():
            continue  # do not invent installations or touch other profiles
        before = path.read_text()
        after = (merge_yaml_hooks(before, specs[cli], remove=remove) if cli == "hermes" else
                 json.dumps(merge_json_hooks(json.loads(before), specs[cli], remove=remove), indent=2) + "\n")
        if after != before:
            updates.append((path, before, after))
    backup = home / ".config/repociv/hooks/backups" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    if updates:
        backup.mkdir(parents=True, mode=0o700)
        for index, (path, before, after) in enumerate(updates):
            private_write(backup / f"{index}-{path.parent.name}-{path.name}", before)
            private_write(path, after, mode=path.stat().st_mode & 0o777)
    return {"changed": [str(p) for p, _, _ in updates], "backup": str(backup) if updates else None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "remove"))
    args = parser.parse_args(argv)
    home = Path.home()
    repo = Path(__file__).resolve().parent.parent
    if args.action == "install":
        # Token comes only from the private environment, never a CLI argument.
        token = os.environ.get("REPOCIV_TOKEN", "")
        if not token:
            parser.error("REPOCIV_TOKEN must be supplied privately in the environment")
        path = home / ".config/repociv/hooks/client.json"
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        private_write(path, json.dumps({"url": "http://127.0.0.1:5274/api/agent-events", "token": token}) + "\n")
    result = install(home, repo, sys.executable, remove=args.action == "remove")
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
