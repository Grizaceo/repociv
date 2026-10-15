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
FIVE_EVENTS = {k: v for k, v in CLI_EVENTS.items() if k != "PostToolUseFailure"}
# Hermes on_session_end fires at the end of each TURN, not CLI shutdown.
HERMES_EVENTS = {
    "on_session_start": "session_start", "post_tool_call": "tool_use",
    "on_session_end": "turn_end", "on_session_finalize": "session_end",
}
MCODE_PLUGIN_MANIFEST = (
    json.dumps(
        {
            "name": "repociv-hooks",
            "version": "1.0.0",
            "description": "RepoCiv position hooks",
        },
        indent=2,
    )
    + "\n"
)

# The whole file is ours, so removal may delete it: the marker is what proves
# ownership, never the path alone.
OPENCODE_PLUGIN_MARKER = "repociv-hooks: managed by RepoCiv"


def opencode_plugin_js(repo: Path, python: str) -> str:
    """The opencode v2 global plugin: native hooks -> agent_hook_client.py.

    Opencode discovers ``~/.config/opencode/plugins/*.js`` by itself (no
    config edit), and the client keeps the single validated/private delivery
    path shared with the other CLIs. Only session id, cwd and the concrete
    tool path/command leave the hook; prompts and results never do.
    """
    config = json.dumps({"python": python, "client": str(repo / "server/agent_hook_client.py")})
    return f"""// {OPENCODE_PLUGIN_MARKER} — server/agent_hook_install.py
// Remove safely with: python -m server.agent_hook_install remove
import {{ spawn }} from "node:child_process";

const REPOCIV = {config};
const seenSessions = new Set();
const sessionDirs = new Map();

function emit(event, payload) {{
  try {{
    const child = spawn(REPOCIV.python, [REPOCIV.client, "opencode", event], {{
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    }});
    child.on("error", () => {{}});
    if (child.stdin) {{
      child.stdin.on("error", () => {{}});
      child.stdin.end(JSON.stringify(payload));
    }}
    child.unref();
  }} catch {{
    // Telemetry must never break the agent.
  }}
}}

function toolInput(input) {{
  if (!input || typeof input !== "object") return undefined;
  const picked = {{}};
  for (const key of ["filePath", "file_path", "path", "workdir", "command"]) {{
    const value = input[key];
    if (typeof value === "string" && value) picked[key] = value;
  }}
  return Object.keys(picked).length ? picked : undefined;
}}

function directoryOf(value) {{
  const dir = value && value.location && value.location.directory;
  return typeof dir === "string" ? dir : "";
}}

export default {{
  id: "repociv-hooks",
  async setup(ctx) {{
    const fallbackDir = directoryOf(ctx);

    function emitFor(sessionID, event, extra) {{
      if (typeof sessionID !== "string" || !sessionID) return;
      const cwd = sessionDirs.get(sessionID) || fallbackDir;
      if (!cwd) return;
      emit(event, {{ session_id: sessionID, cwd, ...(extra || {{}}) }});
    }}

    try {{
      ctx.session.hook("prompt", (event) => {{
        const sessionID = event && event.sessionID;
        if (typeof sessionID !== "string" || !sessionID) return;
        if (fallbackDir) sessionDirs.set(sessionID, fallbackDir);
        if (!seenSessions.has(sessionID)) {{
          seenSessions.add(sessionID);
          emitFor(sessionID, "session_start");
        }}
        emitFor(sessionID, "turn_start");
      }});
    }} catch {{}}

    try {{
      ctx.tool.hook("execute.before", (event) => {{
        const sessionID = event && event.sessionID;
        if (typeof sessionID !== "string" || !sessionID) return;
        const picked = toolInput(event.input);
        emitFor(sessionID, "tool_use", picked ? {{ tool_input: picked }} : undefined);
      }});
    }} catch {{}}

    try {{
      const controller = new AbortController();
      void (async () => {{
        try {{
          for await (const event of ctx.event.subscribe({{ signal: controller.signal }})) {{
            const type = event && event.type;
            const data = event && event.data;
            const sessionID = data && data.sessionID;
            if (typeof sessionID !== "string" || !sessionID) continue;
            const dir = directoryOf(event);
            if (dir) sessionDirs.set(sessionID, dir);
            if (type === "session.execution.succeeded" || type === "session.execution.failed") {{
              emitFor(sessionID, "turn_end");
            }} else if (type === "session.deleted") {{
              emitFor(sessionID, "session_end");
              sessionDirs.delete(sessionID);
              seenSessions.delete(sessionID);
            }}
          }}
        }} catch {{}}
      }})();
      return () => controller.abort();
    }} catch {{
      return undefined;
    }}
  }},
}};
"""


def commands(repo: Path, python: str) -> dict[str, dict[str, str]]:
    prefix = f"{shlex.quote(python)} {shlex.quote(str(repo / 'server/agent_hook_client.py'))}"
    return {
        cli: {event: f"{prefix} {cli} {mapped}" for event, mapped in events.items()}
        for cli, events in (
            ("claude", CLI_EVENTS),
            ("codex", FIVE_EVENTS),
            ("hermes", HERMES_EVENTS),
            ("devin", FIVE_EVENTS),
            ("mcode", FIVE_EVENTS),
        )
    }


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
    targets = [
        (home / ".claude/settings.json", "claude"),
        (home / ".codex/hooks.json", "codex"),
        (home / ".hermes/config.yaml", "hermes"),
        (home / ".config/devin/config.json", "devin"),
    ]
    updates: list[tuple[Path, str | None, str | None, int]] = []
    for path, cli in targets:
        if not path.exists():
            continue  # do not invent installations or touch other profiles
        before = path.read_text()
        after = (
            merge_yaml_hooks(before, specs[cli], remove=remove)
            if cli == "hermes"
            else json.dumps(merge_json_hooks(json.loads(before), specs[cli], remove=remove), indent=2) + "\n"
        )
        if after != before:
            updates.append((path, before, after, path.stat().st_mode & 0o777))

    minimax_dir = home / ".minimax"
    if minimax_dir.is_dir():
        plugin_root = minimax_dir / "plugins" / "repociv-hooks"
        manifest_path = plugin_root / ".claude-plugin" / "plugin.json"
        hooks_path = plugin_root / "hooks" / "hooks.json"
        if not remove:
            before_m = manifest_path.read_text() if manifest_path.exists() else None
            if before_m != MCODE_PLUGIN_MANIFEST:
                mode_m = (manifest_path.stat().st_mode & 0o777) if manifest_path.exists() else 0o600
                updates.append((manifest_path, before_m, MCODE_PLUGIN_MANIFEST, mode_m))
            before_h = hooks_path.read_text() if hooks_path.exists() else None
            base_h = json.loads(before_h) if before_h else {}
            after_h = json.dumps(merge_json_hooks(base_h, specs["mcode"], remove=False), indent=2) + "\n"
            if after_h != before_h:
                mode_h = (hooks_path.stat().st_mode & 0o777) if hooks_path.exists() else 0o600
                updates.append((hooks_path, before_h, after_h, mode_h))
        elif hooks_path.exists():
            before_h = hooks_path.read_text()
            merged_h = merge_json_hooks(json.loads(before_h), specs["mcode"], remove=True)
            if merged_h.get("hooks"):
                after_h = json.dumps(merged_h, indent=2) + "\n"
                if after_h != before_h:
                    updates.append((hooks_path, before_h, after_h, hooks_path.stat().st_mode & 0o777))
            else:
                updates.append((hooks_path, before_h, None, 0o600))
                if manifest_path.exists():
                    before_m = manifest_path.read_text()
                    if before_m == MCODE_PLUGIN_MANIFEST:
                        updates.append((manifest_path, before_m, None, 0o600))

    opencode_dir = home / ".config/opencode"
    opencode_plugin_path = opencode_dir / "plugins" / "repociv-hooks.js"
    if not remove:
        if opencode_dir.is_dir():
            before_p = opencode_plugin_path.read_text() if opencode_plugin_path.exists() else None
            after_p = opencode_plugin_js(repo, python)
            if after_p != before_p:
                mode_p = (
                    opencode_plugin_path.stat().st_mode & 0o777
                    if opencode_plugin_path.exists()
                    else 0o600
                )
                updates.append((opencode_plugin_path, before_p, after_p, mode_p))
    elif opencode_plugin_path.exists():
        before_p = opencode_plugin_path.read_text()
        if OPENCODE_PLUGIN_MARKER in before_p:
            updates.append((opencode_plugin_path, before_p, None, 0o600))

    backup = home / ".config/repociv/hooks/backups" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    if updates:
        backup.mkdir(parents=True, mode=0o700)
        for index, (path, before, after, mode) in enumerate(updates):
            if before is not None:
                private_write(backup / f"{index}-{path.parent.name}-{path.name}", before)
            if after is not None:
                private_write(path, after, mode=mode)
            else:
                path.unlink(missing_ok=True)
                for d in (path.parent, path.parent.parent):
                    try:
                        d.rmdir()
                    except OSError:
                        break
    return {"changed": [str(p) for p, _, _, _ in updates], "backup": str(backup) if updates else None}


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
