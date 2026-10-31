"""The contract with the real herdr binary, on a private server.

Pins what ``docs/HERDR_LIVE_CLI.md`` measured, so an upgrade that changes it fails
here instead of in a user's terminal. Skipped where herdr is not installed.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterator

import pytest

from server import herdr_runtime
from server.herdr_runtime import Closed

HERDR = shutil.which("herdr")
pytestmark = pytest.mark.skipif(HERDR is None, reason="herdr not installed")
_MAX_SOCKET_PATH = 100


class Private:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.socket = str(root / "h.sock")
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("HERDR_")}
        self.env.update(
            HOME=str(root),
            XDG_CONFIG_HOME=str(root / "config"),
            HERDR_SOCKET_PATH=self.socket,
        )

    def new_workspace(self) -> tuple[str, str]:
        """A headless server starts with no workspaces at all."""
        made = herdr_runtime.request("workspace.create", {"focus": False}, path=self.socket)
        workspace = made["workspace"]["workspace_id"]
        panes = herdr_runtime.request("pane.list", path=self.socket)["panes"]
        return workspace, next(row["pane_id"] for row in panes if row["workspace_id"] == workspace)

    def wait_for_text(self, pane_id: str, needle: str, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            read = herdr_runtime.request(
                "pane.read", {"pane_id": pane_id, "source": "visible", "format": "text"}, path=self.socket
            )["read"]
            if needle in read["text"]:
                return
            time.sleep(0.05)
        pytest.fail(f"{needle!r} never appeared")


@pytest.fixture(scope="module")
def private() -> Iterator[Private]:
    root = Path(tempfile.mkdtemp(prefix="rch"))
    server = Private(root)
    if len(server.socket) > _MAX_SOCKET_PATH:
        pytest.skip("temp dir too long for a unix socket; set TMPDIR")
    (root / "config" / "herdr").mkdir(parents=True)
    (root / "config" / "herdr" / "config.toml").write_text("onboarding = false\n")
    proc = subprocess.Popen(
        [HERDR, "server"],
        env=server.env,
        cwd=root,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            herdr_runtime.request("ping", path=server.socket)
            break
        except herdr_runtime.HerdrError:
            time.sleep(0.05)
    else:
        proc.kill()
        pytest.fail("private herdr server never answered")
    yield server
    # The stop reaches this socket only: env is scrubbed above and the path lives
    # under the private root.
    assert server.socket.startswith(str(root))
    subprocess.run([HERDR, "server", "stop"], env=server.env, cwd=root, timeout=10, check=False)
    proc.wait(timeout=10)
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def pane(private: Private) -> Iterator[str]:
    workspace, pane_id = private.new_workspace()
    yield pane_id
    try:
        herdr_runtime.request("workspace.close", {"workspace_id": workspace}, path=private.socket)
    except herdr_runtime.HerdrError:
        pass  # the test closed or emptied it


RECORDER = """
import os, sys, termios, tty
tty.setraw(0)
os.write(1, b"\\x1b[?2004h\\x1b[?1h\\x1b[?1000hRECORDING")
with open({log!r}, "ab", buffering=0) as log:
    while True:
        data = os.read(0, 4096)
        log.write(repr(data).encode() + b"\\n")
"""


def _recorder(private: Private, pane_id: str, name: str) -> Path:
    log = private.root / f"{name}.log"
    script = private.root / f"{name}.py"
    script.write_text(RECORDER.format(log=str(log)))
    asyncio.run(herdr_runtime.send_text(pane_id, f"clear; exec {sys.executable} {script}\r", path=private.socket))
    private.wait_for_text(pane_id, "RECORDING")
    return log


def _wait_for_log(log: Path, needle: str) -> str:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        text = log.read_text() if log.exists() else ""
        if needle in text:
            return text
        time.sleep(0.02)
    pytest.fail(f"{needle!r} not in {log.read_text() if log.exists() else '<no log>'}")


def test_probe_finds_the_running_server_and_its_binary(private: Private) -> None:
    status = herdr_runtime.probe(private.socket)
    assert status.state == "ready"
    assert os.path.realpath(status.binary) == os.path.realpath(HERDR)


def test_observe_paints_the_screen_and_send_text_reaches_the_pty(private: Private, pane: str) -> None:
    async def go() -> bytes:
        geometry = await herdr_runtime.locate(_terminal(private, pane), path=private.socket)
        seen = bytearray()
        stream = herdr_runtime.observe(
            _terminal(private, pane), geometry.cols, geometry.rows, binary=HERDR, path=private.socket
        )
        async for frame in stream:
            assert not isinstance(frame, Closed)
            if not seen:
                await herdr_runtime.send_text(pane, "echo o''bserved\r", path=private.socket)
            seen.extend(frame)
            if b"observed" in seen:
                await stream.aclose()
                break
        return bytes(seen)

    assert b"observed" in asyncio.run(asyncio.wait_for(go(), 10))


def _terminal(private: Private, pane_id: str) -> str:
    rows = herdr_runtime.request("pane.list", path=private.socket)["panes"]
    return next(row["terminal_id"] for row in rows if row["pane_id"] == pane_id)


def test_observe_keeps_pty_modes_from_the_viewer(private: Private, pane: str) -> None:
    """Why paste cannot go through xterm: the viewer never learns these modes."""
    _recorder(private, pane, "modes")

    async def first_frame() -> bytes:
        stream = herdr_runtime.observe(_terminal(private, pane), 80, 24, binary=HERDR, path=private.socket)
        async for frame in stream:
            await stream.aclose()
            assert isinstance(frame, bytes)
            return frame
        return b""

    frame = asyncio.run(asyncio.wait_for(first_frame(), 10))
    assert b"RECORDING" in frame
    for mode in (b"\x1b[?2004h", b"\x1b[?1h", b"\x1b[?1000h"):
        assert mode not in frame


def test_paste_is_bracketed_only_by_the_server(private: Private, pane: str) -> None:
    log = _recorder(private, pane, "paste")
    asyncio.run(herdr_runtime.paste(pane, "l1\nl2", path=private.socket))
    assert "\\x1b[200~l1\\nl2\\x1b[201~" in _wait_for_log(log, "l2")
    asyncio.run(herdr_runtime.send_text(pane, "raw1\nraw2", path=private.socket))
    assert "b'raw1\\nraw2'" in _wait_for_log(log, "raw2")


def test_terminal_id_survives_a_pane_move(private: Private, pane: str) -> None:
    terminal = _terminal(private, pane)
    other, _ = private.new_workspace()
    target = herdr_runtime.request("tab.list", {"workspace_id": other}, path=private.socket)["tabs"][0]["tab_id"]
    herdr_runtime.request(
        "pane.split", {"pane_id": pane, "direction": "right", "focus": False}, path=private.socket
    )
    moved = herdr_runtime.request(
        "pane.move",
        {"pane_id": pane, "destination": {"type": "tab", "tab_id": target, "split": "right"}},
        path=private.socket,
    )["move_result"]["pane"]["pane_id"]
    assert moved != pane
    geometry = asyncio.run(herdr_runtime.locate(terminal, path=private.socket))
    assert geometry.pane_id == moved
    herdr_runtime.request("workspace.close", {"workspace_id": other}, path=private.socket)


def test_status_events_report_a_reported_state(private: Private, pane: str) -> None:
    async def go() -> str:
        stream = herdr_runtime.status_events(pane, path=private.socket)
        first = asyncio.ensure_future(anext(stream))
        await asyncio.sleep(0.2)
        herdr_runtime.request(
            "pane.report_agent",
            {"pane_id": pane, "source": "repociv-test", "agent": "claude", "state": "blocked"},
            path=private.socket,
        )
        status = await asyncio.wait_for(first, 5)
        await stream.aclose()
        return status

    assert asyncio.run(go()) == "blocked"
    herdr_runtime.request(
        "pane.release_agent", {"pane_id": pane, "source": "repociv-test", "agent": "claude"}, path=private.socket
    )


def test_closing_a_pane_closes_the_stream(private: Private) -> None:
    _, pane_id = private.new_workspace()

    async def go() -> Closed:
        stream = herdr_runtime.observe(_terminal(private, pane_id), 80, 24, binary=HERDR, path=private.socket)
        closing = False
        async for frame in stream:
            if isinstance(frame, Closed):
                return frame
            if not closing:
                closing = True
                herdr_runtime.request("pane.close", {"pane_id": pane_id}, path=private.socket)
        pytest.fail("no Closed")

    assert asyncio.run(asyncio.wait_for(go(), 10)).reason


def test_observing_a_missing_terminal_closes_at_once(private: Private) -> None:
    async def go() -> list[object]:
        return [item async for item in herdr_runtime.observe("term_nope", 80, 24, binary=HERDR, path=private.socket)]

    items = asyncio.run(asyncio.wait_for(go(), 10))
    assert len(items) == 1 and isinstance(items[0], Closed)


