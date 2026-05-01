"""Tests for server/world_model.py — Fase 4 World Model."""
from __future__ import annotations

from pathlib import Path

import pytest

from server.tensor_context import (
    DEONTIC_EXCLUDE,
    DEONTIC_MUST,
    ContextDirective,
    TensorContext,
)
from server.world_model import ContextWorldModel


class FakeLedger:
    def __init__(self) -> None:
        self.predictions: list[dict] = []
        self.history: list[dict] = []
        self.samples: list[dict] = []

    def record_world_model_prediction(self, **kwargs) -> None:
        self.predictions.append(kwargs)

    def record_world_model_history(self, **kwargs) -> None:
        self.history.append(kwargs)

    def get_world_model_history(self, limit: int = 500) -> list[dict]:
        return self.history[-limit:]

    def get_world_model_calibration_samples(self, limit: int = 500) -> list[dict]:
        return self.samples[-limit:]


def _dc(text: str, **metadata) -> ContextDirective:
    return ContextDirective(text, metadata=metadata)


def test_shadow_mode_records_without_pruning() -> None:
    ledger = FakeLedger()
    model = ContextWorldModel(ledger=ledger, mode="shadow")
    directives = [
        _dc("relevant context", utility_score=0.9),
        ContextDirective("excluded but shadow keeps original list", deontic=DEONTIC_EXCLUDE),
        _dc("x" * 4_000, utility_score=0.1),
    ]

    result = model.prune_context(directives, max_tokens=10, mission_id="m-shadow")

    assert result == directives
    assert len(ledger.predictions) == len(directives)
    assert {row["mode"] for row in ledger.predictions} == {"shadow"}
    assert all(row["selected"] is True for row in ledger.predictions)


def test_promotion_requires_spearman_and_recall() -> None:
    model = ContextWorldModel(ledger=FakeLedger(), mode="shadow")
    samples = [
        {"dc_id": "a", "fitness_hat": 0.95, "actual_utility": 0.90},
        {"dc_id": "b", "fitness_hat": 0.80, "actual_utility": 0.85},
        {"dc_id": "c", "fitness_hat": 0.60, "actual_utility": 0.50},
        {"dc_id": "d", "fitness_hat": 0.30, "actual_utility": 0.25},
        {"dc_id": "e", "fitness_hat": 0.10, "actual_utility": 0.05},
    ]

    metrics = model.evaluate_promotion(samples)

    assert metrics.passed is True
    assert metrics.spearman_rho >= 0.6
    assert metrics.top_k_recall >= 0.7
    assert model.mode == "active"


def test_calibration_failure_writes_artifact(tmp_path: Path) -> None:
    model = ContextWorldModel(ledger=FakeLedger(), mode="shadow", artifact_dir=tmp_path)
    samples = [
        {"dc_id": "a", "fitness_hat": 0.9, "actual_utility": 0.1},
        {"dc_id": "b", "fitness_hat": 0.8, "actual_utility": 0.2},
        {"dc_id": "c", "fitness_hat": 0.7, "actual_utility": 0.3},
        {"dc_id": "d", "fitness_hat": 0.2, "actual_utility": 0.8},
        {"dc_id": "e", "fitness_hat": 0.1, "actual_utility": 0.9},
    ]

    metrics = model.evaluate_promotion(samples)

    artifact = tmp_path / "world_model_calibration_failure.md"
    assert metrics.passed is False
    assert model.mode == "disabled"
    assert artifact.exists()
    assert "World Model Calibration Failure" in artifact.read_text(encoding="utf-8")


def test_active_mode_reduces_tokens_by_at_least_30_percent() -> None:
    ledger = FakeLedger()
    model = ContextWorldModel(ledger=ledger, mode="active")
    must = ContextDirective("must " * 20, deontic=DEONTIC_MUST)
    useful = _dc("implement world model relevant context " * 20, utility_score=1.0)
    stale = _dc("stale unrelated archive " * 200, utility_score=0.0, age_hours=24 * 20)
    baseline = [must, useful, stale]

    result = model.prune_context(
        baseline,
        max_tokens=max(1, int(model.token_count(baseline) * 0.70)),
        mission="implement world model",
        mission_id="m-active",
    )

    assert must in result
    assert model.token_reduction(baseline, result) >= 0.30
    assert ledger.predictions


def test_archival_compression_marks_old_directives() -> None:
    model = ContextWorldModel(ledger=FakeLedger(), mode="active")
    old = _dc("old context line " * 200, age_hours=24 * 30)
    fresh = _dc("fresh context", age_hours=1)

    compressed = model.compress_archival_directives([old, fresh])

    assert compressed[0].metadata["compressed"] is True
    assert compressed[0].metadata["compression"] == "archival-summary"
    assert len(compressed[0].text) < len(old.text)
    assert compressed[1] == fresh


def test_tensor_context_delegates_only_when_world_model_active() -> None:
    active_model = ContextWorldModel(ledger=FakeLedger(), mode="active")
    shadow_model = ContextWorldModel(ledger=FakeLedger(), mode="shadow")
    huge = _dc("x" * 4_000, utility_score=0.1)
    small = _dc("world model relevant", utility_score=1.0)

    active_result = TensorContext(world_model=active_model).budget_prune([huge, small], max_tokens=20)
    shadow_result = TensorContext(world_model=shadow_model).budget_prune([huge, small], max_tokens=20)

    assert small in active_result
    assert huge not in active_result
    assert shadow_result == [small]


def test_research_ledger_world_model_tables(tmp_path: Path) -> None:
    pytest.importorskip("duckdb", reason="duckdb not installed")
    from server.research_ledger import ResearchLedger

    ledger = ResearchLedger(state_dir=tmp_path)
    ledger.record_world_model_prediction(
        mission_id="m1",
        dc_id="dc1",
        mode="shadow",
        fitness_hat=0.8,
        uncertainty=0.2,
        selected=True,
        predicted_rank=1,
        actual_utility=0.75,
    )
    ledger.record_world_model_history(
        mission_id="m1",
        dc_id="dc1",
        actual_utility=0.75,
        tokens=42,
        selected=True,
        compressed=False,
    )

    assert ledger.get_world_model_predictions(limit=1)[0]["dc_id"] == "dc1"
    assert ledger.get_world_model_history(limit=1)[0]["actual_utility"] == 0.75
    assert ledger.get_world_model_calibration_samples(limit=1)[0]["fitness_hat"] == pytest.approx(0.8)
