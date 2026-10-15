"""Fail-open CLI adapter. Emit allowlisted position metadata over loopback only."""
from __future__ import annotations
import json
import os
import shlex
import sys
import stat
import uuid
import urllib.parse
import urllib.request
from pathlib import Path

CONFIG = Path.home() / ".config/repociv/hooks/client.json"
MAX_INPUT = 1 << 20
_EVENTS = {"session_start", "turn_start", "tool_use", "turn_end", "session_end", "position"}
def _literal_cd(command: str) -> str | None:
    """Only the first shell clause; never scan quoted strings, code or heredocs."""
    try:
        tokens = shlex.shlex(command, posix=True, punctuation_chars=";&|")
        tokens.whitespace_split = True
        if next(tokens, "") != "cd":
            return None
        value = next(tokens, "")
        if value == "--":
            value = next(tokens, "")
        following = next(tokens, "")
        if following and following not in {";", "&&", "||", "|", "&"}:
            return None
        if value and not any(c in value for c in "$`*?{}()\n\r"):
            return value
    except ValueError:
        pass
    return None



def _codex_execution_cwd(raw):
    """Exact native completed-command correlation; never parse code or output.

    Codex normalizes exec_command to a Bash hook but drops its workdir. Its
    already-flushed CommandExecution item retains the effective cwd. Read only
    a bounded tail of this same owner's native session, matched by turn+tool ID.
    Missing/ambiguous data fails open to the existing structured-args adapter.
    """
    if raw.get("hook_event_name") != "PostToolUse" or raw.get("tool_name") != "Bash":
        return None
    native, turn, call = (raw.get(k) for k in ("session_id", "turn_id", "tool_use_id"))
    try:
        if any(not isinstance(v, str) or str(uuid.UUID(v)) != v for v in (native, turn)):
            return None
        if not isinstance(call, str) or not call.startswith("exec-") or str(uuid.UUID(call[5:])) != call[5:]:
            return None
        name = raw.get("transcript_path")
        if not isinstance(name, str) or len(name) > 4096 or not os.path.isabs(name):
            return None
        sessions = (Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "sessions").resolve(strict=True)
        path = Path(name)
        resolved = path.resolve(strict=True)
        if path != resolved or resolved.suffix != ".jsonl" or not resolved.is_relative_to(sessions):
            return None
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                return None
            head = json.loads(stream.readline(65537))
            if not isinstance(head, dict) or head.get("type") != "session_meta":
                return None
            meta = head.get("payload")
            if not isinstance(meta, dict) or meta.get("id") != native:
                return None
            offset = max(0, info.st_size - MAX_INPUT)
            stream.seek(offset)
            lines = stream.read(MAX_INPUT).splitlines()
        if offset:
            lines = lines[1:]  # may start within an old/oversized JSONL record
        matches = []
        for line in lines:
            # Skip code, prompts and outputs without interpreting their contents.
            if b'item_completed' not in line or b'CommandExecution' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict) or entry.get("type") != "event_msg":
                continue
            payload = entry.get("payload")
            if not isinstance(payload, dict) or payload.get("type") != "item_completed" or payload.get("turn_id") != turn:
                continue
            item = payload.get("item")
            if isinstance(item, dict) and item.get("type") == "CommandExecution" and item.get("id") == call:
                matches.append(item)
        if len(matches) != 1:
            return None
        item = matches[0]
        if item.get("status") != "completed" or type(item.get("exit_code")) is not int or item["exit_code"] != 0:
            return None
        location = item.get("cwd")
        if (not isinstance(location, str) or len(location) > 12288
                or any(ord(ch) < 32 for ch in location)):
            return None
        uri = urllib.parse.urlparse(location)
        if uri.scheme != "file" or uri.netloc not in ("", "localhost") or uri.query or uri.fragment:
            return None
        work = urllib.parse.unquote(uri.path, errors="strict")
        if not os.path.isabs(work) or len(work) > 4096 or any(ord(ch) < 32 for ch in work):
            return None
        return os.path.abspath(work)
    except (OSError, ValueError, TypeError):
        return None


def position_payload(cli, event, raw, *, cwd=None, profile="default"):
    """Drop prompts, results, commands and caller IDs except native session identity.

    Tool workdir/path outranks launch cwd. Do not infer locations from code bodies,
    URLs, prose, outputs or random absolute mentions inside a shell command.
    Native Codex completed-command cwd is correlated by exact session/turn/tool IDs.
    """
    if not isinstance(raw, dict) or event not in _EVENTS:
        return None
    native = raw.get("session_id") or raw.get("sessionId") or raw.get("thread-id")
    env_cwd = os.environ.get("DEVIN_PROJECT_DIR") if cli == "devin" else None
    base = raw.get("cwd") or raw.get("working_directory") or env_cwd or cwd or os.getcwd()
    if not isinstance(native, str) or not isinstance(base, str) or not os.path.isabs(base):
        return None
    args = raw.get("tool_input") or raw.get("tool_args") or {}
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            args = {}
    if not isinstance(args, dict):
        args = {}
    work = _codex_execution_cwd(raw) if cli == "codex" and event == "tool_use" else None
    if event == "tool_use" and work is None:
        for key in ("workdir", "working_directory", "cwd", "file_path", "path", "notebook_path"):
            hint = args.get(key)
            if isinstance(hint, str) and hint and len(hint) <= 4096 and "\x00" not in hint and "://" not in hint:
                work = os.path.abspath(os.path.join(base, os.path.expanduser(hint)))
                break
        if work is None:
            command = args.get("command") or args.get("cmd")
            if isinstance(command, str) and (hint := _literal_cd(command)):
                # Shell expansions would require execution: never guess or execute.
                if not any(ch in hint for ch in "$`*?{}"):
                    work = os.path.abspath(os.path.join(base, os.path.expanduser(hint)))
    payload = {"cli": cli, "event": event, "session_id": native, "cwd": work or base,
               "authority": "tool" if work else "cwd"}
    if cli == "hermes":
        payload["profile"] = raw.get("profile") or profile
    return payload


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def deliver(payload, config_path=CONFIG):
    """No proxies/redirects; private token never comes from a hook payload."""
    if not payload:
        return False
    config = json.loads(Path(config_path).read_text())
    url = config.get("url", "http://127.0.0.1:5274/api/agent-events")
    parsed = urllib.parse.urlparse(url)
    if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1", "localhost")
            or parsed.path != "/api/agent-events" or parsed.username or parsed.password
            or parsed.query or parsed.fragment):
        return False
    token = config.get("token", "")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-RepoCiv-Token"] = token
    req = urllib.request.Request(url, json.dumps(payload).encode(), headers, method="POST")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    with opener.open(req, timeout=0.4) as response:
        return response.status == 200


def main(argv=None):
    try:
        argv = argv or sys.argv[1:]
        if len(argv) != 2:
            return 0
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            return 0
        payload = position_payload(argv[0], argv[1], json.loads(raw))
        deliver(payload)
    except Exception:
        pass  # Telemetry must never break the agent or leak its inputs.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
