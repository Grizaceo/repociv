"""End-to-end MCP stdio probe against a real RepoCiv bridge process."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _repo_id(path: Path) -> str:
    encoded = base64.urlsafe_b64encode(str(path).encode()).decode().rstrip("=")
    return f"repo:{encoded}"


def _tool_payload(result: Any) -> Any:
    assert not result.isError, result.content
    structured = getattr(result, "structuredContent", None)
    if isinstance(structured, dict):
        if set(structured) == {"result"}:
            return structured["result"]
        return structured
    for item in result.content:
        text = getattr(item, "text", None)
        if isinstance(text, str):
            return json.loads(text)
    raise AssertionError(f"MCP tool returned no JSON payload: {result!r}")


async def _exercise_mcp(env: dict[str, str], repo: Path) -> None:
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "server.mcp_server"],
        env=env,
        cwd=str(Path(__file__).resolve().parents[1]),
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            assert len(tools.tools) == 38

            submitted = _tool_payload(
                await session.call_tool(
                    "command_submit",
                    arguments={
                        "type": "execute_agent",
                        "target": repo.name,
                        "risk": "low",
                        "payload": {
                            "unit": "WORKER",
                            "city": _repo_id(repo),
                            "repoPath": str(repo),
                            "mission": "verify real MCP lifecycle",
                            "harness": "fixture",
                        },
                    },
                )
            )
            assert submitted["status"] == "waiting_approval"
            command_id = submitted["commandId"]

            approved = _tool_payload(
                await session.call_tool("approval_approve", arguments={"id": command_id})
            )
            assert approved["status"] == "queued"

            evidence: dict[str, Any] = {}
            for _ in range(100):
                evidence = _tool_payload(
                    await session.call_tool("command_evidence", arguments={"id": command_id})
                )
                if evidence.get("terminalEvent"):
                    break
                await asyncio.sleep(0.05)

            assert evidence["terminalEvent"]["type"] == "CommandCompleted"
            assert evidence["terminalEvent"]["data"]["repoPath"] == str(repo)
            assert evidence["runState"]["runtimeId"] == "fixture"
            assert evidence["runState"]["status"] == "completed"
            assert "FIXTURE_AGENT_EXECUTED" in evidence["runState"]["result"]
            assert "mission=verify real MCP lifecycle" in evidence["runState"]["result"]


def test_mcp_stdio_real_command_approval_evidence(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    repo = root / "fixture-repo"
    repo.mkdir(parents=True)
    (repo / ".git").mkdir()
    (repo / "README.md").write_text("# MCP Fixture Repo\n", encoding="utf-8")

    bridge_port = _free_port()
    ws_port = _free_port()
    token = "mcp-runtime-probe-token-32-characters"
    state_file = tmp_path / "roots.json"
    state_file.write_text(
        json.dumps(
            {
                "version": 1,
                "activeRoot": str(root),
                "roots": {
                    str(root): {
                        "selectedRepoPaths": [str(repo)],
                        "addedAt": "2026-07-13T00:00:00Z",
                        "lastSeen": "2026-07-13T00:00:00Z",
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    env = {
        **os.environ,
        "BRIDGE_PORT": str(bridge_port),
        "BRIDGE_WS_PORT": str(ws_port),
        "REPOCIV_TOKEN": token,
        "REPOCIV_MAP_ROOT": str(root),
        "REPOCIV_REPOS_ROOT": str(root),
        "REPOCIV_STATE_DIR": str(tmp_path / "state"),
        "REPOCIV_CONFIG_DIR": str(tmp_path / "config"),
        "REPOCIV_STATE_FILE": str(state_file),
        "XDG_STATE_HOME": str(tmp_path / "xdg"),
        "REPOCIV_E2E_FIXTURE_HARNESS": "1",
    }
    bridge = subprocess.Popen(
        [sys.executable, "-m", "server.bridge"],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{bridge_port}"
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if httpx.get(f"{base}/health", timeout=0.25).status_code == 200:
                    break
            except httpx.ConnectError:
                time.sleep(0.05)
        else:
            raise AssertionError("real bridge did not become healthy")

        asyncio.run(_exercise_mcp(env, repo))
    finally:
        bridge.terminate()
        try:
            bridge.wait(timeout=5)
        except subprocess.TimeoutExpired:
            bridge.kill()
            bridge.wait(timeout=5)
