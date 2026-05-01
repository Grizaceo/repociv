"""RepoCiv — Fase 3: Swarm Engine schemas.

Pydantic models keep debate outputs validated and easy to persist as JSON
artifacts or ContextDirective text.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


SwarmVote = Literal["PROCEED", "DISCARD", "ABSTAIN"]
SwarmDecision = Literal["PROCEED", "DISCARD"]


class AgentSignal(BaseModel):
    """A single specialist's structured vote in a swarm debate."""

    agent_name: str = Field(min_length=1)
    vote: SwarmVote
    confidence: float = Field(ge=0.0, le=1.0)
    rationale: str = ""
    risk_flags: list[str] = Field(default_factory=list)


class SwarmDebateResult(BaseModel):
    """Aggregated decision emitted by the ConsensusEngine."""

    mission_id: str = Field(min_length=1)
    decision: SwarmDecision
    normalized_score: float = Field(ge=-1.0, le=1.0)
    signals: list[AgentSignal] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    context_directive_text: str = ""

