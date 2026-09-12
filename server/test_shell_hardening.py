"""Security regression: the two remaining shell=True call sites now use argv.

Both take their command from config (a harness descriptor / a repo config file),
so they must run via an argv list with shell=False — shell metacharacters must
never be interpreted. Guards server/runtime_adapters.py and server/validator.py.
"""

from __future__ import annotations

from types import SimpleNamespace

from server import runtime_adapters as ra
from server import validator as v


def _recorder(rec: dict):
    def _run(*args, **kwargs):
        rec["args"] = args
        rec["kwargs"] = kwargs
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    return _run


def test_runtime_adapter_healthcheck_command_uses_argv_not_shell(monkeypatch) -> None:
    rec: dict = {}
    monkeypatch.setattr(ra.subprocess, "run", _recorder(rec))
    adapter = ra.RuntimeAdapter(
        harness_id="x",
        descriptor={"health": {"kind": "command", "command": "echo hi; rm -rf /tmp/pwn"}},
    )

    result = adapter.healthcheck()

    assert result["ok"] is True
    # First positional arg must be an argv list, never a shell string.
    assert isinstance(rec["args"][0], list)
    # ';' is a plain token, not a shell separator.
    assert rec["args"][0] == ["echo", "hi;", "rm", "-rf", "/tmp/pwn"]
    assert rec["kwargs"].get("shell", False) is False


def test_runtime_adapter_healthcheck_empty_command_is_missing(monkeypatch) -> None:
    rec: dict = {}
    monkeypatch.setattr(ra.subprocess, "run", _recorder(rec))
    adapter = ra.RuntimeAdapter(
        harness_id="x", descriptor={"health": {"kind": "command", "command": "   "}}
    )

    assert adapter.healthcheck()["status"] == "missing-command"
    assert "args" not in rec  # subprocess.run must not run for an empty command


def test_validator_build_check_uses_argv_not_shell(monkeypatch, tmp_path) -> None:
    rec: dict = {}
    monkeypatch.setattr(v.subprocess, "run", _recorder(rec))
    monkeypatch.setattr(
        v._rc,
        "load_repo_config",
        lambda repo: {"buildCommand": "npm run build; echo pwned", "path": str(tmp_path)},
    )

    result = v._run_build_check("repo", "issue-1")

    assert result["passed"] is True
    assert isinstance(rec["args"][0], list)
    assert rec["args"][0] == ["npm", "run", "build;", "echo", "pwned"]
    assert rec["kwargs"].get("shell", False) is False


def test_validator_build_check_whitespace_command_skips(monkeypatch) -> None:
    rec: dict = {}
    monkeypatch.setattr(v.subprocess, "run", _recorder(rec))
    monkeypatch.setattr(
        v._rc, "load_repo_config", lambda repo: {"buildCommand": "   ", "path": "."}
    )

    result = v._run_build_check("repo", "issue-1")

    assert result["passed"] is True
    assert "skipping" in result["detail"]
    assert "args" not in rec  # subprocess.run must not run for a whitespace command
