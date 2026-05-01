"""RepoCiv — Fase 3: deterministic multi-agent consensus engine.

This is the first, cheap version of the swarm: specialists are structured,
deterministic reviewers. They can later be swapped for LLM-backed agents without
changing the Pydantic contracts or ledger integration.
"""
from __future__ import annotations

import re
from typing import Any, Protocol

from . import research_ledger as _rl
from .swarm_schemas import AgentSignal, SwarmDebateResult


_VOTE_VALUE = {
    "PROCEED": 1.0,
    "DISCARD": -1.0,
    "ABSTAIN": 0.0,
}

_DEFAULT_BASE_WEIGHTS: dict[str, float] = {
    "CodeReview": 1.0,
    "Security": 1.25,
    "Architecture": 1.0,
}

_DEFAULT_SUCCESS_MEMORY: dict[str, float] = {
    "CodeReview": 1.0,
    "Security": 1.0,
    "Architecture": 1.0,
}

_SECRET_RE = re.compile(
    r"(api[_-]?key|secret|token|password)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{12,}",
    re.IGNORECASE,
)


class BelievabilityLedger(Protocol):
    """Small ledger protocol used by the engine and by tests."""

    def get_agent_believability(self) -> dict[str, float]:
        ...

    def record_prediction(
        self,
        *,
        mission_id: str,
        agent_name: str,
        predicted_outcome: str,
        confidence: float,
        actual_outcome: str | None = None,
        is_correct: bool | None = None,
    ) -> None:
        ...


class SpecialistAgent:
    """Rule-based reviewer that emits one structured signal."""

    def __init__(self, name: str) -> None:
        self.name = name

    def analyze(
        self,
        *,
        mission_text: str,
        step: str,
        agent_output: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> AgentSignal:
        text = "\n".join([mission_text, step, agent_output]).lower()
        if self.name == "Security":
            return self._security_signal(text)
        if self.name == "Architecture":
            return self._architecture_signal(text, metadata or {})
        return self._code_review_signal(text)

    def _code_review_signal(self, text: str) -> AgentSignal:
        flags: list[str] = []
        if any(marker in text for marker in ("traceback", "exception", "failed", "error:")):
            flags.append("execution-error")
        if "syntaxerror" in text or "importerror" in text:
            flags.append("runtime-breakage")
        if flags:
            return AgentSignal(
                agent_name=self.name,
                vote="DISCARD",
                confidence=0.82,
                rationale="Detected failure markers in the worker output.",
                risk_flags=flags,
            )
        return AgentSignal(
            agent_name=self.name,
            vote="PROCEED",
            confidence=0.62,
            rationale="No obvious execution or code-quality failure markers.",
        )

    def _security_signal(self, text: str) -> AgentSignal:
        flags: list[str] = []
        if _SECRET_RE.search(text):
            flags.append("secret-like-value")
        if any(marker in text for marker in ("read .env", "cat .env", "~/.ssh", "private key")):
            flags.append("secret-access")
        if any(marker in text for marker in ("curl http", "wget http", "exfiltrat")):
            flags.append("network-exfiltration")
        if flags:
            return AgentSignal(
                agent_name=self.name,
                vote="DISCARD",
                confidence=0.95,
                rationale="Security risk pattern found in mission or output.",
                risk_flags=flags,
            )
        return AgentSignal(
            agent_name=self.name,
            vote="PROCEED",
            confidence=0.58,
            rationale="No high-risk security pattern found.",
        )

    def _architecture_signal(self, text: str, metadata: dict[str, Any]) -> AgentSignal:
        flags: list[str] = []
        changed_files = [str(p) for p in metadata.get("changed_files", [])]
        critical_file = any(
            p.startswith("server/") or p.startswith("src/core/") for p in changed_files
        )
        broad_refactor = "refactor" in text and any(
            marker in text for marker in ("core", "orchestrator", "router", "ledger")
        )
        if critical_file or broad_refactor:
            flags.append("critical-surface")
            return AgentSignal(
                agent_name=self.name,
                vote="ABSTAIN",
                confidence=0.54,
                rationale="Critical surface touched; human-facing artifact should be retained.",
                risk_flags=flags,
            )
        return AgentSignal(
            agent_name=self.name,
            vote="PROCEED",
            confidence=0.55,
            rationale="No architectural boundary risk detected.",
        )


class ConsensusEngine:
    """Weighted specialist consensus using ledger believability and success memory."""

    def __init__(
        self,
        *,
        ledger: BelievabilityLedger | None = None,
        specialists: list[SpecialistAgent] | None = None,
        base_weights: dict[str, float] | None = None,
        success_memory: dict[str, float] | None = None,
        min_proceed_score: float = 0.2,
    ) -> None:
        self.ledger = ledger if ledger is not None else _rl.get_ledger()
        self.specialists = specialists or [
            SpecialistAgent("CodeReview"),
            SpecialistAgent("Security"),
            SpecialistAgent("Architecture"),
        ]
        self.base_weights = dict(_DEFAULT_BASE_WEIGHTS | (base_weights or {}))
        self.success_memory = dict(_DEFAULT_SUCCESS_MEMORY | (success_memory or {}))
        self.min_proceed_score = float(min_proceed_score)

    def _calculate_weighted_vote(self, signals: list[AgentSignal]) -> float:
        """Return a normalized score in [-1, 1]."""
        believability = self.ledger.get_agent_believability() if self.ledger else {}
        direction = 0.0
        magnitude = 0.0
        for signal in signals:
            name = signal.agent_name
            base = float(self.base_weights.get(name, 1.0))
            memory = float(self.success_memory.get(name, 1.0))
            belief = float(believability.get(name.upper(), believability.get(name, 1.0)))
            weight = max(0.0, base * memory * belief * signal.confidence)
            vote_value = _VOTE_VALUE[signal.vote]
            direction += vote_value * weight
            magnitude += abs(weight)
        if magnitude <= 0:
            return 0.0
        return max(-1.0, min(1.0, direction / magnitude))

    def debate(
        self,
        *,
        mission_id: str,
        mission_text: str,
        step: str,
        agent_output: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> SwarmDebateResult:
        """Run all specialists and persist their predictions best-effort."""
        signals = [
            specialist.analyze(
                mission_text=mission_text,
                step=step,
                agent_output=agent_output,
                metadata=metadata or {},
            )
            for specialist in self.specialists
        ]
        score = self._calculate_weighted_vote(signals)
        decision = "PROCEED" if score >= self.min_proceed_score else "DISCARD"
        directive = self._build_context_directive_text(decision, score, signals)
        result = SwarmDebateResult(
            mission_id=mission_id,
            decision=decision,
            normalized_score=score,
            signals=signals,
            context_directive_text=directive,
        )
        self._record_predictions(result)
        return result

    def _record_predictions(self, result: SwarmDebateResult) -> None:
        if self.ledger is None:
            return
        for signal in result.signals:
            self.ledger.record_prediction(
                mission_id=result.mission_id,
                agent_name=signal.agent_name,
                predicted_outcome=signal.vote,
                confidence=signal.confidence,
                actual_outcome=result.decision,
                is_correct=(signal.vote == result.decision),
            )

    def _build_context_directive_text(
        self, decision: str, score: float, signals: list[AgentSignal],
    ) -> str:
        lines = [
            f"Swarm debate decision: {decision}",
            f"Normalized score: {score:.3f}",
            "Specialist signals:",
        ]
        for signal in signals:
            flags = ", ".join(signal.risk_flags) if signal.risk_flags else "none"
            lines.append(
                f"- {signal.agent_name}: {signal.vote} "
                f"(confidence={signal.confidence:.2f}, flags={flags}) - {signal.rationale}"
            )
        return "\n".join(lines)


_singleton: ConsensusEngine | None = None


def get_engine() -> ConsensusEngine:
    """Return the module-level default consensus engine."""
    global _singleton
    if _singleton is None:
        _singleton = ConsensusEngine()
    return _singleton


def set_engine(engine: ConsensusEngine | None) -> None:
    """Override the module-level engine for tests."""
    global _singleton
    _singleton = engine

