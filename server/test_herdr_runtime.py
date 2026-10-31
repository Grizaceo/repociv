"""herdr_runtime against a fake socket and a fake binary: no herdr needed."""
from __future__ import annotations

import asyncio
import json
import os
import socket
import stat
import threading
from pathlib import Path
from typing import Any, Callable

import pytest

from server import herdr_runtime
from server.herdr_runtime import AgentPane, Closed, HerdrError, RuntimeStatus


class FakeHerdr:
    """One answer per connection, then close — like the real server."""

    def __init__(self, path: Path, answer: Callable[[str, dict[str, Any]], dict[str, Any]]) -> None:
        self.path = str(path)
        self.answer = answer
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.received: list[bytes] = []
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(self.path)
        self._server.listen(16)
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self._server.accept()
            except OSError:
                return
            with conn:
                raw = conn.makefile("rb").readline()
                self.received.append(raw)
                if not raw:
                    continue  # _server_binary connects without asking anything
                message = json.loads(raw)
                self.calls.append((message["method"], message["params"]))
                conn.sendall((json.dumps(self.answer(message["method"], message["params"])) + "\n").encode())

    def close(self) -> None:
        self._server.close()


@pytest.fixture
def fake(tmp_path: Path, request: pytest.FixtureRequest) -> FakeHerdr:
    answers: dict[str, dict[str, Any]] = getattr(request, "param", {})

    def answer(method: str, _params: dict[str, Any]) -> dict[str, Any]:
        return answers.get(method, {"id": "repociv", "result": {"type": "ok"}})

    server = FakeHerdr(tmp_path / "h.sock", answer)
    yield server
    server.close()


def _ok(**result: Any) -> dict[str, Any]:
    return {"id": "repociv", "result": result}


def _write_binary(path: Path, body: str) -> str:
    path.write_text(f"#!/usr/bin/env python3\n{body}")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


def test_socket_path_ignores_the_pane_this_bridge_may_run_in(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERDR_SOCKET_PATH", "/run/named-session.sock")
    monkeypatch.setenv("XDG_CONFIG_HOME", "/cfg")
    monkeypatch.delenv(herdr_runtime.SOCKET_ENV, raising=False)
    assert herdr_runtime.socket_path() == "/cfg/herdr/herdr.sock"


def test_socket_path_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(herdr_runtime.SOCKET_ENV, "/run/other.sock")
    assert herdr_runtime.socket_path() == "/run/other.sock"


def test_clean_env_drops_every_inherited_pane_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERDR_PANE_ID", "w1:p1")
    monkeypatch.setenv("HERDR_SOCKET_PATH", "/run/named-session.sock")
    env = herdr_runtime.clean_env("/run/default.sock")
    assert "HERDR_PANE_ID" not in env
    assert env["HERDR_SOCKET_PATH"] == "/run/default.sock"


def test_request_without_a_server_is_unavailable(tmp_path: Path) -> None:
    with pytest.raises(HerdrError) as exc:
        herdr_runtime.request("ping", path=str(tmp_path / "missing.sock"))
    assert exc.value.code == "unavailable"


@pytest.mark.parametrize("asynchronous", [False, True])
def test_wrong_instance_sends_no_bytes_and_correct_instance_works(fake: FakeHerdr, asynchronous: bool) -> None:
    instance = herdr_runtime.server_instance(fake.path)
    assert instance
    with pytest.raises(HerdrError) as exc:
        if asynchronous:
            asyncio.run(herdr_runtime.arequest("pane.send_text", {"text": "unsafe"}, path=fake.path, instance="999999:1"))
        else:
            herdr_runtime.request("pane.send_text", {"text": "unsafe"}, path=fake.path, instance="999999:1")
    assert exc.value.code == "server_changed"
    if asynchronous:
        assert asyncio.run(herdr_runtime.arequest("ping", path=fake.path, instance=instance))["type"] == "ok"
    else:
        assert herdr_runtime.request("ping", path=fake.path, instance=instance)["type"] == "ok"
    assert fake.calls == [("ping", {})]
    assert fake.received[:2] == [b"", b""]
    assert len(fake.received) == 3


@pytest.mark.parametrize("asynchronous", [False, True])
def test_unreadable_peer_fails_closed_without_sending(
    fake: FakeHerdr, monkeypatch: pytest.MonkeyPatch, asynchronous: bool,
) -> None:
    monkeypatch.setattr(herdr_runtime, "_peer_instance", lambda _sock: None)
    with pytest.raises(HerdrError) as exc:
        if asynchronous:
            asyncio.run(herdr_runtime.arequest("pane.send_text", {"text": "unsafe"}, path=fake.path, instance="123:456"))
        else:
            herdr_runtime.request("pane.send_text", {"text": "unsafe"}, path=fake.path, instance="123:456")
    assert exc.value.code == "server_changed"
    assert herdr_runtime.request("ping", path=fake.path)["type"] == "ok"
    assert fake.received[0] == b""
    assert fake.calls == [("ping", {})]


def test_launch_mission_pins_agent_checks_paste_and_enter(monkeypatch: pytest.MonkeyPatch) -> None:
    seq = 0
    calls: list[tuple[str, str | None]] = []

    def agents(*, path: str, instance: str) -> list[AgentPane]:
        nonlocal seq
        assert path == "/private" and instance == "123:456"
        seq += 1
        return [AgentPane("w1:p1", "t1", "claude", "idle", state_change_seq=seq)]

    async def request(method: str, _params: dict, *, path: str, instance: str) -> dict:
        assert path == "/private"
        calls.append((method, instance))
        return {}

    monkeypatch.setattr(herdr_runtime, "list_agents", agents)
    monkeypatch.setattr(herdr_runtime, "arequest", request)
    monkeypatch.setattr(herdr_runtime, "_SUBMIT_PAUSE_S", 0)
    result = asyncio.run(herdr_runtime.submit(
        "w1:p1", "hello", path="/private", instance="123:456", expect_agent="claude",
    ))
    assert result.state == "confirmed"
    assert calls == [("pane.send_input", "123:456"), ("pane.send_text", "123:456")]


def test_launch_mission_does_not_send_enter_if_instance_changes_after_paste(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def agents(*, instance: str) -> list[AgentPane]:
        assert instance == "123:456"
        return [AgentPane("w1:p1", "t1", "claude", "idle")]

    async def request(method: str, _params: dict, *, path: str | None, instance: str) -> dict:
        assert instance == "123:456"
        if method == "pane.send_text":
            raise HerdrError("server_changed")
        calls.append(method)
        return {}

    monkeypatch.setattr(herdr_runtime, "list_agents", agents)
    monkeypatch.setattr(herdr_runtime, "arequest", request)
    monkeypatch.setattr(herdr_runtime, "_SUBMIT_PAUSE_S", 0)
    result = asyncio.run(herdr_runtime.submit("w1:p1", "hello", instance="123:456", expect_agent="claude"))
    assert (result.state, result.reason) == ("unconfirmed", "enter_failed")
    assert calls == ["pane.send_input"]


@pytest.mark.parametrize(
    "fake", [{"pane.get": {"id": "", "error": {"code": "pane_not_found", "message": "nope"}}}], indirect=True
)
def test_request_raises_herdr_error_code(fake: FakeHerdr) -> None:
    with pytest.raises(HerdrError) as exc:
        herdr_runtime.request("pane.get", {"pane_id": "w1:p9"}, path=fake.path)
    assert exc.value.code == "pane_not_found"
    assert exc.value.sent is True


@pytest.mark.parametrize("fake", [{"ping": _ok(type="pong", version="0.9.1")}], indirect=True)
def test_probe_ready_uses_the_servers_own_binary(fake: FakeHerdr, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(herdr_runtime, "_server_binary", lambda _path: "/opt/herdr-of-the-server")
    monkeypatch.setattr(herdr_runtime, "find_herdr", lambda: "/usr/bin/some-other-herdr")
    assert herdr_runtime.probe(fake.path) == RuntimeStatus("ready", "0.9.1", "/opt/herdr-of-the-server")


@pytest.mark.parametrize("fake", [{"ping": _ok(type="pong", version="0.8.9")}], indirect=True)
def test_probe_reports_an_old_server_without_touching_it(fake: FakeHerdr) -> None:
    assert herdr_runtime.probe(fake.path).state == "outdated"


@pytest.mark.parametrize("fake", [{"ping": _ok(type="pong", version="0.9.5")}], indirect=True)
def test_probe_replaced_binary_must_prove_it_speaks_the_protocol(
    fake: FakeHerdr, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(herdr_runtime, "_server_binary", lambda _path: None)
    monkeypatch.setattr(herdr_runtime, "find_herdr", lambda: "/usr/bin/herdr")
    monkeypatch.setattr(herdr_runtime, "_client_compatible", lambda _bin, _path: False)
    assert herdr_runtime.probe(fake.path).state == "incompatible"
    monkeypatch.setattr(herdr_runtime, "_client_compatible", lambda _bin, _path: True)
    assert herdr_runtime.probe(fake.path) == RuntimeStatus("ready", "0.9.5", "/usr/bin/herdr")


def test_probe_missing_and_stopped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    gone = str(tmp_path / "missing.sock")
    monkeypatch.setattr(herdr_runtime, "find_herdr", lambda: None)
    assert herdr_runtime.probe(gone).state == "missing"
    binary = _write_binary(tmp_path / "herdr", "print('herdr 0.9.1')\n")
    monkeypatch.setattr(herdr_runtime, "find_herdr", lambda: binary)
    assert herdr_runtime.probe(gone) == RuntimeStatus("stopped", "0.9.1", binary)


def test_server_binary_reads_the_real_process_behind_the_socket(fake: FakeHerdr) -> None:
    assert herdr_runtime._server_binary(fake.path) == os.readlink("/proc/self/exe")


_AGENTS = {
    "agent.list": _ok(
        type="agent_list",
        agents=[
            {"pane_id": "w1:p1", "terminal_id": "t1", "agent": "devin", "agent_status": "working", "cwd": "/w/a"},
            {"pane_id": "w1:p2", "terminal_id": "t2", "agent": "devin", "agent_status": "idle", "cwd": "/w/a"},
        ],
    ),
}


def _process_answer(method: str, params: dict[str, Any]) -> dict[str, Any]:
    if method == "agent.list":
        return _AGENTS["agent.list"]
    if params.get("pane_id") == "w1:p1":
        return _ok(process_info={"foreground_processes": [{"pid": 100}, {"pid": 101}]})
    if params.get("pane_id") == "w1:p2":
        return {"id": "", "error": {"code": "pane_not_found", "message": "closed meanwhile"}}
    return _ok()


def test_panes_for_sessions_matches_owner_pids_exactly(tmp_path: Path) -> None:
    server = FakeHerdr(tmp_path / "h.sock", _process_answer)
    owners = {"s-child-pid": 101, "s-no-pane": 999}
    panes = herdr_runtime.panes_for_sessions(owners, path=server.path)
    server.close()
    assert list(panes) == ["s-child-pid"]
    assert panes["s-child-pid"].pane_id == "w1:p1"


def test_two_agents_in_one_folder_never_get_guessed(tmp_path: Path) -> None:
    """Same agent, same cwd: without a pid match there is no mapping at all."""
    server = FakeHerdr(tmp_path / "h.sock", _process_answer)
    panes = herdr_runtime.panes_for_sessions({"unrelated": 5}, path=server.path)
    server.close()
    assert panes == {}


def test_panes_for_sessions_with_herdr_down_is_empty(tmp_path: Path) -> None:
    assert herdr_runtime.panes_for_sessions({"s": 1}, path=str(tmp_path / "missing.sock")) == {}


def test_agent_pane_never_hands_the_full_path_to_the_browser() -> None:
    pane = AgentPane("w1:p1", "t1", "claude", "idle", cwd="/home/someone/secret/project/")
    assert pane.to_dict()["folder"] == "project"
    assert "/home" not in json.dumps(pane.to_dict())


def _layout_answer(method: str, params: dict[str, Any]) -> dict[str, Any]:
    if method == "pane.list":
        return _ok(panes=[{"pane_id": "w2:p7", "terminal_id": "term_moved"}])
    assert params == {"pane_id": "w2:p7"}
    return _ok(layout={"panes": [
        {"pane_id": "w2:p6", "rect": {"width": 1, "height": 1}},
        {"pane_id": "w2:p7", "rect": {"width": 114, "height": 39}},
    ]})


def test_locate_follows_a_terminal_to_its_current_pane(tmp_path: Path) -> None:
    server = FakeHerdr(tmp_path / "h.sock", _layout_answer)
    geometry = asyncio.run(herdr_runtime.locate("term_moved", path=server.path))
    server.close()
    assert geometry == herdr_runtime.PaneGeometry("w2:p7", 114, 39)


def test_locate_unknown_terminal(tmp_path: Path) -> None:
    server = FakeHerdr(tmp_path / "h.sock", _layout_answer)
    with pytest.raises(HerdrError) as exc:
        asyncio.run(herdr_runtime.locate("term_gone", path=server.path))
    server.close()
    assert exc.value.code == "pane_not_found"


def test_send_text_passes_control_bytes_intact(fake: FakeHerdr) -> None:
    raw = "\x03\x1b[A\x1b\x7f\t\r\x1b[200~x\x1b[201~"
    asyncio.run(herdr_runtime.send_text("w1:p1", raw, path=fake.path))
    assert fake.calls == [("pane.send_text", {"pane_id": "w1:p1", "text": raw})]


def test_paste_goes_through_send_input_so_the_server_can_bracket_it(fake: FakeHerdr) -> None:
    asyncio.run(herdr_runtime.paste("w1:p1", "a\nb", path=fake.path))
    assert fake.calls == [("pane.send_input", {"pane_id": "w1:p1", "text": "a\nb"})]


_OBSERVER = """
import base64, json, os, signal, sys, time
os.chdir({scratch!r})
open("argv.json", "w").write(json.dumps(sys.argv[1:]))
open("socket.txt", "w").write(os.environ.get("HERDR_SOCKET_PATH", ""))
signal.signal(signal.SIGTERM, lambda *_: (open("terminated", "w").close(), sys.exit(0)))
frame = {{"type": "terminal.frame", "seq": 1, "bytes": base64.b64encode(b"x" * {size}).decode()}}
print(json.dumps(frame), flush=True)
{after}
"""


def _observer(tmp_path: Path, *, size: int = 4, after: str = "") -> str:
    scratch = tmp_path / "observer"
    scratch.mkdir(exist_ok=True)
    return _write_binary(tmp_path / "herdr-obs", _OBSERVER.format(scratch=str(scratch), size=size, after=after))


async def _collect(binary: str, limit: int | None = None) -> list[bytes | Closed]:
    out: list[bytes | Closed] = []
    stream = herdr_runtime.observe("term_a", 80, 24, binary=binary, path="/run/x.sock")
    async for item in stream:
        out.append(item)
        if limit is not None and len(out) >= limit:
            await stream.aclose()
            break
    return out


def test_observe_yields_frames_and_one_closed(tmp_path: Path) -> None:
    after = "print(json.dumps({'type': 'terminal.closed', 'reason': 'gone'}), flush=True)"
    binary = _observer(tmp_path, after=after)
    assert asyncio.run(_collect(binary)) == [b"xxxx", Closed("gone")]
    scratch = tmp_path / "observer"
    assert json.loads((scratch / "argv.json").read_text()) == [
        "terminal", "session", "observe", "term_a", "--cols", "80", "--rows", "24",
    ]
    assert (scratch / "socket.txt").read_text() == "/run/x.sock"


def test_observe_survives_a_frame_larger_than_the_asyncio_line_limit(tmp_path: Path) -> None:
    binary = _observer(tmp_path, size=200_000)
    assert asyncio.run(_collect(binary)) == [b"x" * 200_000, Closed("observer_exited")]


def test_closing_the_stream_stops_the_observer(tmp_path: Path) -> None:
    binary = _observer(tmp_path, after="time.sleep(30)")
    assert asyncio.run(_collect(binary, limit=1)) == [b"xxxx"]
    assert (tmp_path / "observer" / "terminated").exists()


@pytest.mark.parametrize("target", ["--output=/etc/passwd", "-h", "", "a b"])
def test_observe_refuses_a_target_that_reads_as_an_option(target: str, tmp_path: Path) -> None:
    async def go() -> None:
        async for _ in herdr_runtime.observe(target, 80, 24, binary=str(tmp_path / "unused")):
            pass

    with pytest.raises(HerdrError) as exc:
        asyncio.run(go())
    assert exc.value.code == "invalid_target"


def test_subscribe_acknowledges_then_streams_until_the_server_leaves(tmp_path: Path) -> None:
    path = tmp_path / "e.sock"

    async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        request = json.loads(await reader.readline())
        assert request["method"] == "events.subscribe"
        assert request["params"]["subscriptions"][0]["pane_id"] == "w1:p1"
        for line in (
            {"id": "repociv", "result": {"type": "subscription_started"}},
            {"event": "pane.agent_status_changed", "data": {"agent_status": "blocked"}},
            {"event": "pane.agent_status_changed", "data": {"agent_status": "idle"}},
        ):
            writer.write((json.dumps(line) + "\n").encode())
        await writer.drain()
        writer.close()

    async def go() -> list[str]:
        server = await asyncio.start_unix_server(serve, path=str(path))
        async with server:
            return [status async for status in herdr_runtime.status_events("w1:p1", path=str(path))]

    assert asyncio.run(go()) == ["blocked", "idle"]
