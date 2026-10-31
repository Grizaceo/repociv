"""The one module that talks to herdr.

herdr owns the agents' terminals. RepoCiv attaches to them and, only on explicit
user command, creates workspaces and tabs and starts agents. It never starts or
stops the server, reconfigures it, or closes its panes.

Two channels, both local:

  * The socket API, for everything JSON. One request per connection: the server
    closes after answering, and the API is compatible between versions.
  * ``herdr terminal session observe``, for the screen. It speaks the private
    protocol, so it must run on the same binary as the server (``probe``).

``terminal session control`` is deliberately absent: it pins the PTY to its own
size until released and admits one controller. See ``docs/HERDR_LIVE_CLI.md`` for
what was measured, including the traps this module exists to avoid.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import secrets
import socket
import struct
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncGenerator, AsyncIterator, Callable, Iterable, Mapping, MutableMapping

from server.atomic_io import atomic_write_json
from server.cli_discovery import find_herdr
from server.state_paths import repociv_home

MIN_VERSION = (0, 9, 1)
SOCKET_ENV = "REPOCIV_HERDR_SOCKET"
HISTORY_LINES = 2000
LAUNCH_KINDS = frozenset({"claude", "codex", "devin", "hermes"})

_REQUEST_TIMEOUT_S = 2.0
_STATUS_TIMEOUT_S = 5.0
_STOP_TIMEOUT_S = 2.0
_SUBMIT_PAUSE_S = 0.2
_CONFIRM_TIMEOUT_S = 3.0
_CONFIRM_POLL_S = 0.1
MAX_SUBMIT_CHARS = 100_000
# One NDJSON line carries a whole base64 frame; a busy, wide TUI goes well past
# asyncio's default 64 KiB limit.
_MAX_LINE_BYTES = 16 * 1024 * 1024
_VERSION_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)")
# Passed as argv to observe: must never read as an option.
TERMINAL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$")


class HerdrError(Exception):
    def __init__(self, code: str, message: str = "", *, sent: bool = False) -> None:
        super().__init__(message or code)
        self.code = code
        self.sent = sent


def socket_path() -> str:
    """The default server's socket.

    An inherited ``HERDR_SOCKET_PATH`` is ignored on purpose: a bridge born
    inside a pane of a named session would otherwise attach to that session and
    miss the agents on the default server.
    """
    override = os.environ.get(SOCKET_ENV, "").strip()
    if override:
        return os.path.expanduser(override)
    config = os.environ.get("XDG_CONFIG_HOME", "").strip() or os.path.expanduser("~/.config")
    return os.path.join(config, "herdr", "herdr.sock")


def clean_env(path: str | None = None) -> dict[str, str]:
    """Environment for a herdr child, free of the pane this bridge may run in."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("HERDR_")}
    env["HERDR_SOCKET_PATH"] = path or socket_path()
    return env


def _encode(method: str, params: Mapping[str, Any] | None) -> bytes:
    payload = {"id": "repociv", "method": method, "params": dict(params or {})}
    return (json.dumps(payload) + "\n").encode("utf-8")


def _decode(line: bytes) -> dict[str, Any]:
    if not line.strip():
        raise HerdrError("bad_response", "empty answer")
    try:
        message = json.loads(line)
    except ValueError as exc:
        raise HerdrError("bad_response", "invalid JSON") from exc
    error = message.get("error") if isinstance(message, dict) else None
    if isinstance(error, dict):
        raise HerdrError(str(error.get("code") or "herdr_error"), str(error.get("message") or ""))
    result = message.get("result") if isinstance(message, dict) else None
    if not isinstance(result, dict):
        raise HerdrError("bad_response", "no result")
    return result


def _peer_instance(sock: Any) -> str | None:
    try:
        raw = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        pid = struct.unpack("3i", raw)[0]
        if pid <= 0:
            return None
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return f"{pid}:{int(fields[19])}"
    except (AttributeError, OSError, IndexError, ValueError, struct.error):
        return None


def request(
    method: str,
    params: Mapping[str, Any] | None = None,
    *,
    path: str | None = None,
    timeout: float = _REQUEST_TIMEOUT_S,
    instance: str | None = None,
) -> dict[str, Any]:
    """One socket request on its own connection."""
    buffer = bytearray()
    sent = False
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        try:
            sock.connect(path or socket_path())
            if instance is not None and _peer_instance(sock) != instance:
                raise HerdrError("server_changed")
            sent = True
            sock.sendall(_encode(method, params))
            while b"\n" not in buffer:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                buffer.extend(chunk)
        except OSError as exc:
            raise HerdrError("unavailable", str(exc), sent=sent) from exc
    try:
        return _decode(bytes(buffer).split(b"\n", 1)[0])
    except HerdrError as exc:
        exc.sent = sent
        raise


async def arequest(
    method: str,
    params: Mapping[str, Any] | None = None,
    *,
    path: str | None = None,
    timeout: float = _REQUEST_TIMEOUT_S,
    instance: str | None = None,
) -> dict[str, Any]:
    """``request`` for the WebSocket event loop, which must never block."""
    sent = False
    try:
        async with asyncio.timeout(timeout):
            reader, writer = await asyncio.open_unix_connection(
                path or socket_path(), limit=_MAX_LINE_BYTES
            )
            try:
                if instance is not None and _peer_instance(writer.get_extra_info("socket")) != instance:
                    raise HerdrError("server_changed")
                sent = True
                writer.write(_encode(method, params))
                await writer.drain()
                line = await reader.readline()
            finally:
                writer.close()
    except (OSError, TimeoutError) as exc:
        raise HerdrError("unavailable", str(exc), sent=sent) from exc
    try:
        return _decode(line)
    except HerdrError as exc:
        exc.sent = sent
        raise


# ─── Installation ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RuntimeStatus:
    state: str  # ready | stopped | missing | outdated | incompatible
    version: str = ""
    binary: str = ""

    def to_dict(self) -> dict[str, str]:
        return {
            "state": self.state,
            "version": self.version,
            "minVersion": ".".join(str(part) for part in MIN_VERSION),
        }


def _version_ok(version: str) -> bool:
    match = _VERSION_RE.search(version)
    return match is not None and tuple(int(part) for part in match.groups()) >= MIN_VERSION


def _server_binary(path: str) -> str | None:
    """The executable behind the socket, or None once an update replaced it."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(_REQUEST_TIMEOUT_S)
            sock.connect(path)
            raw = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        pid = struct.unpack("3i", raw)[0]
        exe = os.readlink(f"/proc/{pid}/exe")
    except OSError:
        return None
    # A replaced binary reads "/usr/bin/herdr (deleted)", which is no path at all.
    return exe if os.access(exe, os.X_OK) else None


def server_instance(path: str | None = None) -> str | None:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(_REQUEST_TIMEOUT_S)
            sock.connect(path or socket_path())
            return _peer_instance(sock)
    except OSError:
        return None


def _client_compatible(binary: str, path: str) -> bool:
    """Does this binary speak the running server's private protocol?"""
    try:
        proc = subprocess.run(
            [binary, "status", "--json"],
            capture_output=True,
            text=True,
            timeout=_STATUS_TIMEOUT_S,
            env=clean_env(path),
        )
        server = json.loads(proc.stdout).get("server")
    except (OSError, subprocess.SubprocessError, ValueError, AttributeError):
        return False
    return isinstance(server, dict) and server.get("compatible") is True


def _client_version(binary: str) -> str:
    try:
        proc = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=_STATUS_TIMEOUT_S,
            env=clean_env(),
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    match = _VERSION_RE.search(proc.stdout or "")
    return match.group(0) if match else ""


def probe(path: str | None = None) -> RuntimeStatus:
    """Is herdr installed and running, and which binary can observe it?

    The update itself is the user's call, so an outdated install is reported,
    never fixed.
    """
    path = path or socket_path()
    try:
        version = str(request("ping", path=path).get("version") or "")
    except HerdrError:
        binary = find_herdr()
        if not binary:
            return RuntimeStatus("missing")
        version = _client_version(binary)
        return RuntimeStatus("stopped" if _version_ok(version) else "outdated", version, binary)
    if not _version_ok(version):
        return RuntimeStatus("outdated", version)
    binary = _server_binary(path)
    if binary:
        return RuntimeStatus("ready", version, binary)
    binary = find_herdr()
    if binary and _client_compatible(binary, path):
        return RuntimeStatus("ready", version, binary)
    return RuntimeStatus("incompatible", version)


# ─── Agents and panes ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AgentPane:
    pane_id: str
    terminal_id: str
    agent: str
    status: str
    cwd: str = ""
    name: str = ""
    state_change_seq: int = 0
    launch_pending: bool = False

    def to_dict(self) -> dict[str, Any]:
        """What the browser gets: the folder's name, never its path."""
        return {
            "paneId": self.pane_id,
            "terminalId": self.terminal_id,
            "agent": self.agent,
            "status": self.status,
            "name": self.name,
            "folder": os.path.basename(self.cwd.rstrip("/")),
        }


def _agent_pane(row: Any) -> AgentPane | None:
    if not isinstance(row, dict):
        return None
    pane_id, terminal_id = row.get("pane_id"), row.get("terminal_id")
    if not isinstance(pane_id, str) or not isinstance(terminal_id, str):
        return None
    seq = row.get("state_change_seq")
    return AgentPane(
        pane_id=pane_id,
        terminal_id=terminal_id,
        agent=str(row.get("agent") or ""),
        status=str(row.get("agent_status") or "unknown"),
        cwd=str(row.get("cwd") or ""),
        name=str(row.get("name") or ""),
        state_change_seq=seq if isinstance(seq, int) and not isinstance(seq, bool) else 0,
        launch_pending=row.get("launch_pending") is True,
    )


def list_agents(
    *, path: str | None = None, instance: str | None = None, timeout: float | None = None,
) -> list[AgentPane]:
    kwargs = {"instance": instance} if instance is not None else {}
    if timeout is not None:
        kwargs["timeout"] = timeout
    rows = request("agent.list", path=path, **kwargs).get("agents")
    panes = (_agent_pane(row) for row in (rows if isinstance(rows, list) else []))
    return [pane for pane in panes if pane is not None]


@dataclass(frozen=True)
class LaunchResult:
    state: str
    reason: str | None = None
    terminal_id: str = ""
    pane_id: str = ""
    workspace_id: str = ""
    name: str = ""
    instance: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state, "reason": self.reason, "terminalId": self.terminal_id,
            "paneId": self.pane_id, "workspaceId": self.workspace_id, "name": self.name,
        }


def _launch_book() -> dict[str, Any]:
    try:
        value = json.loads((repociv_home() / "herdr-workspaces.json").read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _launch_name(kind: str, city: str) -> str:
    slug = re.sub(r"[^a-z0-9_-]+", "-", city.lower()).strip("-_")[:12] or "city"
    return f"{kind}-{slug}-{secrets.token_hex(2)}"


def _shell_ready(pane_id: str, path: str | None, instance: str) -> bool:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            timeout = max(0.001, min(_REQUEST_TIMEOUT_S, deadline - time.monotonic()))
            info = request(
                "pane.process_info", {"pane_id": pane_id}, path=path, instance=instance, timeout=timeout,
            ).get("process_info")
            if isinstance(info, dict):
                pid = info.get("shell_pid")
                foreground = info.get("foreground_processes")
                if isinstance(pid, int) and isinstance(foreground, list) and any(
                    isinstance(row, dict) and row.get("pid") == pid for row in foreground
                ):
                    return True
        except HerdrError as exc:
            if exc.code in {"server_changed", "unavailable"}:
                raise
            return False
        time.sleep(max(0, min(0.1, deadline - time.monotonic())))
    return False


def launch(
    kind: str, *, city_id: str, cwd: str, label: str,
    on_pane: Callable[[str, str], None] | None = None, path: str | None = None,
    timeout_ms: int = 30000, book: MutableMapping[str, Any] | None = None,
) -> LaunchResult:
    if kind not in LAUNCH_KINDS:
        return LaunchResult("failed", "invalid_kind")
    runtime = probe(path)
    if runtime.state != "ready":
        return LaunchResult("failed", f"herdr_{runtime.state}")
    instance = server_instance(path)
    if not instance:
        return LaunchResult("failed", "server_changed")
    try:
        version = request("ping", path=path, instance=instance).get("version")
    except HerdrError:
        return LaunchResult("failed", "server_changed")
    if not _version_ok(str(version or "")):
        return LaunchResult("failed", "herdr_outdated")
    persistent = book is None
    entries = _launch_book() if book is None else book
    name = _launch_name(kind, label)
    saved = entries.get(city_id)
    workspace_id = ""
    pane_id = ""
    terminal_id = ""

    def result(state: str, reason: str | None = None) -> LaunchResult:
        return LaunchResult(state, reason, terminal_id, pane_id, workspace_id, name, instance)

    def created() -> dict[str, Any]:
        nonlocal workspace_id
        value = request("workspace.create", {"cwd": cwd, "label": label, "focus": False}, path=path, instance=instance)
        workspace = value.get("workspace")
        if not isinstance(workspace, dict) or not isinstance(workspace.get("workspace_id"), str):
            raise HerdrError("bad_response")
        workspace_id = workspace["workspace_id"]
        entries[city_id] = {"server": instance, "workspaceId": workspace_id}
        if persistent:
            atomic_write_json(repociv_home() / "herdr-workspaces.json", entries, durable=True)
        return value

    try:
        if instance and isinstance(saved, dict) and saved.get("server") == instance:
            candidate = saved.get("workspaceId")
            if isinstance(candidate, str) and candidate:
                try:
                    workspace = request("workspace.get", {"workspace_id": candidate}, path=path, instance=instance).get("workspace")
                    if isinstance(workspace, dict) and workspace.get("label") == label:
                        workspace_id = candidate
                except HerdrError as exc:
                    if exc.code == "server_changed":
                        raise
        if workspace_id:
            try:
                made = request("tab.create", {"workspace_id": workspace_id, "cwd": cwd, "label": name, "focus": False}, path=path, instance=instance)
            except HerdrError as exc:
                if exc.code != "workspace_not_found":
                    raise
                made = created()
        else:
            made = created()
        root = made.get("root_pane")
        if not isinstance(root, dict) or not isinstance(root.get("pane_id"), str) or not isinstance(root.get("terminal_id"), str):
            raise HerdrError("bad_response")
        pane_id, terminal_id = root["pane_id"], root["terminal_id"]
    except (HerdrError, OSError) as exc:
        code = exc.code if isinstance(exc, HerdrError) else "workspace_store_failed"
        return result("failed", code if re.fullmatch(r"[a-z0-9_]+", code) else "herdr_error")
    if on_pane:
        on_pane(pane_id, terminal_id)
    try:
        if not _shell_ready(pane_id, path, instance):
            return result("failed", "shell_not_ready")
    except HerdrError:
        return result("failed", "server_changed")
    try:
        request("agent.start", {"name": name, "kind": kind, "pane_id": pane_id, "timeout_ms": timeout_ms},
                path=path, instance=instance, timeout=timeout_ms / 1000 + 5)
    except HerdrError as exc:
        if exc.code in {"server_changed", "unavailable"} and not exc.sent:
            return result("failed", "server_changed")
        if exc.code in {"server_changed", "unavailable", "bad_response"}:
            return result("unknown", "launch_unconfirmed")
        code = exc.code if re.fullmatch(r"[a-z0-9_]+", exc.code) else "herdr_error"
        return result("failed", code)

    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        try:
            timeout = max(0.001, min(_REQUEST_TIMEOUT_S, deadline - time.monotonic()))
            agent = next((row for row in list_agents(path=path, instance=instance, timeout=timeout)
                          if row.pane_id == pane_id), None)
        except HerdrError as exc:
            return result("unknown", "server_changed" if exc.code == "server_changed" else "launch_unconfirmed")
        if agent is None:
            return result("failed", "agent_exited")
        if agent.status == "blocked":
            return result("blocked", "agent_not_ready")
        if agent.agent == kind and not agent.launch_pending and agent.status in {"idle", "done"}:
            return result("ready")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return result("unknown", "launch_unconfirmed")
        time.sleep(min(0.25, remaining))


def _pane_pids(pane_id: str, path: str | None) -> frozenset[int]:
    info = request("pane.process_info", {"pane_id": pane_id}, path=path).get("process_info")
    rows = info.get("foreground_processes") if isinstance(info, dict) else None
    pids = (row.get("pid") for row in (rows if isinstance(rows, list) else []) if isinstance(row, dict))
    return frozenset(pid for pid in pids if isinstance(pid, int) and not isinstance(pid, bool))


def panes_for_sessions(
    owners: Mapping[str, int], *, path: str | None = None
) -> dict[str, AgentPane]:
    """Session id → its pane, given the pid that owns each session.

    Asks herdr which processes each pane holds instead of reading
    ``HERDR_PANE_ID`` from ``/proc``: that value goes stale when a pane moves, and
    it can belong to another server. A session without an owner stays unmapped,
    because an attach to the wrong agent is worse than no attach.
    """
    if not owners:
        return {}
    by_pid: dict[int, AgentPane] = {}
    try:
        for pane in list_agents(path=path):
            try:
                by_pid.update(dict.fromkeys(_pane_pids(pane.pane_id, path), pane))
            except HerdrError:
                continue  # the pane closed between the two requests
    except HerdrError:
        return {}
    return {session: by_pid[pid] for session, pid in owners.items() if pid in by_pid}


@dataclass(frozen=True)
class PaneGeometry:
    pane_id: str
    cols: int
    rows: int


async def locate(terminal_id: str, *, path: str | None = None) -> PaneGeometry:
    """Where a terminal lives now. ``pane_id`` changes when a pane moves;
    ``terminal_id`` does not."""
    panes = (await arequest("pane.list", path=path)).get("panes")
    for row in panes if isinstance(panes, list) else []:
        if isinstance(row, dict) and row.get("terminal_id") == terminal_id:
            pane_id = str(row.get("pane_id") or "")
            break
    else:
        raise HerdrError("pane_not_found", terminal_id)
    layout = (await arequest("pane.layout", {"pane_id": pane_id}, path=path)).get("layout")
    rects = layout.get("panes") if isinstance(layout, dict) else None
    for row in rects if isinstance(rects, list) else []:
        rect = row.get("rect") if isinstance(row, dict) else None
        if isinstance(rect, dict) and row.get("pane_id") == pane_id:
            cols, rows = rect.get("width"), rect.get("height")
            if isinstance(cols, int) and isinstance(rows, int) and cols > 0 and rows > 0:
                return PaneGeometry(pane_id, cols, rows)
    raise HerdrError("bad_response", "pane without a size")


async def history(pane_id: str, *, path: str | None = None) -> str:
    """Scrollback as plain text: ``format: ansi`` only returns the screen."""
    read = (
        await arequest(
            "pane.read",
            {"pane_id": pane_id, "source": "recent", "format": "text", "lines": HISTORY_LINES},
            path=path,
        )
    ).get("read")
    text = read.get("text") if isinstance(read, dict) else None
    return text if isinstance(text, str) else ""


async def send_text(pane_id: str, text: str, *, path: str | None = None, instance: str | None = None) -> None:
    """Raw bytes to the PTY, exactly as a keyboard would send them."""
    kwargs = {"instance": instance} if instance is not None else {}
    await arequest("pane.send_text", {"pane_id": pane_id, "text": text}, path=path, **kwargs)


async def paste(pane_id: str, text: str, *, path: str | None = None, instance: str | None = None) -> None:
    """Text as a paste. ``observe`` hides the pane's bracketed-paste mode from
    the viewer, so only the server can wrap it; sent raw, each line would submit."""
    kwargs = {"instance": instance} if instance is not None else {}
    await arequest("pane.send_input", {"pane_id": pane_id, "text": text}, path=path, **kwargs)


@dataclass(frozen=True)
class SubmitResult:
    state: str
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"state": self.state, "reason": self.reason}


async def submit(
    pane_id: str, text: str, *, path: str | None = None, expect_agent: str | None = None,
    instance: str | None = None,
) -> SubmitResult:
    if not text.strip():
        return SubmitResult("refused", "empty_text")
    if len(text) > MAX_SUBMIT_CHARS:
        return SubmitResult("refused", "text_too_long")

    async def agent() -> AgentPane | None:
        kwargs = {"path": path} if path is not None else {}
        if instance is not None:
            kwargs["instance"] = instance
        rows = await asyncio.to_thread(list_agents, **kwargs)
        return next((row for row in rows if row.pane_id == pane_id), None)

    try:
        before = await agent()
    except HerdrError as exc:
        return SubmitResult("failed", exc.code)
    if before is None:
        return SubmitResult("refused", "not_an_agent_pane")
    if expect_agent is not None and before.agent != expect_agent:
        return SubmitResult("refused", "agent_changed")
    if before.launch_pending:
        return SubmitResult("refused", "agent_starting")
    if before.status == "blocked":
        return SubmitResult("refused", "agent_blocked")

    kwargs = {"path": path} if path is not None else {}
    if instance is not None:
        kwargs["instance"] = instance
    try:
        await paste(pane_id, text, **kwargs)
    except HerdrError as exc:
        return SubmitResult("failed", exc.code)
    await asyncio.sleep(_SUBMIT_PAUSE_S)
    try:
        await send_text(pane_id, "\r", **kwargs)
    except HerdrError:
        return SubmitResult("unconfirmed", "enter_failed")
    if before.status == "working":
        return SubmitResult("unconfirmed", "agent_busy")

    deadline = asyncio.get_running_loop().time() + _CONFIRM_TIMEOUT_S
    while asyncio.get_running_loop().time() < deadline:
        try:
            current = await agent()
        except HerdrError:
            return SubmitResult("unconfirmed", "confirm_unavailable")
        if current is None:
            return SubmitResult("unconfirmed", "confirm_unavailable")
        if current.state_change_seq > before.state_change_seq:
            return SubmitResult("confirmed")
        await asyncio.sleep(_CONFIRM_POLL_S)
    return SubmitResult("unconfirmed", "no_state_change")


# ─── Streams ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Closed:
    reason: str


async def observe(
    terminal_id: str,
    cols: int,
    rows: int,
    *,
    binary: str,
    path: str | None = None,
) -> AsyncGenerator[bytes | Closed, None]:
    """Screen updates as ANSI bytes, ending in one ``Closed``.

    The first frame paints the whole screen. Frames carry the screen and nothing
    else: no history, and none of the PTY's modes.
    """
    if not TERMINAL_ID_RE.match(terminal_id):
        raise HerdrError("invalid_target", terminal_id)
    proc = await asyncio.create_subprocess_exec(
        binary,
        "terminal",
        "session",
        "observe",
        terminal_id,
        "--cols",
        str(cols),
        "--rows",
        str(rows),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        stdin=asyncio.subprocess.DEVNULL,
        env=clean_env(path),
        limit=_MAX_LINE_BYTES,
    )
    assert proc.stdout is not None
    try:
        while True:
            line = await proc.stdout.readline()
            if not line:
                yield Closed("observer_exited")
                return
            try:
                message = json.loads(line)
            except ValueError:
                continue
            kind = message.get("type") if isinstance(message, dict) else None
            if kind == "terminal.closed":
                yield Closed(str(message.get("reason") or "closed"))
                return
            if kind == "terminal.frame":
                try:
                    yield base64.b64decode(message.get("bytes") or "", validate=True)
                except ValueError:
                    continue
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), _STOP_TIMEOUT_S)
            except TimeoutError:
                proc.kill()
                await proc.wait()


async def status_events(pane_id: str, *, path: str | None = None) -> AsyncIterator[str]:
    """This pane's ``agent_status``, as herdr changes it."""
    async for event in subscribe([{"type": "pane.agent_status_changed", "pane_id": pane_id}], path=path):
        data = event.get("data")
        status = data.get("agent_status") if isinstance(data, dict) else None
        if isinstance(status, str):
            yield status


async def subscribe(
    subscriptions: Iterable[Mapping[str, Any]], *, path: str | None = None
) -> AsyncIterator[dict[str, Any]]:
    """Events until the server goes away. Unlike ``request``, the connection
    stays open."""
    try:
        reader, writer = await asyncio.open_unix_connection(
            path or socket_path(), limit=_MAX_LINE_BYTES
        )
    except OSError as exc:
        raise HerdrError("unavailable", str(exc)) from exc
    try:
        writer.write(_encode("events.subscribe", {"subscriptions": list(subscriptions)}))
        await writer.drain()
        if _decode(await reader.readline()).get("type") != "subscription_started":
            raise HerdrError("bad_response", "subscription refused")
        while line := await reader.readline():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict):
                yield event
    finally:
        writer.close()
