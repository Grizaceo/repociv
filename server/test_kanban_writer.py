"""Native board creation validation and CLI integration in isolated storage."""
from __future__ import annotations

import json
import shutil
import subprocess
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from server import kanban_writer as writer


@pytest.fixture
def setup(tmp_path, monkeypatch):
    root = tmp_path / "kanban"
    root.mkdir()
    (root / "current").write_text("other")
    project = tmp_path / "project with spaces"
    project.mkdir()
    monkeypatch.setenv("REPOCIV_KANBAN_DIR", str(root))
    cli = shutil.which("hermes")
    monkeypatch.setattr(writer.shutil, "which", lambda _: cli or "/test/hermes")
    return root, {"slug": "project-board", "name": "Project Board", "project_path": str(project)}


@pytest.mark.parametrize("slug", ["../escape", "UPPER", "a b", "default", "-x", "a;touch x", "", "a" * 65])
def test_invalid_slug_never_calls_cli(setup, monkeypatch, slug):
    _, body = setup
    run = Mock()
    monkeypatch.setattr(writer.subprocess, "run", run)
    body["slug"] = slug
    assert writer.post_kanban_board(body, {})[0] == 400
    run.assert_not_called()


def test_invalid_body_and_project(setup):
    _, body = setup
    assert writer.post_kanban_board([], {})[0] == 400
    for field, value in [("name", ""), ("name", "x\n"), ("project_path", "relative"), ("project_path", "/definitely-not-a-project")]:
        assert writer.post_kanban_board(dict(body, **{field: value}), {})[0] == 400


def test_duplicate_not_modified(setup, monkeypatch):
    root, body = setup
    existing = root / "boards" / body["slug"]
    existing.mkdir(parents=True)
    (existing / "board.json").write_text('{"name":"Keep me"}')
    run = Mock()
    monkeypatch.setattr(writer.subprocess, "run", run)
    assert writer.post_kanban_board(body, {})[0] == 409
    assert (existing / "board.json").read_text() == '{"name":"Keep me"}'
    run.assert_not_called()


@pytest.mark.parametrize("failure, status", [(subprocess.TimeoutExpired("hermes", 30), 504), (OSError("private diagnostic"), 503)])
def test_cli_failure_is_safe(setup, monkeypatch, failure, status):
    _, body = setup
    monkeypatch.setattr(writer.subprocess, "run", Mock(side_effect=failure))
    code, result = writer.post_kanban_board(body, {})
    assert code == status
    assert "private diagnostic" not in json.dumps(result)


def test_nonzero_and_unverified_creation(setup, monkeypatch):
    _, body = setup
    monkeypatch.setattr(writer.subprocess, "run", Mock(return_value=SimpleNamespace(returncode=1)))
    assert writer.post_kanban_board(body, {})[0] == 502
    monkeypatch.setattr(writer.subprocess, "run", Mock(return_value=SimpleNamespace(returncode=0)))
    assert writer.post_kanban_board(body, {})[0] == 502


@pytest.mark.skipif(shutil.which("hermes") is None, reason="Native Hermes CLI not installed")
def test_real_cli_creates_shared_board_without_switching(setup):
    root, body = setup
    # Actual supported CLI, actual schema/metadata, no user-store mutation.
    code, result = writer.post_kanban_board(body, {})
    assert code == 201, result
    assert result["board"]["slug"] == body["slug"]
    assert result["board"]["available"] is True
    assert all(not tasks for tasks in result["board"]["columns"].values())
    meta = json.loads((root / "boards" / body["slug"] / "board.json").read_text())
    assert meta["name"] == body["name"]
    assert meta["default_workdir"] == body["project_path"]
    assert (root / "current").read_text() == "other"
    assert writer.post_kanban_board(body, {})[0] == 409
