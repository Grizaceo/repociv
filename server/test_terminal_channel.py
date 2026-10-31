"""The terminal WebSocket, end to end over a real socket, with herdr faked."""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Awaitable, Callable

import pytest
import websockets
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve as ws_serve
from websockets.datastructures import Headers

from server import herdr_runtime, terminal_channel
from server.herdr_runtime import AgentPane, Closed, HerdrError, PaneGeometry, RuntimeStatus

TOKEN = "t" * 32
ORIGIN = "http://127.0.0.1:5273"
AGENT = AgentPane("w1:p1", "term_a", "claude", "idle", cwd="/home/someone/project")


def _refusal(*, token: str = TOKEN, bind: str = "127.0.0.1", remote: bool = False, **headers: str) -> str | None:
    pairs = [(name.replace("_", "-"), value) for name, value in headers.items()]
    return terminal_channel.refusal(
        Headers(pairs), token=token, origins={ORIGIN}, bind_host=bind, remote=remote
    )


GOOD = {"Origin": ORIGIN, "X_RepoCiv_Token": TOKEN}


def test_a_trusted_origin_with_the_token_passes() -> None:
    assert _refusal(**GOOD) is None


def test_refused_without_a_token_configured_even_from_a_trusted_browser() -> None:
    """The event socket allows this dev mode; a shell must not."""
    assert _refusal(token="", Origin=ORIGIN) == "terminal_requires_token"


def test_refused_without_an_origin_even_with_the_token() -> None:
    """The Vite proxy attaches the token for anyone, so the token proves nothing."""
    assert _refusal(X_RepoCiv_Token=TOKEN) == "origin_not_allowed"


@pytest.mark.parametrize("origin", ["https://evil.example", "http://localhost:5173", "null", "http://omarchy-1:5273"])
def test_refused_from_any_other_origin(origin: str) -> None:
    assert _refusal(Origin=origin, X_RepoCiv_Token=TOKEN) == "origin_not_allowed"


def test_refused_with_a_wrong_token() -> None:
    assert _refusal(Origin=ORIGIN, X_RepoCiv_Token="x" * 32) == "unauthorized"


@pytest.mark.parametrize("kwargs", [{"remote": True}, {"bind": "0.0.0.0"}, {"bind": "100.1.2.3"}])
def test_refused_outside_loopback(kwargs: dict[str, Any]) -> None:
    assert _refusal(**kwargs, **GOOD) == "terminal_requires_loopback"


def test_a_repeated_origin_header_is_not_trusted() -> None:
    headers = Headers([("Origin", ORIGIN), ("Origin", "https://evil.example"), ("X-RepoCiv-Token", TOKEN)])
    assert (
        terminal_channel.refusal(headers, token=TOKEN, origins={ORIGIN}, bind_host="127.0.0.1", remote=False)
        == "origin_not_allowed"
    )


def test_cors_origins_do_not_reach_the_terminal(monkeypatch: pytest.MonkeyPatch) -> None:
    import importlib

    from server import websocket_handler

    monkeypatch.setenv("REPOCIV_CORS_ORIGINS", "http://omarchy-1:5273")
    monkeypatch.setenv("REPOCIV_PORT", "5273")
    monkeypatch.delenv("REPOCIV_TERMINAL_ORIGINS", raising=False)
    reloaded = importlib.reload(websocket_handler)
    try:
        assert "http://omarchy-1:5273" in reloaded._ALLOWED_ORIGINS
        assert "http://omarchy-1:5273" not in reloaded._TERMINAL_ORIGINS
        assert ORIGIN in reloaded._TERMINAL_ORIGINS
    finally:
        monkeypatch.undo()
        importlib.reload(websocket_handler)


def test_scrollback_drops_the_painted_screen_and_anything_a_terminal_would_act_on() -> None:
    text = "old\x1b[6n\none\ntwo\nvisible1\nvisible2\n"
    assert terminal_channel._scrollback(text, 2) == "old[6n\r\none\r\ntwo"


class FakeRuntime:
    """Stands in for herdr: frames, sizes and inputs under the test's control."""

    def __init__(self) -> None:
        self.status = RuntimeStatus("ready", "0.9.1", "/bin/herdr")
        self.agents = [AGENT]
        self.geometry = PaneGeometry("w1:p1", 114, 39)
        self.hist = "old line\nvisible\n"
        self.frames: asyncio.Queue[bytes | Closed] = asyncio.Queue()
        self.opened: list[tuple[str, int, int]] = []
        self.observers_open = 0
        self.sent: list[tuple[str, str, str]] = []
        self.statuses: asyncio.Queue[str] = asyncio.Queue()
        self.subscribed: list[str] = []
        self.fail_send: list[HerdrError] = []

    async def locate(self, terminal_id: str, *, path: str | None = None) -> PaneGeometry:
        if isinstance(self.geometry, HerdrError):
            raise self.geometry
        return self.geometry

    async def history(self, pane_id: str, *, path: str | None = None) -> str:
        return self.hist

    async def observe(self, terminal_id: str, cols: int, rows: int, *, binary: str, path: str | None = None) -> Any:
        self.opened.append((terminal_id, cols, rows))
        self.observers_open += 1
        try:
            while True:
                item = await self.frames.get()
                yield item
                if isinstance(item, Closed):
                    return
        finally:
            self.observers_open -= 1

    async def status_events(self, pane_id: str, *, path: str | None = None) -> AsyncIterator[str]:
        self.subscribed.append(pane_id)
        while True:
            yield await self.statuses.get()

    def _sender(self, kind: str) -> Callable[..., Awaitable[None]]:
        async def send(pane_id: str, text: str, *, path: str | None = None) -> None:
            if self.fail_send:
                raise self.fail_send.pop()
            self.sent.append((kind, pane_id, text))

        return send

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(herdr_runtime, "probe", lambda: self.status)
        monkeypatch.setattr(herdr_runtime, "list_agents", lambda: self.agents)
        monkeypatch.setattr(herdr_runtime, "locate", self.locate)
        monkeypatch.setattr(herdr_runtime, "history", self.history)
        monkeypatch.setattr(herdr_runtime, "observe", self.observe)
        monkeypatch.setattr(herdr_runtime, "status_events", self.status_events)
        monkeypatch.setattr(herdr_runtime, "send_text", self._sender("input"))
        monkeypatch.setattr(herdr_runtime, "paste", self._sender("paste"))


@pytest.fixture
def runtime(monkeypatch: pytest.MonkeyPatch) -> FakeRuntime:
    fake = FakeRuntime()
    fake.install(monkeypatch)
    monkeypatch.setattr(terminal_channel, "_SIZE_POLL_S", 0.02)
    monkeypatch.setattr(terminal_channel, "_REOPEN_DELAY_S", 0.0)
    return fake


Client = Callable[[Any], Awaitable[None]]


def _run(session: Client, *, attach: bool = True, headers: dict[str, str] | None = None) -> None:
    async def handler(ws: Any) -> None:
        await terminal_channel.serve(ws, token=TOKEN, origins={ORIGIN}, bind_host="127.0.0.1", remote=False)

    async def go() -> None:
        async with ws_serve(handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            uri = f"ws://127.0.0.1:{port}{terminal_channel.PATH}"
            sent = headers if headers is not None else {"Origin": ORIGIN, "X-RepoCiv-Token": TOKEN}
            async with connect(uri, additional_headers=sent, compression=None) as ws:
                if attach:
                    await ws.send(json.dumps({"type": "attach", "terminalId": "term_a"}))
                await session(ws)

    asyncio.run(asyncio.wait_for(go(), 10))


async def _json(ws: Any) -> dict[str, Any]:
    return json.loads(await ws.recv())


async def _until(check: Callable[[], bool]) -> None:
    while not check():
        await asyncio.sleep(0.005)


def test_refused_connection_learns_why_and_is_closed(runtime: FakeRuntime) -> None:
    async def session(ws: Any) -> None:
        assert await _json(ws) == {"type": "refused", "reason": "origin_not_allowed"}
        with pytest.raises(websockets.exceptions.ConnectionClosed) as exc:
            await ws.recv()
        assert exc.value.rcvd.code == terminal_channel.CLOSE_REFUSED

    _run(session, attach=False, headers={"Origin": "https://evil.example", "X-RepoCiv-Token": TOKEN})
    assert runtime.opened == []


def test_attach_reports_the_terminal_and_streams_binary_frames(runtime: FakeRuntime) -> None:
    async def session(ws: Any) -> None:
        attached = await _json(ws)
        assert attached["type"] == "attached"
        assert (attached["cols"], attached["rows"]) == (114, 39)
        assert attached["agent"]["folder"] == "project"
        runtime.frames.put_nowait(b"\x1b[2Jscreen")
        assert await ws.recv() == b"\x1b[2Jscreen"

    _run(session)
    assert runtime.opened == [("term_a", 114, 39)]


@pytest.mark.parametrize(
    ("state", "reason"),
    [("missing", "herdr_missing"), ("stopped", "herdr_stopped"), ("outdated", "herdr_outdated")],
)
def test_attach_without_a_usable_herdr_says_which_problem(runtime: FakeRuntime, state: str, reason: str) -> None:
    runtime.status = RuntimeStatus(state)

    async def session(ws: Any) -> None:
        assert await _json(ws) == {"type": "refused", "reason": reason}

    _run(session)


def test_a_pane_without_an_agent_cannot_be_attached(runtime: FakeRuntime) -> None:
    runtime.agents = []

    async def session(ws: Any) -> None:
        assert await _json(ws) == {"type": "refused", "reason": "not_an_agent_pane"}

    _run(session)


def test_typing_is_not_rate_limited_and_keeps_its_order(runtime: FakeRuntime) -> None:
    """The event socket allows 60 messages a minute, one line of normal typing."""
    keys = [f"{i}\n" for i in range(200)]

    async def session(ws: Any) -> None:
        await _json(ws)
        for key in keys:
            await ws.send(json.dumps({"type": "input", "data": key}))
        await _until(lambda: len(runtime.sent) == len(keys))

    _run(session)
    assert [text for _, _, text in runtime.sent] == keys


def test_paste_and_keystrokes_take_different_paths(runtime: FakeRuntime) -> None:
    async def session(ws: Any) -> None:
        await _json(ws)
        await ws.send(json.dumps({"type": "input", "data": "\x1b"}))
        await ws.send(json.dumps({"type": "paste", "data": "a\nb"}))
        await _until(lambda: len(runtime.sent) == 2)

    _run(session)
    assert runtime.sent == [("input", "w1:p1", "\x1b"), ("paste", "w1:p1", "a\nb")]


def test_malformed_messages_are_ignored(runtime: FakeRuntime) -> None:
    async def session(ws: Any) -> None:
        await _json(ws)
        await ws.send("not json")
        await ws.send(b"\x00binary")
        await ws.send(json.dumps({"type": "input", "data": 5}))
        await ws.send(json.dumps({"type": "unknown", "data": "x"}))
        await ws.send(json.dumps({"type": "input", "data": "ok"}))
        await _until(lambda: bool(runtime.sent))

    _run(session)
    assert runtime.sent == [("input", "w1:p1", "ok")]


def test_a_resized_pty_reopens_the_stream_at_the_new_size(runtime: FakeRuntime) -> None:
    async def session(ws: Any) -> None:
        await _json(ws)
        await _until(lambda: bool(runtime.opened))
        runtime.geometry = PaneGeometry("w1:p1", 74, 29)
        assert await _json(ws) == {"type": "size", "cols": 74, "rows": 29}
        await _until(lambda: len(runtime.opened) == 2)
        runtime.frames.put_nowait(b"full frame")
        assert await ws.recv() == b"full frame"

    _run(session)
    assert runtime.opened == [("term_a", 114, 39), ("term_a", 74, 29)]


def test_input_follows_a_pane_that_moved(runtime: FakeRuntime) -> None:
    async def session(ws: Any) -> None:
        await _json(ws)
        runtime.geometry = PaneGeometry("w2:p9", 114, 39)
        runtime.fail_send.append(HerdrError("pane_not_found"))
        await ws.send(json.dumps({"type": "input", "data": "x"}))
        await _until(lambda: bool(runtime.sent))

    _run(session)
    assert runtime.sent == [("input", "w2:p9", "x")]


def test_status_follows_a_pane_that_moved(runtime: FakeRuntime) -> None:
    async def session(ws: Any) -> None:
        await _json(ws)
        await _until(lambda: runtime.subscribed == ["w1:p1"])
        runtime.geometry = PaneGeometry("w2:p9", 114, 39)
        await _until(lambda: runtime.subscribed == ["w1:p1", "w2:p9"])
        runtime.statuses.put_nowait("blocked")
        assert await _json(ws) == {"type": "status", "status": "blocked"}

    _run(session)


def test_a_failed_input_is_reported_not_swallowed(runtime: FakeRuntime) -> None:
    async def session(ws: Any) -> None:
        await _json(ws)
        runtime.fail_send.append(HerdrError("unavailable"))
        await ws.send(json.dumps({"type": "input", "data": "x"}))
        assert await _json(ws) == {"type": "error", "reason": "unavailable"}

    _run(session)


def test_closing_the_pane_tells_the_client_and_ends_the_session(runtime: FakeRuntime) -> None:
    async def session(ws: Any) -> None:
        await _json(ws)
        runtime.frames.put_nowait(b"last screen")
        await ws.recv()
        runtime.geometry = HerdrError("pane_not_found")
        runtime.frames.put_nowait(Closed("terminal exited"))
        assert await _json(ws) == {"type": "closed", "reason": "pane_not_found"}

    _run(session)
    assert runtime.observers_open == 0


def test_an_observer_dying_is_not_the_terminal_closing(runtime: FakeRuntime) -> None:
    """A bridge going down takes its observer along. Calling that "closed" would
    tell the browser the agent is gone, and it would stop reconnecting."""

    async def session(ws: Any) -> None:
        await _json(ws)
        runtime.frames.put_nowait(b"before")
        assert await ws.recv() == b"before"
        runtime.frames.put_nowait(Closed("observer_exited"))
        await _until(lambda: len(runtime.opened) == 2)
        runtime.frames.put_nowait(b"after")
        assert await ws.recv() == b"after"

    _run(session)


def test_herdr_going_away_drops_the_link_so_the_browser_retries(runtime: FakeRuntime) -> None:
    async def session(ws: Any) -> None:
        await _json(ws)
        runtime.frames.put_nowait(b"screen")
        await ws.recv()
        runtime.geometry = HerdrError("unavailable")
        runtime.frames.put_nowait(Closed("server stopped"))
        with pytest.raises(websockets.exceptions.ConnectionClosed):
            await ws.recv()

    _run(session)


def test_an_observer_that_never_streams_drops_the_link_instead_of_spinning(runtime: FakeRuntime) -> None:
    """A protocol mismatch fails at once, forever. The browser's back-off paces
    the retries, and its next attach reports what is wrong."""

    async def session(ws: Any) -> None:
        await _json(ws)
        runtime.frames.put_nowait(Closed("observer_exited"))
        with pytest.raises(websockets.exceptions.ConnectionClosed):
            await ws.recv()

    _run(session)
    assert len(runtime.opened) == 1


def test_a_browser_leaving_stops_the_observer(runtime: FakeRuntime) -> None:
    """Closing RepoCiv ends the view; the agent is not this process's to stop."""
    seen: list[int] = []

    async def handler(ws: Any) -> None:
        await terminal_channel.serve(ws, token=TOKEN, origins={ORIGIN}, bind_host="127.0.0.1", remote=False)
        seen.append(runtime.observers_open)

    async def go() -> None:
        async with ws_serve(handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            async with connect(
                f"ws://127.0.0.1:{port}{terminal_channel.PATH}",
                additional_headers={"Origin": ORIGIN, "X-RepoCiv-Token": TOKEN},
            ) as ws:
                await ws.send(json.dumps({"type": "attach", "terminalId": "term_a"}))
                await _json(ws)
                await _until(lambda: runtime.observers_open == 1)
            await _until(lambda: bool(seen))

    asyncio.run(asyncio.wait_for(go(), 10))
    assert seen == [0]


def test_wants_matches_only_the_terminal_path() -> None:
    class Request:
        def __init__(self, path: str) -> None:
            self.path = path

    class Ws:
        def __init__(self, path: str) -> None:
            self.request = Request(path)

    assert terminal_channel.wants(Ws("/terminal"))
    assert terminal_channel.wants(Ws("/terminal?x=1"))
    assert not terminal_channel.wants(Ws("/"))
    assert not terminal_channel.wants(Ws("/terminal/extra"))


def test_a_failed_size_poll_does_not_end_a_live_terminal(runtime: FakeRuntime) -> None:
    """A move can fail the poll between its two requests. Only the observer knows
    a terminal is gone: it follows the terminal, not the pane."""
    good = runtime.geometry

    async def session(ws: Any) -> None:
        await _json(ws)
        await _until(lambda: bool(runtime.opened))
        runtime.geometry = HerdrError("pane_not_found")
        await asyncio.sleep(0.1)
        runtime.geometry = good
        runtime.frames.put_nowait(b"still here")
        assert await ws.recv() == b"still here"

    _run(session)
    assert runtime.opened == [("term_a", 114, 39)]
