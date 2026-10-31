"""The one module that talks to herdr.

herdr owns the agents' terminals; RepoCiv only attaches to them. It connects to
the user's default server, because a private copy would not see the agents
opened in the CLI, and it never starts, stops or reconfigures anything here.

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
import socket
import struct
import subprocess
from dataclasses import dataclass
from typing import Any, AsyncGenerator, AsyncIterator, Iterable, Mapping

from server.cli_discovery import find_herdr

MIN_VERSION = (0, 9, 1)
SOCKET_ENV = "REPOCIV_HERDR_SOCKET"
HISTORY_LINES = 2000

_REQUEST_TIMEOUT_S = 2.0
_STATUS_TIMEOUT_S = 5.0
_STOP_TIMEOUT_S = 2.0
# One NDJSON line carries a whole base64 frame; a busy, wide TUI goes well past
# asyncio's default 64 KiB limit.
_MAX_LINE_BYTES = 16 * 1024 * 1024
_VERSION_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)")
# Passed as argv to observe: must never read as an option.
TERMINAL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$")


class HerdrError(Exception):
    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code


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


def request(
    method: str,
    params: Mapping[str, Any] | None = None,
    *,
    path: str | None = None,
    timeout: float = _REQUEST_TIMEOUT_S,
) -> dict[str, Any]:
    """One socket request on its own connection."""
    buffer = bytearray()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        try:
            sock.connect(path or socket_path())
            sock.sendall(_encode(method, params))
            while b"\n" not in buffer:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                buffer.extend(chunk)
        except OSError as exc:
            raise HerdrError("unavailable", str(exc)) from exc
    return _decode(bytes(buffer).split(b"\n", 1)[0])


async def arequest(
    method: str,
    params: Mapping[str, Any] | None = None,
    *,
    path: str | None = None,
    timeout: float = _REQUEST_TIMEOUT_S,
) -> dict[str, Any]:
    """``request`` for the WebSocket event loop, which must never block."""
    try:
        async with asyncio.timeout(timeout):
            reader, writer = await asyncio.open_unix_connection(
                path or socket_path(), limit=_MAX_LINE_BYTES
            )
            try:
                writer.write(_encode(method, params))
                await writer.drain()
                line = await reader.readline()
            finally:
                writer.close()
    except (OSError, TimeoutError) as exc:
        raise HerdrError("unavailable", str(exc)) from exc
    return _decode(line)


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
    )


def list_agents(*, path: str | None = None) -> list[AgentPane]:
    rows = request("agent.list", path=path).get("agents")
    panes = (_agent_pane(row) for row in (rows if isinstance(rows, list) else []))
    return [pane for pane in panes if pane is not None]


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


async def send_text(pane_id: str, text: str, *, path: str | None = None) -> None:
    """Raw bytes to the PTY, exactly as a keyboard would send them."""
    await arequest("pane.send_text", {"pane_id": pane_id, "text": text}, path=path)


async def paste(pane_id: str, text: str, *, path: str | None = None) -> None:
    """Text as a paste. ``observe`` hides the pane's bracketed-paste mode from
    the viewer, so only the server can wrap it; sent raw, each line would submit."""
    await arequest("pane.send_input", {"pane_id": pane_id, "text": text}, path=path)


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
