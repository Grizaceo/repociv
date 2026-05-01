"""Tests for server/swarm_engine.py — Fase 3 consensus engine."""
from __future__ import annotations

from server.swarm_engine import ConsensusEngine
from server.swarm_schemas import AgentSignal, SwarmDebateResult


class FakeLedger:
    def __init__(self, believability: dict[str, float] | None = None) -> None:
        self.believability = believability or {}
        self.predictions: list[dict] = []

    def get_agent_believability(self) -> dict[str, float]:
        return dict(self.believability)

    def record_prediction(self, **kwargs) -> None:
        self.predictions.append(kwargs)


def test_consensus_engine_aggregates_three_signals_proceed() -> None:
    ledger = FakeLedger()
    engine = ConsensusEngine(ledger=ledger)

    result = engine.debate(
        mission_id="m1",
        mission_text="Implement a small helper",
        step="Create helper module",
        agent_output="Done.",
    )

    assert result.decision == "PROCEED"
    assert len(result.signals) == 3
    assert result.normalized_score > 0.2
    assert len(ledger.predictions) == 3


def test_consensus_engine_discards_security_risk() -> None:
    engine = ConsensusEngine(ledger=FakeLedger())

    result = engine.debate(
        mission_id="m2",
        mission_text="Add integration",
        step="Store api_key='abc123456789012345' in config",
        agent_output="Done.",
    )

    assert result.decision == "DISCARD"
    assert any("secret-like-value" in s.risk_flags for s in result.signals)


def test_believability_changes_weighted_vote() -> None:
    signals = [
        AgentSignal(agent_name="CodeReview", vote="PROCEED", confidence=0.9),
        AgentSignal(agent_name="Security", vote="DISCARD", confidence=0.9),
        AgentSignal(agent_name="Architecture", vote="PROCEED", confidence=0.9),
    ]
    trusted_security = ConsensusEngine(
        ledger=FakeLedger({"SECURITY": 1.0, "CODEREVIEW": 0.1, "ARCHITECTURE": 0.1}),
    )
    weak_security = ConsensusEngine(
        ledger=FakeLedger({"SECURITY": 0.1, "CODEREVIEW": 1.0, "ARCHITECTURE": 1.0}),
    )

    assert trusted_security._calculate_weighted_vote(signals) < 0
    assert weak_security._calculate_weighted_vote(signals) > 0


def test_swarm_debate_result_serializes_with_pydantic() -> None:
    result = SwarmDebateResult(
        mission_id="m3",
        decision="PROCEED",
        normalized_score=0.75,
        signals=[
            AgentSignal(
                agent_name="CodeReview",
                vote="PROCEED",
                confidence=0.8,
                rationale="looks good",
            ),
        ],
        context_directive_text="Swarm debate decision: PROCEED",
    )

    payload = result.model_dump(mode="json")
    assert payload["mission_id"] == "m3"
    assert payload["signals"][0]["agent_name"] == "CodeReview"
    assert "created_at" in payload

