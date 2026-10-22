"""Hermetic tests for server/cli_discovery.py and the finders that delegate to it.

Nothing here touches the network and no CLI is ever invoked: candidate discovery
is exercised either against real files created under ``tmp_path`` (chmod'd) or
against monkeypatched globals. ``_find_*`` sweeps are driven through their
agent_runner module globals so the monkeypatch seam used by the rest of the
suite stays covered.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from server import agent_runner, claude_live, cli_discovery


def _make_executable(path: Path) -> Path:
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(0o755)
    return path


# ─── first_executable: candidates · priority · non-executable · non-existent ──

def test_first_executable_returns_first_existing_executable(tmp_path):
    first = _make_executable(tmp_path / "first")
    second = _make_executable(tmp_path / "second")
    assert cli_discovery.first_executable([str(first), str(second)]) == str(first)


def test_first_executable_preserves_candidate_order_not_alphabetical(tmp_path):
    zeta = _make_executable(tmp_path / "zeta")
    alpha = _make_executable(tmp_path / "alpha")
    assert cli_discovery.first_executable([str(zeta), str(alpha)]) == str(zeta)


def test_first_executable_skips_none_empty_and_missing(tmp_path):
    present = _make_executable(tmp_path / "present")
    missing = tmp_path / "missing"
    assert cli_discovery.first_executable(
        [None, "", str(missing), str(present)]
    ) == str(present)


def test_first_executable_skips_non_executable(tmp_path):
    plain = tmp_path / "plain"
    plain.write_text("not executable", encoding="utf-8")
    plain.chmod(0o644)
    exe = _make_executable(tmp_path / "exe")
    assert cli_discovery.first_executable([str(plain), str(exe)]) == str(exe)


def test_first_executable_none_when_no_candidate_matches(tmp_path):
    plain = tmp_path / "plain"
    plain.write_text("nope", encoding="utf-8")
    plain.chmod(0o644)
    candidates = [None, "", str(tmp_path / "absent"), str(plain)]
    assert cli_discovery.first_executable(candidates) is None


# ─── claude candidates: shared, ordered, and None-safe ───────────────────────

def test_claude_candidates_order_and_sources(monkeypatch, tmp_path):
    monkeypatch.setattr(cli_discovery.shutil, "which", lambda name: "/found/claude")
    monkeypatch.setattr(cli_discovery.Path, "home", classmethod(lambda cls: tmp_path))
    assert cli_discovery.claude_candidates() == [
        "/found/claude",
        str(tmp_path / ".npm-global" / "bin" / "claude"),
        str(tmp_path / ".local" / "bin" / "claude"),
    ]


def test_find_claude_prefers_first_candidate(monkeypatch, tmp_path):
    exe = _make_executable(tmp_path / "claude")
    monkeypatch.setattr(cli_discovery.shutil, "which", lambda name: str(exe))
    assert cli_discovery.find_claude() == str(exe)


def test_find_claude_none_when_absent(monkeypatch):
    monkeypatch.setattr(cli_discovery.shutil, "which", lambda name: None)
    monkeypatch.setattr(cli_discovery.Path, "exists", lambda self: False)
    assert cli_discovery.find_claude() is None


# ─── claude_live keeps "" (not None) and owns no candidate list ──────────────

def test_claude_live_find_claude_empty_string_when_absent(monkeypatch):
    monkeypatch.setattr(cli_discovery, "find_claude", lambda: None)
    assert claude_live._find_claude() == ""


def test_claude_live_find_claude_delegates_when_present(monkeypatch):
    monkeypatch.setattr(cli_discovery, "find_claude", lambda: "/opt/claude")
    assert claude_live._find_claude() == "/opt/claude"


# ─── agent_runner wrappers delegate; _has_* resolve the runner globals ───────

def test_agent_runner_find_claude_code_delegates(monkeypatch):
    monkeypatch.setattr(cli_discovery, "find_claude", lambda: "/bin/claude")
    assert agent_runner._find_claude_code() == "/bin/claude"


def test_agent_runner_find_codex_passes_ordered_candidates(monkeypatch):
    seen: dict[str, list] = {}

    def fake_first(candidates):
        seen["candidates"] = list(candidates)
        return "picked"

    monkeypatch.setattr(agent_runner.shutil, "which", lambda name: f"/which/{name}")
    monkeypatch.setattr(cli_discovery, "first_executable", fake_first)
    assert agent_runner._find_codex() == "picked"
    assert seen["candidates"][0] == "/which/codex"
    assert seen["candidates"][-1] == "/usr/local/bin/codex"


def test_agent_runner_find_opencode_honors_env_override(tmp_path, monkeypatch):
    exe = _make_executable(tmp_path / "opencode-custom")
    monkeypatch.setenv("REPOCIV_OPENCODE_BIN", str(exe))
    monkeypatch.setattr(agent_runner.shutil, "which",
                        lambda name: str(exe) if name == str(exe) else None)
    assert agent_runner._find_opencode() == str(exe)


def test_agent_runner_find_opencode_none_without_env_binary(monkeypatch):
    monkeypatch.delenv("REPOCIV_OPENCODE_BIN", raising=False)
    monkeypatch.setattr(agent_runner.shutil, "which", lambda name: None)
    monkeypatch.setattr(cli_discovery.Path, "exists", lambda self: False)
    assert agent_runner._find_opencode() is None


def test_has_opencode_resolves_runner_global(monkeypatch):
    monkeypatch.setattr(agent_runner, "_find_opencode", lambda: "/x/opencode")
    assert agent_runner._has_opencode() is True
    monkeypatch.setattr(agent_runner, "_find_opencode", lambda: None)
    assert agent_runner._has_opencode() is False


def test_find_cursor_ide_kept_in_this_batch(monkeypatch, tmp_path):
    exe = _make_executable(tmp_path / "cursor")
    monkeypatch.setattr(agent_runner.shutil, "which", lambda name: str(exe))
    assert agent_runner._find_cursor_ide() == str(exe)


@pytest.mark.parametrize(
    "name,binary,fallbacks",
    [
        ("openclaw", "openclaw", [".npm-global/bin/openclaw"]),
        ("codex", "codex", [".npm-global/bin/codex", ".local/bin/codex", "/usr/local/bin/codex"]),
        ("opencode", "opencode", [".local/bin/opencode", ".npm-global/bin/opencode", "/usr/local/bin/opencode"]),
        ("hermes_cli", "hermes", [".local/bin/hermes", "/usr/local/bin/hermes"]),
        ("cursor_agent", "cursor-agent", [".local/bin/cursor-agent", ".cursor/bin/cursor-agent", "/usr/local/bin/cursor-agent"]),
        ("cursor_ide", "cursor", [".local/bin/cursor", "/usr/local/bin/cursor"]),
    ],
)
def test_harness_candidate_order(monkeypatch, tmp_path, name, binary, fallbacks):
    monkeypatch.delenv("REPOCIV_OPENCODE_BIN", raising=False)
    queries = []
    seen = []

    def which(command):
        queries.append(command)
        return f"/which/{command}"

    def first(candidates):
        seen.extend(candidates)
        return "selected"

    monkeypatch.setattr(cli_discovery.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(cli_discovery.shutil, "which", which)
    monkeypatch.setattr(cli_discovery, "first_executable", first)
    assert getattr(cli_discovery, f"find_{name}")() == "selected"
    assert queries == [binary]
    assert seen == [f"/which/{binary}", *[str(tmp_path / path) for path in fallbacks]]


@pytest.mark.parametrize("name", ["openclaw", "codex", "opencode", "hermes_cli", "cursor_agent", "cursor_ide"])
@pytest.mark.parametrize("result", [None, "/fake/bin/harness"])
def test_runner_discovery_facades(monkeypatch, name, result):
    monkeypatch.setattr(cli_discovery, f"find_{name}", lambda: result)
    assert getattr(agent_runner, f"_find_{name}")() == result


@pytest.mark.parametrize(
    "has_name,find_name",
    [
        ("openclaw", "openclaw"),
        ("codex", "codex"),
        ("opencode", "opencode"),
        ("hermes_cli", "hermes_cli"),
        ("claude_code", "claude_code"),
        ("cursor", "cursor_agent"),
    ],
)
def test_availability_keeps_runner_lookup(monkeypatch, has_name, find_name):
    monkeypatch.setattr(agent_runner, f"_find_{find_name}", lambda: "/fake/harness")
    assert getattr(agent_runner, f"_has_{has_name}")() is True
    monkeypatch.setattr(agent_runner, f"_find_{find_name}", lambda: None)
    assert getattr(agent_runner, f"_has_{has_name}")() is False


@pytest.mark.parametrize(
    "name,fallback",
    [
        ("openclaw", ".npm-global/bin/openclaw"),
        ("codex", ".npm-global/bin/codex"),
        ("opencode", ".local/bin/opencode"),
        ("hermes_cli", ".local/bin/hermes"),
        ("cursor_agent", ".local/bin/cursor-agent"),
        ("cursor_ide", ".local/bin/cursor"),
    ],
)
def test_harness_finds_real_fallback_when_missing_from_path(monkeypatch, tmp_path, name, fallback):
    monkeypatch.delenv("REPOCIV_OPENCODE_BIN", raising=False)
    monkeypatch.setattr(cli_discovery.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(cli_discovery.shutil, "which", lambda command: None)
    executable = tmp_path / fallback
    executable.parent.mkdir(parents=True, exist_ok=True)
    _make_executable(executable)
    assert getattr(cli_discovery, f"find_{name}")() == str(executable)
    assert getattr(agent_runner, f"_find_{name}")() == str(executable)
