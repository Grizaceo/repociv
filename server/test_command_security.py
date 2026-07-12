from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from server import agent_runner, repo_roots_state, sessions
from server.command_schema import CommandValidationError, validate_command
from server.policy import apply_policy
from server.routes.core import _validate_command_target


def encode_repo_id(path: Path) -> str:
    encoded = base64.urlsafe_b64encode(str(path).encode()).decode().rstrip("=")
    return f"repo:{encoded}"


def write_selection_state(path: Path, root: Path, selected: list[Path]) -> None:
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "activeRoot": str(root),
                "roots": {
                    str(root): {
                        "selectedRepoPaths": [str(item) for item in selected],
                        "addedAt": "2026-07-12T00:00:00Z",
                        "lastSeen": "2026-07-12T00:00:00Z",
                    }
                },
            }
        ),
        encoding="utf-8",
    )


def test_unknown_command_type_is_rejected():
    with pytest.raises(CommandValidationError, match="unknown command type"):
        validate_command({"type": "shell_anything", "target": "main", "payload": {}})


def test_nested_payload_strings_are_bounded():
    with pytest.raises(CommandValidationError, match="payload string exceeds"):
        validate_command(
            {
                "type": "inspect_repo",
                "target": "main",
                "payload": {"nested": {"value": "x" * 5000}},
            }
        )


def test_client_cannot_downgrade_server_owned_risk():
    command = validate_command(
        {"type": "delete_file", "target": "main", "risk": "low", "payload": {}}
    )
    assert command.risk == "destructive"


def test_execute_agent_risk_depends_on_server_visible_effects():
    conversational = validate_command(
        {
            "type": "execute_agent",
            "target": "main",
            "payload": {"unit": "MAIN", "mission": "Explain status", "harness": "hermes"},
        }
    )
    repository_task = validate_command(
        {
            "type": "execute_agent",
            "target": "repo-a",
            "payload": {
                "unit": "WORKER",
                "mission": "Edit the implementation",
                "harness": "claude",
                "repoPath": "/workspace/repo-a",
            },
        }
    )
    assert conversational.risk == "low"
    assert repository_task.risk in {"medium", "high"}
    conversational, _ = apply_policy(conversational)
    repository_task, _ = apply_policy(repository_task)
    assert conversational.requires_approval is False
    assert repository_task.requires_approval is True


def test_command_target_validation_fails_fast_on_unselected_or_repo_less_cli(
    monkeypatch, tmp_path: Path
):
    root = tmp_path / "root"
    selected = root / "selected"
    unselected = root / "unselected"
    selected.mkdir(parents=True)
    unselected.mkdir()
    state_file = tmp_path / "state.json"
    write_selection_state(state_file, root, [selected])
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state_file))

    valid = validate_command(
        {
            "type": "execute_agent",
            "target": "selected",
            "payload": {
                "unit": "WORKER",
                "mission": "Inspect",
                "repoPath": str(selected),
            },
        }
    )
    assert _validate_command_target(valid) is None
    assert valid.payload["repoPath"] == str(selected.resolve())

    invalid = validate_command(
        {
            "type": "execute_agent",
            "target": "unselected",
            "payload": {
                "unit": "WORKER",
                "mission": "Inspect",
                "repoPath": str(unselected),
            },
        }
    )
    assert "selected" in (_validate_command_target(invalid) or "")

    repo_less_cli = validate_command(
        {
            "type": "execute_agent",
            "target": "main",
            "payload": {"unit": "CLAUDE", "mission": "Inspect", "harness": "claude"},
        }
    )
    assert "repoPath" in (_validate_command_target(repo_less_cli) or "")


def test_execute_agent_rejects_unsafe_unit_identifier():
    with pytest.raises(CommandValidationError, match="safe unit"):
        validate_command(
            {
                "type": "execute_agent",
                "target": "main",
                "payload": {"unit": "../../escape", "mission": "hello"},
            }
        )


def test_session_unit_id_cannot_escape_store(tmp_path: Path):
    sessions.init(tmp_path)
    with pytest.raises(ValueError, match="invalid unit id"):
        sessions.get_or_create("../../escape")
    assert not (tmp_path.parent / "escape").exists()


def test_agent_workdir_requires_persisted_selection(monkeypatch, tmp_path: Path):
    root = tmp_path / "root"
    selected = root / "selected"
    unselected = root / "unselected"
    selected.mkdir(parents=True)
    unselected.mkdir()
    state_file = tmp_path / "state.json"
    write_selection_state(state_file, root, [selected])
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state_file))

    assert agent_runner.resolve_agent_working_dir(encode_repo_id(selected)) == str(
        selected.resolve()
    )
    assert agent_runner.resolve_agent_working_dir(encode_repo_id(unselected)) is None
    assert agent_runner.resolve_agent_working_dir("selected", str(selected)) == str(
        selected.resolve()
    )


def test_selected_symlink_escape_is_rejected(monkeypatch, tmp_path: Path):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    link = root / "linked"
    link.symlink_to(outside, target_is_directory=True)
    state_file = tmp_path / "state.json"
    write_selection_state(state_file, root, [link])
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state_file))

    assert repo_roots_state.resolve_selected_repo(encode_repo_id(link)) is None
    assert agent_runner.resolve_agent_working_dir(encode_repo_id(link)) is None


def test_file_path_cannot_escape_selected_repo(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    with pytest.raises(ValueError, match="outside selected repo"):
        agent_runner.resolve_absolute_file_path(str(repo), "../secret.txt")
    with pytest.raises(ValueError, match="outside selected repo"):
        agent_runner.resolve_absolute_file_path(str(repo), str(tmp_path / "secret.txt"))


def test_security_gate_runs_before_default_adapter(monkeypatch, tmp_path: Path):
    class BlockingHarness:
        def pre_dispatch_gate(self, mission):
            class Result:
                blocked = True
                reason = "blocked by test"

            return Result()

    called = {"hermes": False}
    monkeypatch.setattr(agent_runner._security_harness, "get_harness", lambda: BlockingHarness())
    monkeypatch.setattr(agent_runner, "_get_agent_config", lambda _unit: {})
    monkeypatch.setattr(agent_runner._es, "record_output_chunk", lambda *_args: None)
    monkeypatch.setattr(agent_runner, "send_to_repociv", lambda *_args: None)
    monkeypatch.setattr(
        agent_runner,
        "_run_hermes_streaming",
        lambda *_args, **_kwargs: called.__setitem__("hermes", True),
    )

    ok, output = agent_runner._execute_streaming(
        "MAIN", "m-1", "blocked mission", str(tmp_path), "repo-a"
    )
    assert ok is False
    assert "security blocked" in output
    assert called["hermes"] is False


def test_repo_less_main_never_falls_back_to_cli(monkeypatch):
    class CleanHarness:
        def pre_dispatch_gate(self, mission):
            class Result:
                blocked = False
                reason = ""

            return Result()

    monkeypatch.setattr(agent_runner._security_harness, "get_harness", lambda: CleanHarness())
    monkeypatch.setattr(agent_runner, "_get_agent_config", lambda _unit: {})
    monkeypatch.setattr(
        agent_runner,
        "_run_hermes_streaming",
        lambda *_args, **_kwargs: (False, "gateway unavailable"),
    )
    monkeypatch.setattr(
        agent_runner,
        "_run_claude_code_streaming",
        lambda *_args, **_kwargs: pytest.fail("CLI fallback must not run without selected repo"),
    )

    ok, output = agent_runner._execute_streaming(
        "MAIN", "m-2", "conversation", None, "main", harness=""
    )
    assert ok is False
    assert output == "gateway unavailable"
