"""Safe transports for sending messages to live external-agent sessions."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol

from server import session_liveness, session_resume
from server.suvadu_tracker import Observation


MAX_MESSAGE_BYTES = 120 * 1024
_PANE_ID_RE = re.compile(r"^%[0-9]+$")


class ChatError(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class ChatCapability:
    state: str
    transport: str | None
    reason: str | None

    def to_dict(self) -> dict[str, str | None]:
        return {
            "state": self.state,
            "transport": self.transport,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class ChatResult:
    state: str
    transport: str
    request_id: str

    def to_dict(self) -> dict[str, str]:
        return {
            "state": self.state,
            "transport": self.transport,
            "requestId": self.request_id,
        }


class LiveChatAdapter(Protocol):
    def capability(self, session: Observation) -> ChatCapability: ...

    def send(self, session: Observation, text: str, request_id: str) -> ChatResult: ...


class CodexLiveChatAdapter:
    transport = "codex-queue"

    def __init__(
        self,
        *,
        codex_bin: str,
        run: Callable[..., Any] = subprocess.run,
        timeout_s: float = 10.0,
    ) -> None:
        self.codex_bin = codex_bin
        self._run = run
        self.timeout_s = timeout_s

    def capability(self, session: Observation) -> ChatCapability:
        if not self.codex_bin:
            return ChatCapability("unavailable", None, "codex_queue_unavailable")
        if session.live is not True or not session.native_id:
            return ChatCapability("unavailable", None, "codex_queue_unavailable")
        if session.source != "suvadu" or session.agent.strip().lower() not in ("codex", "openai-codex"):
            return ChatCapability("unavailable", None, "unsupported_session_source")
        return ChatCapability("available", self.transport, None)

    def send(self, session: Observation, text: str, request_id: str) -> ChatResult:
        argv = [
            self.codex_bin,
            "queue",
            f"--thread={session.native_id}",
            f"--message={text}",
        ]
        proc = None
        try:
            proc = self._run(
                argv,
                capture_output=True,
                text=True,
                timeout=self.timeout_s,
            )
        except subprocess.TimeoutExpired as exc:
            raise ChatError(504, "transport_timeout") from exc
        except (OSError, subprocess.SubprocessError) as exc:
            raise ChatError(502, "transport_failed") from exc
        if proc.returncode != 0:
            raise ChatError(502, "transport_failed")
        return ChatResult("accepted", self.transport, request_id)


@dataclass(frozen=True)
class _HermesTarget:
    transport: str
    port: int = 0
    token: str = ""
    live_session_id: str = ""
    profile: str = ""
    pane_id: str = ""


def _default_gateway_lock_dir() -> str:
    env_dir = os.environ.get("HERMES_GATEWAY_LOCK_DIR")
    if env_dir:
        return os.path.expanduser(env_dir)
    xdg = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return os.path.join(os.path.expanduser(xdg), "hermes", "gateway-locks")


def _proc_start_ticks(proc_root: str, pid: int) -> int | None:
    try:
        with open(f"{proc_root}/{pid}/stat", "r", encoding="utf-8") as fh:
            stat_line = fh.read(4096)
        fields = stat_line.rsplit(")", 1)[1].strip().split()
        if len(fields) >= 20 and fields[19].isdigit():
            return int(fields[19])
    except (OSError, IndexError, ValueError):
        return None
    return None


def _proc_ppid(proc_root: str, pid: int) -> int | None:
    try:
        with open(f"{proc_root}/{pid}/stat", "r", encoding="utf-8") as fh:
            stat_line = fh.read(4096)
        fields = stat_line.rsplit(")", 1)[1].strip().split()
        if len(fields) >= 2 and fields[1].isdigit():
            return int(fields[1])
    except (OSError, IndexError, ValueError):
        return None
    return None


def _proc_tty(proc_root: str, pid: int) -> str:
    for fd in ("0", "1", "2"):
        try:
            target = os.readlink(f"{proc_root}/{pid}/fd/{fd}")
            if target.startswith("/dev/pts/") or target.startswith("/dev/tty"):
                return target
        except OSError:
            continue
    return ""


def _proc_env_var(proc_root: str, pid: int, name: str) -> str:
    prefix = f"{name}=".encode("utf-8")
    try:
        with open(f"{proc_root}/{pid}/environ", "rb") as fh:
            raw = fh.read(128 * 1024)
    except OSError:
        return ""
    for item in raw.split(b"\0"):
        if item.startswith(prefix):
            return item[len(prefix) :].decode("utf-8", "replace").strip()
    return ""


def _ws_send_frame(sock: socket.socket, opcode: int, payload: bytes) -> None:
    mask_key = os.urandom(4)
    header = bytearray([0x80 | (opcode & 0x0F)])
    length = len(payload)
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", length))
    header.extend(mask_key)
    masked = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))
    sock.sendall(bytes(header) + masked)


def _ws_prompt_submit(
    *,
    port: int,
    token: str,
    live_session_id: str,
    profile: str,
    text: str,
    request_id: str,
    timeout_s: float,
) -> None:
    if port <= 0 or port > 65535 or not token or not live_session_id:
        raise ChatError(502, "transport_failed")
    sec_key = base64.b64encode(os.urandom(16)).decode("ascii")
    query = urllib.parse.urlencode({"token": token})
    handshake = (
        f"GET /api/ws?{query} HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        f"Origin: http://127.0.0.1:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {sec_key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    ).encode("utf-8")
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout_s) as sock:
            sock.settimeout(timeout_s)
            sock.sendall(handshake)
            resp_buf = bytearray()
            while b"\r\n\r\n" not in resp_buf:
                chunk = sock.recv(4096)
                if not chunk:
                    raise ChatError(502, "transport_failed")
                resp_buf.extend(chunk)
                if len(resp_buf) > 32768:
                    raise ChatError(502, "transport_failed")
            header_bytes, leftover = bytes(resp_buf).split(b"\r\n\r\n", 1)
            status_line = header_bytes.split(b"\r\n", 1)[0]
            if not status_line.startswith(b"HTTP/1.1 101 "):
                raise ChatError(502, "transport_failed")

            # Buffer any leftover bytes after HTTP upgrade header
            buffered = bytearray(leftover)

            def recv_exact(n: int) -> bytes:
                while len(buffered) < n:
                    chunk = sock.recv(max(4096, n - len(buffered)))
                    if not chunk:
                        raise ChatError(502, "transport_failed")
                    buffered.extend(chunk)
                out = bytes(buffered[:n])
                del buffered[:n]
                return out

            def recv_frame() -> tuple[int, bytes]:
                b0, b1 = recv_exact(2)
                op = b0 & 0x0F
                masked = bool(b1 & 0x80)
                ln = b1 & 0x7F
                if ln == 126:
                    (ln,) = struct.unpack("!H", recv_exact(2))
                elif ln == 127:
                    (ln,) = struct.unpack("!Q", recv_exact(8))
                if ln > 4 * 1024 * 1024:
                    raise ChatError(502, "transport_failed")
                mkey = recv_exact(4) if masked else b""
                data = recv_exact(ln) if ln else b""
                if masked:
                    data = bytes(b ^ mkey[i & 3] for i, b in enumerate(data))
                return op, data

            params: dict[str, Any] = {
                "session_id": live_session_id,
                "text": text,
                "queued": True,
            }
            if profile and profile != "default":
                params["profile"] = profile
            rpc_payload = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "prompt.submit",
                    "params": params,
                },
                ensure_ascii=False,
            ).encode("utf-8")

            sent = False
            for _ in range(64):
                opcode, raw_frame = recv_frame()
                if opcode == 0x8:
                    raise ChatError(502, "transport_failed")
                if opcode == 0x9:
                    _ws_send_frame(sock, 0xA, raw_frame)
                    continue
                if opcode != 0x1:
                    continue
                for line in raw_frame.decode("utf-8", "replace").splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(msg, dict):
                        continue
                    if not sent:
                        _ws_send_frame(sock, 0x1, rpc_payload)
                        sent = True
                    if msg.get("id") == request_id:
                        try:
                            _ws_send_frame(sock, 0x8, b"")
                        except OSError:
                            pass
                        err = msg.get("error")
                        if isinstance(err, dict):
                            code = err.get("code")
                            if code in (4001, 4007):
                                raise ChatError(409, "session_not_live")
                            raise ChatError(502, "transport_failed")
                        if isinstance(msg.get("result"), dict):
                            return
                        raise ChatError(502, "transport_failed")
            raise ChatError(504, "transport_timeout")
    except ChatError:
        raise
    except TimeoutError as exc:
        raise ChatError(504, "transport_timeout") from exc
    except OSError as exc:
        raise ChatError(502, "transport_failed") from exc


class HermesLiveChatAdapter:
    """Adopts existing live Hermes sessions over tui_gateway (/api/ws) or tmux."""

    def __init__(
        self,
        *,
        hermes_home: str | None = None,
        lock_dir: str | None = None,
        proc_root: str = session_liveness.PROC_ROOT,
        tmux_bin: str | None = None,
        run: Callable[..., Any] = subprocess.run,
        ws_send: Callable[..., None] = _ws_prompt_submit,
        timeout_s: float = 10.0,
    ) -> None:
        self.hermes_home = os.path.expanduser(
            hermes_home or os.environ.get("REPOCIV_HERMES_HOME") or "~/.hermes"
        )
        self.lock_dir = os.path.expanduser(lock_dir or _default_gateway_lock_dir())
        self.proc_root = proc_root
        self.tmux_bin = (
            tmux_bin
            if tmux_bin is not None
            else (shutil.which(os.environ.get("TMUX_BIN", "tmux")) or "")
        )
        self._run = run
        self._ws_send = ws_send
        self.timeout_s = timeout_s

    def _is_live_hermes_pid(self, pid: int) -> bool:
        cmd = session_liveness._cmdline(self.proc_root, str(pid))
        return bool(cmd and session_liveness._HERMES_RE.search(cmd))

    def _lease_files_for(self, profile: str) -> list[str]:
        prof_home = session_resume.hermes_profile_home(self.hermes_home, profile)
        primary = os.path.join(prof_home, "runtime", "active_sessions.json")
        root = os.path.join(self.hermes_home, "runtime", "active_sessions.json")
        return [primary] if primary == root else [primary, root]

    def _find_lease_entry(self, session: Observation) -> dict[str, Any] | None:
        candidates = {
            cid for cid in (session.native_id, *session.related_native_ids) if isinstance(cid, str) and cid
        }
        if not candidates:
            return None
        for path in self._lease_files_for(session.profile):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except (OSError, ValueError):
                continue
            entries = data.get("entries") if isinstance(data, dict) else None
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                pid = entry.get("pid")
                if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
                    continue
                meta = entry.get("metadata")
                live_id = meta.get("live_session_id") if isinstance(meta, dict) else None
                sid = entry.get("session_id")
                if sid not in candidates and live_id not in candidates:
                    continue
                if not self._is_live_hermes_pid(pid):
                    continue
                return entry
        return None

    def _resolve_serve_endpoint(self, pid: int) -> tuple[int, str] | None:
        for role in ("desktop-serve", "serve"):
            rec_path = os.path.join(self.lock_dir, f"host-{role}.json")
            tok_path = os.path.join(self.lock_dir, f"host-{role}.token")
            try:
                with open(rec_path, "r", encoding="utf-8-sig") as fh:
                    rec = json.load(fh)
                with open(tok_path, "r", encoding="utf-8-sig") as fh:
                    token = fh.read().strip()
            except (OSError, ValueError):
                continue
            if not isinstance(rec, dict) or rec.get("pid") != pid or not token:
                continue
            port = rec.get("port")
            if isinstance(port, bool) or not isinstance(port, int) or not (0 < port <= 65535):
                continue
            rec_start = rec.get("startTime")
            if isinstance(rec_start, int) and not isinstance(rec_start, bool) and rec_start > 0:
                actual_start = _proc_start_ticks(self.proc_root, pid)
                if actual_start is not None and actual_start != rec_start:
                    continue
            fp = str(rec.get("tokenFingerprint") or "")
            if fp:
                actual_fp = hashlib.sha256(token.encode("utf-8", "replace")).hexdigest()[:16]
                if actual_fp != fp:
                    continue
            return port, token

        ledger_path = os.path.join(self.hermes_home, "spawn-ledger.json")
        try:
            with open(ledger_path, "r", encoding="utf-8-sig") as fh:
                ledger = json.load(fh)
        except (OSError, ValueError):
            ledger = None
        if isinstance(ledger, list):
            for entry in ledger:
                if not isinstance(entry, dict) or entry.get("pid") != pid:
                    continue
                if entry.get("purpose") not in ("serve", "dashboard"):
                    continue
                port = entry.get("port")
                if isinstance(port, bool) or not isinstance(port, int) or not (0 < port <= 65535):
                    continue
                token = _proc_env_var(self.proc_root, pid, "HERMES_DASHBOARD_SESSION_TOKEN")
                if token:
                    return port, token
        return None

    def _resolve_tmux_pane(self, pid: int) -> str | None:
        if not self.tmux_bin:
            return None
        try:
            proc = self._run(
                [self.tmux_bin, "list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}\t#{pane_tty}"],
                capture_output=True,
                text=True,
                timeout=2.0,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if proc.returncode != 0 or not proc.stdout:
            return None
        panes_by_tty: dict[str, str] = {}
        panes_by_pid: dict[int, str] = {}
        for line in proc.stdout.splitlines():
            parts = line.strip().split("\t")
            if len(parts) < 2:
                continue
            pane_id, pane_pid_s = parts[0].strip(), parts[1].strip()
            pane_tty = parts[2].strip() if len(parts) >= 3 else ""
            if not _PANE_ID_RE.match(pane_id):
                continue
            if pane_pid_s.isdigit():
                panes_by_pid[int(pane_pid_s)] = pane_id
            if pane_tty:
                panes_by_tty[pane_tty] = pane_id
        tty = _proc_tty(self.proc_root, pid)
        if tty and tty in panes_by_tty:
            return panes_by_tty[tty]
        cur: int | None = pid
        for _ in range(16):
            if cur is None or cur <= 1:
                break
            if cur in panes_by_pid:
                return panes_by_pid[cur]
            cur = _proc_ppid(self.proc_root, cur)
        return None

    def _resolve_target(self, session: Observation) -> _HermesTarget | None:
        entry = self._find_lease_entry(session)
        if entry is None:
            return None
        pid = int(entry["pid"])
        meta = entry.get("metadata")
        live_sid = str(meta.get("live_session_id") or "").strip() if isinstance(meta, dict) else ""
        surface = str(entry.get("surface") or "").strip().lower()
        if live_sid and surface in ("desktop", "tui"):
            serve_ep = self._resolve_serve_endpoint(pid)
            if serve_ep is not None:
                port, token = serve_ep
                return _HermesTarget(
                    transport="hermes-serve-ws",
                    port=port,
                    token=token,
                    live_session_id=live_sid,
                    profile=session.profile,
                )
        pane_id = self._resolve_tmux_pane(pid)
        if pane_id:
            return _HermesTarget(transport="hermes-tmux", pane_id=pane_id)
        return None

    def capability(self, session: Observation) -> ChatCapability:
        if session.source != "hermes" or session.agent.strip().lower() != "hermes":
            return ChatCapability("unavailable", None, "unsupported_session_source")
        if session.live is not True or not session.native_id:
            return ChatCapability("unavailable", None, "hermes_not_live_bot_chat")
        target = self._resolve_target(session)
        if target is None:
            return ChatCapability("unavailable", None, "hermes_not_live_bot_chat")
        return ChatCapability("available", target.transport, None)

    def send(self, session: Observation, text: str, request_id: str) -> ChatResult:
        target = self._resolve_target(session)
        if target is None:
            raise ChatError(501, "transport_unavailable")
        if target.transport == "hermes-serve-ws":
            self._ws_send(
                port=target.port,
                token=target.token,
                live_session_id=target.live_session_id,
                profile=target.profile,
                text=text,
                request_id=request_id,
                timeout_s=self.timeout_s,
            )
            return ChatResult("accepted", target.transport, request_id)
        if target.transport == "hermes-tmux":
            if "\x00" in text:
                raise ChatError(422, "empty_message")
            # Hermes CLI's prompt_toolkit treats an Enter arriving <50ms after the
            # last text change as a paste newline (_RAPID_INPUT_ENTER_WINDOW_S).
            for idx, argv in enumerate(
                (
                    [self.tmux_bin, "send-keys", "-t", target.pane_id, "-l", "--", text],
                    [self.tmux_bin, "send-keys", "-t", target.pane_id, "Enter"],
                )
            ):
                if idx == 1:
                    time.sleep(0.08)
                try:
                    proc = self._run(
                        argv,
                        capture_output=True,
                        text=True,
                        timeout=self.timeout_s,
                    )
                except subprocess.TimeoutExpired as exc:
                    raise ChatError(504, "transport_timeout") from exc
                except (OSError, subprocess.SubprocessError) as exc:
                    raise ChatError(502, "transport_failed") from exc
                if proc.returncode != 0:
                    raise ChatError(502, "transport_failed")
            return ChatResult("accepted", target.transport, request_id)
        raise ChatError(501, "transport_unavailable")


class ClaudeLiveChatAdapter:
    """The process-owned channel: only sessions RepoCiv spawned are addressable.

    A Claude session Suvadu merely observed (the user's own terminal run) has
    no stdin to write to: it stays observable and *not* addressable — the
    honest answer, never a silent fallback to ``--resume`` (Fase 5).
    """

    transport = "claude-stream-json"

    def __init__(self, *, manager: Any | None = None) -> None:
        self._manager = manager

    def _resolve(self) -> Any:
        """The live manager (injectable for tests); resolved lazily to avoid a cycle."""
        if self._manager is not None:
            return self._manager
        from server import claude_live  # noqa: PLC0415

        return claude_live.get_manager()

    def capability(self, session: Observation) -> ChatCapability:
        if session.source != "claude-live":
            return ChatCapability("unavailable", None, "claude_control_channel_unavailable")
        if session.live is not True or not session.native_id:
            return ChatCapability("unavailable", None, "claude_live_not_running")
        return ChatCapability("available", self.transport, None)

    def send(self, session: Observation, text: str, request_id: str) -> ChatResult:
        from server.claude_live import ClaudeLiveError  # noqa: PLC0415

        try:
            self._resolve().send(session.native_id, text)
        except ClaudeLiveError as exc:
            raise ChatError(exc.status, exc.code) from exc
        return ChatResult("accepted", self.transport, request_id)


class DevinLiveChatAdapter:
    def capability(self, session: Observation) -> ChatCapability:
        return ChatCapability("unavailable", None, "devin_live_chat_unavailable")

    def send(self, session: Observation, text: str, request_id: str) -> ChatResult:
        raise ChatError(501, "transport_unavailable")


class MCodeLiveChatAdapter:
    def capability(self, session: Observation) -> ChatCapability:
        return ChatCapability("unavailable", None, "mcode_live_chat_unavailable")

    def send(self, session: Observation, text: str, request_id: str) -> ChatResult:
        raise ChatError(501, "transport_unavailable")


class LiveSessionChatRouter:
    def __init__(self, adapters: Mapping[str, LiveChatAdapter]) -> None:
        self._adapters = {name.strip().lower(): adapter for name, adapter in adapters.items()}

    def capability(self, session: Observation) -> ChatCapability:
        adapter = self._adapters.get(session.agent.strip().lower())
        if adapter is None:
            return ChatCapability("unavailable", None, "unsupported_session_source")
        return adapter.capability(session)

    def send(self, session: Observation, text: str, request_id: str) -> ChatResult:
        if session.live is not True:
            raise ChatError(409, "session_not_live")
        if not isinstance(text, str) or not text.strip():
            raise ChatError(422, "empty_message")
        if len(text.encode("utf-8")) > MAX_MESSAGE_BYTES:
            raise ChatError(413, "message_too_large")
        capability = self.capability(session)
        if capability.state != "available":
            raise ChatError(501, "transport_unavailable")
        adapter = self._adapters.get(session.agent.strip().lower())
        if adapter is None:
            raise ChatError(501, "transport_unavailable")
        return adapter.send(session, text, request_id)


def default_router() -> LiveSessionChatRouter:
    codex = CodexLiveChatAdapter(codex_bin=shutil.which(os.environ.get("CODEX_BIN", "codex")) or "")
    hermes = HermesLiveChatAdapter()
    claude = ClaudeLiveChatAdapter()
    devin = DevinLiveChatAdapter()
    mcode = MCodeLiveChatAdapter()
    return LiveSessionChatRouter(
        {
            "codex": codex,
            "openai-codex": codex,
            "hermes": hermes,
            "claude": claude,
            "claude-code": claude,
            "devin": devin,
            "mcode": mcode,
        }
    )
