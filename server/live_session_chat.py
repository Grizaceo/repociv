"""Safe transports for sending messages to live external-agent sessions."""
from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol

from server.suvadu_tracker import Observation


MAX_MESSAGE_BYTES = 120 * 1024


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
        if session.source != "suvadu" or session.agent.strip().lower() != "codex":
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


class HermesLiveChatAdapter:
    def capability(self, session: Observation) -> ChatCapability:
        return ChatCapability("unavailable", None, "hermes_not_live_bot_chat")

    def send(self, session: Observation, text: str, request_id: str) -> ChatResult:
        raise RuntimeError("transport_unavailable")


class ClaudeLiveChatAdapter:
    def capability(self, session: Observation) -> ChatCapability:
        return ChatCapability("unavailable", None, "claude_control_channel_unavailable")

    def send(self, session: Observation, text: str, request_id: str) -> ChatResult:
        raise RuntimeError("transport_unavailable")


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
    return LiveSessionChatRouter(
        {
            "codex": codex,
            "hermes": hermes,
            "claude": claude,
            "claude-code": claude,
        }
    )
