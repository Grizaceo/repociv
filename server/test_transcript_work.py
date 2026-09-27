"""Native transcripts (Claude Code, Codex) → the folders a session works in."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from server import transcript_work as tw


@pytest.fixture()
def repos(tmp_path: Path) -> Path:
    w = tmp_path / "w"
    for rel in ("alpha/src", "beta/tests", "gamma"):
        (w / rel).mkdir(parents=True)
    return w


def _write(path: Path, entries: list[dict[str, Any]]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(e, separators=(",", ":")) + "\n" for e in entries))
    return str(path)


# ─── Claude Code ─────────────────────────────────────────────────────────────
def _claude(cwd: str, *calls: tuple[str, dict[str, Any]]) -> dict[str, Any]:
    return {
        "type": "assistant",
        "cwd": cwd,
        "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": f"t{i}", "name": name, "input": inp} for i, (name, inp) in enumerate(calls)
        ]},
    }


def _claude_result(text: str) -> dict[str, Any]:
    return {"type": "user", "cwd": "/", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t0", "content": text}]}}


def test_claude_reads_the_shell_cwd_file_paths_and_command_paths(repos: Path, tmp_path: Path) -> None:
    alpha, beta, gamma = repos / "alpha", repos / "beta", repos / "gamma"
    path = _write(tmp_path / "t.jsonl", [
        _claude(str(tmp_path), ("Bash", {"command": f"find {tmp_path} -name '*alpha*'"})),
        _claude_result(f"{alpha}\n{alpha}/src\n"),  # tool output: never read
        _claude(str(tmp_path), ("Read", {"file_path": f"{alpha}/src/app.py"}),
                ("Write", {"file_path": f"{alpha}/NOTES.md", "content": f"see {gamma}/x and {gamma}/y"})),
        _claude(str(alpha), ("Bash", {"command": "npm test", "description": "run"}),
                ("Grep", {"pattern": "TODO", "path": f"{beta}/tests"})),
    ])
    dirs = tw.transcript_work_dirs("claude-code", path)
    # Newest first; the Write's content (gamma) and the tool output never count.
    assert dirs == (str(beta / "tests"), str(alpha), str(alpha), str(alpha), str(tmp_path),
                    str(alpha / "src"), str(tmp_path), str(tmp_path), str(tmp_path))


# ─── Codex ───────────────────────────────────────────────────────────────────
def _codex(payload: dict[str, Any]) -> dict[str, Any]:
    return {"timestamp": "2026-09-24T23:00:00Z", "type": "response_item", "payload": payload}


def test_codex_reads_workdir_command_paths_and_patch_headers(repos: Path, tmp_path: Path) -> None:
    alpha, beta, gamma = repos / "alpha", repos / "beta", repos / "gamma"
    code = (
        'const [a,b] = await Promise.all([\n'
        f'  tools.exec_command({{cmd:"pytest -q",workdir:"{alpha}",yield_time_ms:30000}}),\n'
        f'  tools.exec_command({{cmd:"sed -n \'1,40p\' {beta}/tests/test_x.py",workdir:"{tmp_path}"}}),\n'
        ']);\n'
        f'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: {alpha}/src/app.py\\n'
        f'+# moved from {gamma}/old.py\\n*** End Patch"));'
    )
    path = _write(tmp_path / "rollout.jsonl", [
        {"type": "turn_context", "payload": {"cwd": str(tmp_path)}},
        _codex({"type": "function_call", "name": "shell",
                "arguments": json.dumps({"command": ["bash", "-lc", f"ls {gamma}"], "workdir": str(gamma)})}),
        _codex({"type": "function_call_output", "call_id": "c1", "output": f"{beta}\n{beta}\n"}),
        _codex({"type": "custom_tool_call", "name": "exec", "input": code}),
        _codex({"type": "custom_tool_call_output", "call_id": "c2", "output": f"{beta}/tests"}),
    ])
    dirs = tw.transcript_work_dirs("openai-codex", path)
    # Patch *content* (gamma/old.py) and tool outputs never count.
    assert dirs ==(str(alpha / "src"), str(alpha), str(tmp_path), str(beta / "tests"), str(gamma), str(gamma))


def test_codex_exec_with_quoted_keys(repos: Path, tmp_path: Path) -> None:
    # codex-cli 0.156 (2026-09-24) writes the exec_command options JSON-style.
    alpha = repos / "alpha"
    code = ('const r = await tools.exec_command({"cmd":"rg --files | sort; sed -n \'1,40p\' README.md",'
            f'"workdir":"{alpha}","yield_time_ms":10000}});')
    path = _write(tmp_path / "rollout.jsonl", [_codex({"type": "custom_tool_call", "name": "exec", "input": code})])
    assert tw.transcript_work_dirs("openai-codex", path) == (str(alpha),)


def test_only_the_newest_calls_count(repos: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tw, "_MAX_CALLS", 3)
    alpha, beta = repos / "alpha", repos / "beta"
    old = [_claude("/", ("Read", {"file_path": f"{alpha}/src/f{i}.py"})) for i in range(5)]
    new = [_claude("/", ("Read", {"file_path": f"{beta}/tests/t{i}.py"})) for i in range(3)]
    path = _write(tmp_path / "t.jsonl", old + new)
    assert set(tw.transcript_work_dirs("claude-code", path)) <= {str(beta / "tests"), "/"}


def test_unknown_agent_missing_file_or_garbage(tmp_path: Path) -> None:
    (tmp_path / "bad.jsonl").write_text('not json\n{"type":"assistant","message":"x"}\n\n')
    assert tw.transcript_work_dirs("claude-code", str(tmp_path / "bad.jsonl")) == ()
    assert tw.transcript_work_dirs("claude-code", str(tmp_path / "missing.jsonl")) == ()
    assert tw.transcript_work_dirs("cursor", str(tmp_path / "bad.jsonl")) == ()


def test_dirs_from_hints_keeps_real_folders_only(repos: Path) -> None:
    alpha = repos / "alpha"
    hints = [f"{alpha}/src/new_file.py", str(alpha), "relative/path", f"{alpha}/nope/deeper/x.py", "~"]
    assert tw.dirs_from_hints(hints) == (str(alpha / "src"), str(alpha), str(Path.home()))
