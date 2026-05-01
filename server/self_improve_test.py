from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from server.self_improve import Improvement, SelfImprovementEngine


class FakeLedger:
    def __init__(self) -> None:
        self.stats = [
            {"outcome": "failed", "error_summary": "CSS styles mismatch"},
            {"outcome": "failed", "error_summary": "css style regression"},
        ]

    def get_agent_believability(self) -> dict[str, float]:
        return {"WORKER": 0.25}

    def get_mission_stats(self, limit: int = 100) -> list[dict]:
        return self.stats[-limit:]


class FakeMetrics:
    @staticmethod
    def get_step_latency_stats() -> dict:
        return {
            "count": 3,
            "by_agent": {"SCOUT": {"p95": 130.0, "count": 3}},
        }


def test_reflect_detects_pattern_from_ledger_fixture(tmp_path: Path) -> None:
    engine = SelfImprovementEngine(repo_root=tmp_path, ledger=FakeLedger(), metrics_module=FakeMetrics)

    patterns = engine.reflect()

    assert patterns
    assert any(pattern.kind == "low_believability" for pattern in patterns)
    assert any(pattern.kind == "repeated_failure_term" for pattern in patterns)


def test_propose_improvement_returns_valid_scoped_schema(tmp_path: Path) -> None:
    engine = SelfImprovementEngine(repo_root=tmp_path, ledger=FakeLedger(), metrics_module=FakeMetrics)
    pattern = next(p for p in engine.reflect() if p.kind == "repeated_failure_term")

    improvement = engine.propose_improvement(pattern)

    improvement.validate_scope()
    assert improvement.target_type == "keyword"
    assert improvement.file_path == "server/step_executor.py"
    assert improvement.payload["list_name"] == "WORKER_KEYWORDS"
    assert improvement.payload["keyword"] == "styles"


def test_validate_in_sandbox_runs_pytest_in_temporary_worktree(monkeypatch, tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / "server").mkdir(parents=True)
    (repo / "server" / "step_executor.py").write_text(
        'WORKER_KEYWORDS: list[str] = [\n    "fix",\n]\n',
        encoding="utf-8",
    )
    calls: list[list[str]] = []

    def fake_run(command, cwd=None, capture_output=True, text=True, timeout=None):
        calls.append(list(command))
        if command[:3] == ["/usr/bin/git", "worktree", "add"]:
            worktree = Path(command[-2])
            (worktree / "server").mkdir(parents=True)
            (worktree / "server" / "step_executor.py").write_text(
                'WORKER_KEYWORDS: list[str] = [\n    "fix",\n]\n',
                encoding="utf-8",
            )
            return subprocess.CompletedProcess(command, 0, "", "")
        return subprocess.CompletedProcess(command, 0, "ok", "")

    monkeypatch.setattr("server.self_improve.shutil.which", lambda name: "/usr/bin/git" if name == "git" else None)
    monkeypatch.setattr("server.self_improve.subprocess.run", fake_run)
    engine = SelfImprovementEngine(
        repo_root=repo,
        ledger=FakeLedger(),
        metrics_module=FakeMetrics,
        pytest_command=["python", "-m", "pytest", "server/"],
    )
    improvement = Improvement(
        id="test",
        target_type="keyword",
        file_path="server/step_executor.py",
        description="test",
        payload={"list_name": "WORKER_KEYWORDS", "keyword": "styles"},
    )

    result = engine.validate_in_sandbox(improvement)

    assert result.ok is True
    assert improvement.validated is True
    assert ["python", "-m", "pytest", "server/"] in calls


def test_apply_if_approved_does_not_persist_without_approval(tmp_path: Path) -> None:
    (tmp_path / "server").mkdir()
    target = tmp_path / "server" / "step_executor.py"
    target.write_text('WORKER_KEYWORDS: list[str] = [\n    "fix",\n]\n', encoding="utf-8")
    engine = SelfImprovementEngine(repo_root=tmp_path, ledger=FakeLedger(), metrics_module=FakeMetrics)
    improvement = Improvement(
        id="no-approve",
        target_type="keyword",
        file_path="server/step_executor.py",
        description="test",
        payload={"list_name": "WORKER_KEYWORDS", "keyword": "styles"},
        validated=True,
    )

    result = engine.apply_if_approved(improvement, approved=False)

    assert result.applied is False
    assert "styles" not in target.read_text(encoding="utf-8")


def test_structural_files_are_rejected(tmp_path: Path) -> None:
    improvement = Improvement(
        id="bad",
        target_type="keyword",
        file_path="server/task_orchestrator.py",
        description="bad",
        payload={"list_name": "X", "keyword": "y"},
    )
    with pytest.raises(ValueError):
        improvement.validate_scope()
