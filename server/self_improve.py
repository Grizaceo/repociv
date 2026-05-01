"""RepoCiv — Fase 5 SICA self-improvement engine.

The engine proposes small, scoped changes from ledger/metric patterns. It never
applies changes to the live repository unless the caller passes explicit human
approval.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import metrics as _metrics
from . import research_ledger as _research_ledger


ALLOWED_TARGET_TYPES = {
    "prompt_template",
    "keyword",
    "numeric_weight",
    "routing_table",
    "security_rule",
    "ioc_list",
}

ALLOWED_FILES = {
    "server/agent_runner.py",
    "server/step_executor.py",
    "server/scheduler.py",
    "server/model_router.py",
    "server/security_harness.py",
    "shared/priority-weights.json",
}

PROHIBITED_FILES = {
    "server/bridge.py",
    "server/event_store.py",
    "server/task_orchestrator.py",
}


@dataclass(frozen=True)
class ImprovementPattern:
    """A reproducible pattern discovered from telemetry."""

    kind: str
    summary: str
    evidence: dict[str, Any] = field(default_factory=dict)
    confidence: float = 0.5


@dataclass
class Improvement:
    """A scoped SICA proposal that can be sandboxed before application."""

    id: str
    target_type: str
    file_path: str
    description: str
    payload: dict[str, Any] = field(default_factory=dict)
    rationale: str = ""
    validated: bool = False
    validation_output: str = ""

    def validate_scope(self) -> None:
        if self.target_type not in ALLOWED_TARGET_TYPES:
            raise ValueError(f"Unsupported improvement target: {self.target_type}")
        if self.file_path in PROHIBITED_FILES:
            raise ValueError(f"SICA cannot modify structural file: {self.file_path}")
        if self.file_path not in ALLOWED_FILES:
            raise ValueError(f"SICA target outside approved scope: {self.file_path}")


@dataclass(frozen=True)
class SandboxResult:
    ok: bool
    worktree_path: str
    command: list[str]
    output: str = ""
    returncode: int | None = None


@dataclass(frozen=True)
class ApplyResult:
    applied: bool
    reason: str
    file_path: str = ""


class SelfImprovementEngine:
    """Reflect → propose → sandbox → human-approved apply loop."""

    def __init__(
        self,
        *,
        repo_root: str | Path | None = None,
        ledger: Any | None = None,
        metrics_module: Any | None = None,
        pytest_command: list[str] | None = None,
    ) -> None:
        self.repo_root = Path(repo_root or Path(__file__).resolve().parents[1])
        self.ledger = ledger if ledger is not None else _research_ledger.get_ledger()
        self.metrics = metrics_module if metrics_module is not None else _metrics
        self.pytest_command = pytest_command or ["python", "-m", "pytest", "server/"]

    def reflect(self) -> list[ImprovementPattern]:
        """Read ledger + latency metrics and return reproducible patterns."""
        patterns: list[ImprovementPattern] = []

        believability = {}
        if hasattr(self.ledger, "get_agent_believability"):
            believability = self.ledger.get_agent_believability() or {}
        for agent, score in believability.items():
            if float(score) < 0.5:
                patterns.append(ImprovementPattern(
                    kind="low_believability",
                    summary=f"{agent} believability is below 50%",
                    evidence={"agent": agent, "believability": float(score)},
                    confidence=round(1.0 - float(score), 3),
                ))

        stats = []
        if hasattr(self.ledger, "get_mission_stats"):
            stats = self.ledger.get_mission_stats(limit=100) or []
        failure_terms: dict[str, int] = {}
        for row in stats:
            if str(row.get("outcome", "")).lower() not in {"failed", "rejected"}:
                continue
            text = f"{row.get('phase', '')} {row.get('error_summary', '')}".lower()
            for term in ("css", "style", "docker", "security"):
                if term in text:
                    failure_terms[term] = failure_terms.get(term, 0) + 1
        for term, count in failure_terms.items():
            if count >= 2:
                patterns.append(ImprovementPattern(
                    kind="repeated_failure_term",
                    summary=f"Repeated failed missions mention {term!r}",
                    evidence={"term": term, "failures": count},
                    confidence=min(0.95, 0.4 + count * 0.15),
                ))

        latency = {}
        if hasattr(self.metrics, "get_step_latency_stats"):
            latency = self.metrics.get_step_latency_stats() or {}
        for agent, data in (latency.get("by_agent") or {}).items():
            if data.get("count", 0) >= 3 and float(data.get("p95", 0.0)) > 120.0:
                patterns.append(ImprovementPattern(
                    kind="high_latency",
                    summary=f"{agent} p95 step latency exceeds 120s",
                    evidence={"agent": agent, "p95": data.get("p95"), "count": data.get("count")},
                    confidence=0.65,
                ))

        return patterns

    def propose_improvement(self, pattern: ImprovementPattern) -> Improvement:
        """Create a valid, scoped proposal for an observed pattern."""
        if pattern.kind == "repeated_failure_term":
            term = str(pattern.evidence.get("term", "")).lower()
            keyword = "styles" if term in {"css", "style"} else term
            improvement = Improvement(
                id=f"sica-keyword-{keyword}",
                target_type="keyword",
                file_path="server/step_executor.py",
                description=f"Route recurring {term} work to WORKER via keyword heuristic",
                payload={"list_name": "WORKER_KEYWORDS", "keyword": keyword},
                rationale=pattern.summary,
            )
        elif pattern.kind == "high_latency":
            improvement = Improvement(
                id="sica-scout-latency-keyword",
                target_type="keyword",
                file_path="server/step_executor.py",
                description="Prefer SCOUT for profiling/latency diagnostics",
                payload={"list_name": "SCOUT_KEYWORDS", "keyword": "latency"},
                rationale=pattern.summary,
            )
        else:
            agent = str(pattern.evidence.get("agent", "WORKER")).upper()
            keyword = "verify" if agent == "WORKER" else "review"
            list_name = "WORKER_KEYWORDS" if agent == "WORKER" else "SCOUT_KEYWORDS"
            improvement = Improvement(
                id=f"sica-{agent.lower()}-keyword-{keyword}",
                target_type="keyword",
                file_path="server/step_executor.py",
                description=f"Improve {agent} dispatch heuristic with keyword {keyword!r}",
                payload={"list_name": list_name, "keyword": keyword},
                rationale=pattern.summary,
            )

        improvement.validate_scope()
        return improvement

    def validate_in_sandbox(self, improvement: Improvement) -> SandboxResult:
        """Apply the proposal in a temporary git worktree and run pytest."""
        improvement.validate_scope()
        git = shutil.which("git")
        if git is None:
            raise RuntimeError("git is required for SICA sandbox validation")

        temp_parent = Path(tempfile.mkdtemp(prefix="repociv-sica-"))
        worktree = temp_parent / "worktree"
        command = self.pytest_command
        try:
            add = subprocess.run(
                [git, "worktree", "add", "--detach", str(worktree), "HEAD"],
                cwd=str(self.repo_root),
                capture_output=True,
                text=True,
                timeout=60,
            )
            if add.returncode != 0:
                return SandboxResult(False, str(worktree), command, add.stdout + add.stderr, add.returncode)

            self._apply_to_root(improvement, worktree)
            test = subprocess.run(
                command,
                cwd=str(worktree),
                capture_output=True,
                text=True,
                timeout=600,
            )
            output = test.stdout + test.stderr
            improvement.validated = test.returncode == 0
            improvement.validation_output = output[-4000:]
            return SandboxResult(test.returncode == 0, str(worktree), command, output, test.returncode)
        finally:
            subprocess.run(
                [git, "worktree", "remove", "--force", str(worktree)],
                cwd=str(self.repo_root),
                capture_output=True,
                text=True,
                timeout=60,
            )
            shutil.rmtree(temp_parent, ignore_errors=True)

    def apply_if_approved(
        self,
        improvement: Improvement,
        *,
        approved: bool = False,
        require_validated: bool = True,
    ) -> ApplyResult:
        """Apply only after explicit human approval and sandbox validation."""
        improvement.validate_scope()
        if not approved:
            return ApplyResult(False, "explicit approval required", improvement.file_path)
        if require_validated and not improvement.validated:
            return ApplyResult(False, "sandbox validation required", improvement.file_path)
        self._apply_to_root(improvement, self.repo_root)
        return ApplyResult(True, "applied", improvement.file_path)

    def _apply_to_root(self, improvement: Improvement, root: Path) -> None:
        if improvement.target_type != "keyword":
            raise NotImplementedError(
                "Fase 5 MVP applies keyword improvements only; other scoped targets "
                "are schema-valid proposals for later human implementation."
            )
        path = root / improvement.file_path
        content = path.read_text(encoding="utf-8")
        new_content = self._apply_keyword(content, improvement.payload)
        if new_content != content:
            path.write_text(new_content, encoding="utf-8")

    @staticmethod
    def _apply_keyword(content: str, payload: dict[str, Any]) -> str:
        list_name = str(payload.get("list_name", ""))
        keyword = str(payload.get("keyword", "")).strip().lower()
        if not list_name or not keyword:
            raise ValueError("keyword improvement requires list_name and keyword")
        if f'"{keyword}"' in content or f"'{keyword}'" in content:
            return content

        marker = f"{list_name}: list[str] = ["
        start = content.find(marker)
        if start < 0:
            raise ValueError(f"List {list_name!r} not found")
        end = content.find("]", start)
        if end < 0:
            raise ValueError(f"List {list_name!r} is not closed")
        insertion = f'    "{keyword}",\n'
        return content[:end] + insertion + content[end:]
