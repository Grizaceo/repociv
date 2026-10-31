"""A herdr pane over WebSocket: the agent's real terminal, in the browser.

This endpoint is a shell on the user's machine, so it does not share the event
socket's rules. That socket accepts a tokenless dev mode and a client without an
Origin; here both are refused. Behind the Vite proxy the token is attached for
every client, which leaves the Origin as the check that actually separates the
dashboard from another page in the same browser.

Everything herdr-specific lives in ``server/herdr_runtime.py``.

Protocol. Server → client: binary messages are ANSI screen bytes, text messages
are JSON (``attached``, ``size``, ``status``, ``error``, ``closed``, ``refused``,
``submit_result``). Client → server: ``attach`` once, then ``input`` (keystrokes),
``paste`` or ``submit``. Attach can disable screen and history with ``screen: false``.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import re
from typing import Any, Iterable

import websockets

from server import herdr_runtime
from server._security import _is_loopback_bind
from server.herdr_runtime import AgentPane, Closed, HerdrError, PaneGeometry

logger = logging.getLogger("repociv.terminal")

PATH = "/terminal"
CLOSE_REFUSED = 4003

_HELLO_TIMEOUT_S = 5.0
# No event fires when a PTY changes size, so an open terminal has to ask.
_SIZE_POLL_S = 1.0
_REOPEN_DELAY_S = 0.5
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def wants(ws: Any) -> bool:
    request = getattr(ws, "request", None)
    path = getattr(request, "path", "") or ""
    return path.split("?", 1)[0] == PATH


def _single_header(headers: Any, name: str) -> str:
    """The header's value, or "" when absent or sent twice."""
    values = headers.get_all(name)
    return values[0] if len(values) == 1 else ""


def refusal(
    headers: Any,
    *,
    token: str,
    origins: Iterable[str],
    bind_host: str,
    remote: bool,
) -> str | None:
    """Why this connection may not open a terminal, or None when it may."""
    if remote or not _is_loopback_bind(bind_host):
        return "terminal_requires_loopback"
    if not token:
        return "terminal_requires_token"
    if _single_header(headers, "Origin") not in set(origins):
        return "origin_not_allowed"
    candidate = _single_header(headers, "X-RepoCiv-Token")
    if not hmac.compare_digest(candidate.encode("utf-8"), token.encode("utf-8")):
        return "unauthorized"
    return None


def _scrollback(text: str, rows: int) -> str:
    """History without the screen the first frame paints, and without anything
    a terminal would act on: xterm answers some sequences, and its answers would
    land in the agent's stdin."""
    lines = [_CONTROL_CHARS_RE.sub("", line) for line in text.splitlines()]
    return "\r\n".join(lines[:-rows] if rows else lines)


class _Session:
    def __init__(self, ws: Any, agent: AgentPane, binary: str, screen: bool = True) -> None:
        self.ws = ws
        self.agent = agent
        self.binary = binary
        self.terminal_id = agent.terminal_id
        self.pane_id = agent.pane_id
        self._status_task: asyncio.Task[None] | None = None
        self._streamed = False
        self.screen = screen

    async def _control(self, message: dict[str, Any]) -> None:
        await self.ws.send(json.dumps(message))

    async def run(self) -> None:
        geometry = await herdr_runtime.locate(self.terminal_id)
        self.pane_id = geometry.pane_id
        history = await herdr_runtime.history(self.pane_id) if self.screen else ""
        await self._control(
            {
                "type": "attached",
                "agent": self.agent.to_dict(),
                "cols": geometry.cols,
                "rows": geometry.rows,
                "history": _scrollback(history, geometry.rows),
            }
        )
        self._restart_status()
        screen = asyncio.create_task(self._pump_screen(geometry))
        client = asyncio.create_task(self._read_client())
        try:
            await asyncio.wait({screen, client}, return_when=asyncio.FIRST_COMPLETED)
            if screen.done() and not screen.cancelled() and screen.exception() is None:
                await self._control({"type": "closed", "reason": screen.result()})
        finally:
            tasks = [task for task in (screen, client, self._status_task) if task is not None]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    def _restart_status(self) -> None:
        if self._status_task is not None:
            self._status_task.cancel()
        self._status_task = asyncio.create_task(self._pump_status(self.pane_id))

    async def _pump_status(self, pane_id: str) -> None:
        try:
            async for status in herdr_runtime.status_events(pane_id):
                await self._control({"type": "status", "status": status})
        except HerdrError:
            pass  # the screen stream reports a dead server

    async def _pump_screen(self, geometry: PaneGeometry) -> str:
        """Stream at the PTY's real size, reopening when it changes: a smaller
        viewer would clip the screen. Returns why the terminal is gone.

        A stream ending proves nothing by itself: a bridge going down takes its
        observer along, and "closed" tells the browser to stop reconnecting. Only
        herdr can say the terminal is gone; anything else raises, which drops the
        connection and leaves the pacing to the browser's back-off.
        """
        while True:
            self._streamed = False
            resized = await self._stream_at(geometry.cols, geometry.rows)
            if resized is None:
                if not self._streamed:
                    raise HerdrError("observer_failed")
                await asyncio.sleep(_REOPEN_DELAY_S)
                try:
                    resized = await herdr_runtime.locate(self.terminal_id)
                except HerdrError as exc:
                    if exc.code == "pane_not_found":
                        return exc.code
                    raise
            if (resized.cols, resized.rows) != (geometry.cols, geometry.rows):
                await self._control({"type": "size", "cols": resized.cols, "rows": resized.rows})
            geometry = resized

    async def _stream_at(self, cols: int, rows: int) -> PaneGeometry | None:
        """Forward frames until the PTY changes size, which returns the new
        geometry, or until the observer ends, which returns None."""
        forward = asyncio.create_task(self._forward(cols, rows))
        try:
            while True:
                done, _ = await asyncio.wait({forward}, timeout=_SIZE_POLL_S)
                if done:
                    forward.result()
                    return None
                try:
                    geometry = await herdr_runtime.locate(self.terminal_id)
                except HerdrError:
                    # A move can fail this between its two requests. The observer
                    # follows the terminal, so its ending is what gets checked.
                    continue
                if geometry.pane_id != self.pane_id:
                    self.pane_id = geometry.pane_id
                    self._restart_status()
                if (geometry.cols, geometry.rows) != (cols, rows):
                    return geometry
        finally:
            forward.cancel()
            await asyncio.gather(forward, return_exceptions=True)

    async def _forward(self, cols: int, rows: int) -> None:
        stream = herdr_runtime.observe(self.terminal_id, cols, rows, binary=self.binary)
        try:
            async for item in stream:
                if isinstance(item, Closed):
                    return
                self._streamed = True
                if self.screen:
                    await self.ws.send(item)
        finally:
            await stream.aclose()

    async def _read_client(self) -> None:
        async for message in self.ws:
            if not isinstance(message, str):
                continue
            try:
                data = json.loads(message)
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            if (
                data.get("type") == "submit"
                and isinstance(data.get("id"), str)
                and len(data["id"]) <= 64
                and isinstance(data.get("text"), str)
            ):
                await self._submit(data["id"], data["text"])
            elif isinstance(data.get("data"), str):
                await self._deliver(data.get("type"), data["data"])

    async def _submit(self, request_id: str, text: str) -> None:
        try:
            pane_id = (await herdr_runtime.locate(self.terminal_id)).pane_id
            result = await herdr_runtime.submit(pane_id, text, expect_agent=self.agent.agent)
        except HerdrError as exc:
            result = herdr_runtime.SubmitResult("failed", exc.code)
        await self._control({"type": "submit_result", "id": request_id, **result.to_dict()})

    async def _deliver(self, kind: Any, text: str) -> None:
        send = {"input": herdr_runtime.send_text, "paste": herdr_runtime.paste}.get(kind)
        if send is None:
            return
        try:
            try:
                await send(self.pane_id, text)
            except HerdrError as exc:
                if exc.code != "pane_not_found":
                    raise
                # Never delivered, so resending is safe: the pane moved.
                self.pane_id = (await herdr_runtime.locate(self.terminal_id)).pane_id
                await send(self.pane_id, text)
        except HerdrError as exc:
            await self._control({"type": "error", "reason": exc.code})


async def _refuse(ws: Any, reason: str) -> None:
    await ws.send(json.dumps({"type": "refused", "reason": reason}))
    await ws.close(CLOSE_REFUSED, reason)


async def _agent_for(terminal_id: Any) -> AgentPane | None:
    if not isinstance(terminal_id, str) or not herdr_runtime.TERMINAL_ID_RE.match(terminal_id):
        return None
    agents = await asyncio.to_thread(herdr_runtime.list_agents)
    return next((agent for agent in agents if agent.terminal_id == terminal_id), None)


async def serve(
    ws: Any,
    *,
    token: str,
    origins: Iterable[str],
    bind_host: str,
    remote: bool,
) -> None:
    """One browser attached to one pane, until either side goes away.

    Agents outlive this: closing it stops the observer and nothing else.
    """
    reason = refusal(ws.request.headers, token=token, origins=origins, bind_host=bind_host, remote=remote)
    if reason:
        logger.warning("terminal refused: %s", reason)
        await _refuse(ws, reason)
        return
    try:
        raw = await asyncio.wait_for(ws.recv(), _HELLO_TIMEOUT_S)
        hello = json.loads(raw)
    except (TimeoutError, ValueError):
        await _refuse(ws, "attach_expected")
        return
    except websockets.exceptions.ConnectionClosed:
        return
    if not isinstance(hello, dict) or hello.get("type") != "attach":
        await _refuse(ws, "attach_expected")
        return
    status = await asyncio.to_thread(herdr_runtime.probe)
    if status.state != "ready":
        await _refuse(ws, f"herdr_{status.state}")
        return
    try:
        # Panes with an agent only: this is a window on agents, not on every
        # shell the user keeps open.
        agent = await _agent_for(hello.get("terminalId"))
        if agent is None:
            await _refuse(ws, "not_an_agent_pane")
            return
        await _Session(ws, agent, status.binary, screen=hello.get("screen") is not False).run()
    except HerdrError as exc:
        await _refuse(ws, exc.code)
    except websockets.exceptions.ConnectionClosed:
        pass
