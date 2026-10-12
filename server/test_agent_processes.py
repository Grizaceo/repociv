from pathlib import Path
import os

from server.agent_processes import _family, snapshot


def _proc(root: Path, pid: int, ppid: int, name: str, argv: list[str]) -> None:
    folder = root / str(pid)
    folder.mkdir()
    (folder / "stat").write_text(f"{pid} ({name}) S {ppid} 0 0")
    (folder / "cmdline").write_bytes("\0".join(argv).encode())


def test_all_descendants_and_metadata_only(tmp_path: Path) -> None:
    _proc(tmp_path, 10, 1, "hermes", ["/bin/hermes", "--token", "PRIVATE"])
    _proc(tmp_path, 11, 10, "python", ["python", "mcp.py", "PRIVATE"])
    _proc(tmp_path, 12, 11, "node", ["node", "server.js"])
    _proc(tmp_path, 20, 1, "gpg-agent", ["gpg-agent"])
    _proc(tmp_path, 21, 1, "bash", ["bash", "-c", "hermes PRIVATE"])
    result = snapshot(tmp_path)
    assert result["available"]
    assert [p["pid"] for p in result["processes"]] == [10, 11, 12]
    assert result["processes"][2]["rootPid"] == 10
    assert "PRIVATE" not in str(result)
    assert all("argv" not in p for p in result["processes"])


def test_recognized_entrypoints_not_prompt_text() -> None:
    assert _family(["python", "-m", "hermes_cli"], "python") == "Hermes"
    assert _family(["node", "/pkg/@openai/codex/bin/cli.js"], "node") == "Codex"
    assert _family(["python", "unrelated.py", "hermes"], "python") is None
    assert _family(["bash", "-c", "codex"], "bash") is None


def test_uid_scope_and_unavailable(tmp_path: Path) -> None:
    _proc(tmp_path, 10, 1, "hermes", ["hermes"])
    assert snapshot(tmp_path, uid=os.getuid() + 1)["processes"] == []
    assert snapshot(tmp_path / "missing")["available"] is False


def test_exit_races_and_process_names_with_parentheses(tmp_path: Path) -> None:
    _proc(tmp_path, 10, 1, "hermes", ["hermes"])
    _proc(tmp_path, 11, 10, "worker (test)", ["python"])
    (tmp_path / "12").mkdir()
    result = snapshot(tmp_path)
    assert len(result["processes"]) == 2
    assert result["processes"][1]["name"] == "worker (test)"
    assert result["unreadable"] == 1
