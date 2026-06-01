"""Tests for server/repo_config.py — Sprint B2 YAML Hook Security."""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

import server.repo_config as rc


# ─── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def isolated_config_dir(tmp_path, monkeypatch):
    """Redirect _CONFIG_BASE to a temp dir for every test."""
    config_dir = tmp_path / "repociv" / "configs"
    config_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(rc, "_CONFIG_BASE", config_dir)
    return config_dir


def _write_config(config_dir: Path, repo: str, content: str) -> None:
    (config_dir / f"{repo}.yaml").write_text(content, encoding="utf-8")


# ─── Repo name validation ─────────────────────────────────────────────────────

def test_path_traversal_repo_raises(isolated_config_dir):
    with pytest.raises(ValueError, match="Invalid repo name"):
        rc.load_repo_config("../evil")


def test_slash_in_repo_raises(isolated_config_dir):
    with pytest.raises(ValueError, match="Invalid repo name"):
        rc.load_repo_config("foo/bar")


def test_tilde_in_repo_raises(isolated_config_dir):
    with pytest.raises(ValueError, match="Invalid repo name"):
        rc.load_repo_config("~/.ssh")


def test_empty_repo_name_raises(isolated_config_dir):
    with pytest.raises(ValueError):
        rc.load_repo_config("")


def test_valid_repo_name_with_hyphen_and_underscore(isolated_config_dir):
    # Should not raise — file just doesn't exist, returns defaults
    result = rc.load_repo_config("my-repo_123")
    assert result == {"hooks": {}}


# ─── File not found → defaults ────────────────────────────────────────────────

def test_missing_config_file_returns_defaults(isolated_config_dir):
    result = rc.load_repo_config("nonexistent")
    assert result == {"hooks": {}}


def test_get_hook_missing_file_returns_none(isolated_config_dir):
    assert rc.get_hook("nonexistent", "post_step") is None


# ─── Well-formed YAML → config loaded ────────────────────────────────────────

def test_valid_yaml_loads_correctly(isolated_config_dir):
    _write_config(isolated_config_dir, "myrepo", textwrap.dedent("""\
        hooks:
          post_step: pytest
          on_circuit_open: make test
    """))
    result = rc.load_repo_config("myrepo")
    assert result["hooks"]["post_step"] == "pytest"
    assert result["hooks"]["on_circuit_open"] == "make test"


def test_get_hook_returns_configured_command(isolated_config_dir):
    _write_config(isolated_config_dir, "myrepo", "hooks:\n  post_step: pytest\n")
    assert rc.get_hook("myrepo", "post_step") == "pytest"


def test_get_hook_with_args_allowed(isolated_config_dir):
    """Hook commands with extra args that start with allowed prefix are OK."""
    _write_config(isolated_config_dir, "myrepo", "hooks:\n  post_step: 'npm test --watch'\n")
    # npm test --watch starts with "npm test " → allowed
    result = rc.load_repo_config("myrepo")
    assert result["hooks"]["post_step"] == "npm test --watch"


# ─── Disallowed hook commands ─────────────────────────────────────────────────

def test_disallowed_command_raises(isolated_config_dir):
    _write_config(isolated_config_dir, "evil", "hooks:\n  post_step: 'rm -rf /'\n")
    with pytest.raises(ValueError, match="not allowed"):
        rc.load_repo_config("evil")


def test_sneaky_prefixed_command_raises(isolated_config_dir):
    """'npm test-evil' must NOT be allowed — not the same token as 'npm test'."""
    _write_config(isolated_config_dir, "evil", "hooks:\n  post_step: 'npm test-evil'\n")
    with pytest.raises(ValueError, match="not allowed"):
        rc.load_repo_config("evil")


def test_get_hook_unknown_hook_name_returns_none(isolated_config_dir):
    assert rc.get_hook("myrepo", "unknown_hook") is None


# ─── Extra config fields preserved ───────────────────────────────────────────

def test_extra_yaml_fields_preserved(isolated_config_dir):
    _write_config(isolated_config_dir, "myrepo", textwrap.dedent("""\
        version: 2
        hooks:
          post_step: pytest
        custom_field: hello
    """))
    result = rc.load_repo_config("myrepo")
    assert result.get("version") == 2
    assert result.get("custom_field") == "hello"


# ─── Sprint C2: pre_step hook invocation and warn-not-abort behavior ──────────

def test_pre_step_hook_configured_and_invocable(isolated_config_dir):
    """pre_step hook is in KNOWN_HOOK_NAMES and can be retrieved via get_hook."""
    _write_config(isolated_config_dir, "myrepo", textwrap.dedent("""\
        hooks:
          pre_step: pytest
    """))
    assert rc.get_hook("myrepo", "pre_step") == "pytest"


def test_pre_step_hook_missing_returns_none(isolated_config_dir):
    """No pre_step configured → get_hook returns None."""
    _write_config(isolated_config_dir, "myrepo", textwrap.dedent("""\
        hooks:
          post_step: pytest
    """))
    assert rc.get_hook("myrepo", "pre_step") is None


def test_run_hook_pre_step_success_returns_zero(isolated_config_dir, monkeypatch):
    """run_hook pre_step with a successful command returns returncode 0."""
    import subprocess as _subprocess

    _write_config(isolated_config_dir, "myrepo", textwrap.dedent("""\
        hooks:
          pre_step: pytest
    """))

    fake_result = _subprocess.CompletedProcess(
        args=["pytest"], returncode=0, stdout="ok", stderr=""
    )
    monkeypatch.setattr(_subprocess, "run", lambda *a, **kw: fake_result)

    result = rc.run_hook("myrepo", "pre_step")
    assert result is not None
    assert result["returncode"] == 0


def test_run_hook_pre_step_failure_returns_nonzero(isolated_config_dir, monkeypatch):
    """run_hook pre_step with a failing command returns returncode != 0."""
    import subprocess as _subprocess

    _write_config(isolated_config_dir, "myrepo", textwrap.dedent("""\
        hooks:
          pre_step: pytest
    """))

    fake_result = _subprocess.CompletedProcess(
        args=["pytest"], returncode=1, stdout="FAILED", stderr="error text"
    )
    monkeypatch.setattr(_subprocess, "run", lambda *a, **kw: fake_result)

    result = rc.run_hook("myrepo", "pre_step")
    assert result is not None
    assert result["returncode"] == 1
    assert "FAILED" in result["stdout"] or "error" in result["stderr"]


def test_run_hook_not_configured_returns_none(isolated_config_dir):
    """run_hook returns None when hook is not configured in repo config."""
    _write_config(isolated_config_dir, "myrepo", textwrap.dedent("""\
        hooks: {}
    """))
    assert rc.run_hook("myrepo", "pre_step") is None

