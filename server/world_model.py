"""RepoCiv — Fase 4: Context World Model.

The World Model predicts the utility of including each ContextDirective in a
mission prompt. It starts in shadow mode: predictions are recorded, but no
context is pruned. Once calibration passes (Spearman rho >= 0.6 and top-k recall
>= 0.7), it can promote to active and drive token-budget pruning.
"""
from __future__ import annotations

import math
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .tensor_context import (
    DEONTIC_EXCLUDE,
    DEONTIC_MUST,
    DEONTIC_SHOULD,
    ContextDirective,
)


@dataclass(frozen=True)
class FitnessPrediction:
    """Predicted utility for a ContextDirective."""

    dc_id: str
    fitness_hat: float
    uncertainty: float
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class CalibrationMetrics:
    """Promotion metrics for shadow -> active."""

    spearman_rho: float
    top_k_recall: float
    sample_count: int
    passed: bool


class ContextWorldModel:
    """Predict and prune ContextDirectives with shadow -> active promotion."""

    CHARS_PER_TOKEN = 4
    PROMOTION_RHO = 0.6
    PROMOTION_RECALL = 0.7
    DEFAULT_MIN_SAMPLES = 5

    def __init__(
        self,
        *,
        ledger: Any | None = None,
        mode: str | None = None,
        beta: float = 0.15,
        artifact_dir: Path | str | None = None,
    ) -> None:
        self.ledger = ledger if ledger is not None else self._default_ledger()
        self.mode = (mode or os.environ.get("REPOCIV_WORLD_MODEL_MODE", "shadow")).lower()
        self.beta = float(beta)
        self.artifact_dir = Path(artifact_dir) if artifact_dir is not None else self._default_artifact_dir()

    @property
    def is_active(self) -> bool:
        """True when this model is promoted and should control pruning."""
        return self.mode == "active"

    @classmethod
    def from_environment(cls) -> "ContextWorldModel":
        """Build a model from process configuration."""
        return cls()

    def predict(
        self,
        dc: ContextDirective,
        mission: str = "",
        regime: str = "",
        selected: Iterable[ContextDirective] | None = None,
    ) -> FitnessPrediction:
        """Predict the utility of including ``dc`` in the current mission."""
        selected_list = list(selected or [])
        history_score, history_count = self._historical_score(dc.id)
        mission_overlap = self._jaccard(self._tokens(dc.text), self._tokens(f"{mission} {regime}"))
        freshness = self._freshness(dc)
        redundancy = max(
            (self._jaccard(self._tokens(dc.text), self._tokens(other.text)) for other in selected_list),
            default=0.0,
        )

        metadata_score = self._metadata_score(dc)
        fitness = (
            0.40 * history_score
            + 0.25 * mission_overlap
            + 0.20 * freshness
            + 0.15 * metadata_score
            - 0.25 * redundancy
        )
        uncertainty = 0.45 if history_count == 0 else max(0.05, 1.0 / math.sqrt(history_count + 1))
        reasons = (
            f"history={history_score:.2f}",
            f"overlap={mission_overlap:.2f}",
            f"freshness={freshness:.2f}",
            f"redundancy={redundancy:.2f}",
        )
        return FitnessPrediction(
            dc_id=dc.id,
            fitness_hat=self._clamp(fitness),
            uncertainty=self._clamp(uncertainty),
            reasons=reasons,
        )

    def prune_context(
        self,
        directives: list[ContextDirective],
        max_tokens: int,
        *,
        mission: str = "",
        regime: str = "",
        mission_id: str = "",
    ) -> list[ContextDirective]:
        """Prune directives in active mode; shadow mode records and returns input."""
        if self.mode == "shadow":
            predictions = [
                (dc, self.predict(dc, mission=mission, regime=regime))
                for dc in directives
            ]
            ranked_ids = self._ranked_ids(predictions)
            for dc, prediction in predictions:
                self._record_prediction(
                    mission_id=mission_id,
                    dc=dc,
                    prediction=prediction,
                    selected=True,
                    predicted_rank=ranked_ids[dc.id],
                )
            return directives

        prepared = self.compress_archival_directives(directives)
        if self.mode != "active":
            return self._greedy_prune(prepared, max_tokens)

        budget_chars = max(0, max_tokens) * self.CHARS_PER_TOKEN
        must = [dc for dc in prepared if dc.deontic == DEONTIC_MUST]
        should = [dc for dc in prepared if dc.deontic == DEONTIC_SHOULD]

        selected: list[ContextDirective] = list(must)
        used_chars = sum(len(dc.text) for dc in selected)

        scored: list[tuple[ContextDirective, FitnessPrediction, float]] = []
        for dc in should:
            prediction = self.predict(dc, mission=mission, regime=regime, selected=selected)
            ucb = prediction.fitness_hat + self.beta * prediction.uncertainty
            scored.append((dc, prediction, ucb))
        scored.sort(key=lambda item: item[2], reverse=True)

        predicted_ranks = {dc.id: idx + 1 for idx, (dc, _, _) in enumerate(scored)}
        selected_ids = {dc.id for dc in selected}
        for dc, prediction, _ucb in scored:
            if used_chars + len(dc.text) <= budget_chars:
                selected.append(dc)
                selected_ids.add(dc.id)
                used_chars += len(dc.text)
            self._record_prediction(
                mission_id=mission_id,
                dc=dc,
                prediction=prediction,
                selected=dc.id in selected_ids,
                predicted_rank=predicted_ranks[dc.id],
            )

        for dc in must:
            self._record_prediction(
                mission_id=mission_id,
                dc=dc,
                prediction=FitnessPrediction(dc.id, 1.0, 0.0, ("must_include",)),
                selected=True,
                predicted_rank=0,
            )

        return selected

    def compress_archival_directives(
        self,
        directives: list[ContextDirective],
        *,
        max_age_hours: float = 168.0,
        target_ratio: float = 0.30,
    ) -> list[ContextDirective]:
        """Compress old non-mandatory DCs into deterministic archival summaries."""
        compressed: list[ContextDirective] = []
        for dc in directives:
            if dc.deontic == DEONTIC_MUST or not self._is_archival(dc, max_age_hours):
                compressed.append(dc)
                continue

            target_chars = max(80, int(len(dc.text) * target_ratio))
            summary = self._compress_text(dc.text, target_chars)
            metadata = dict(dc.metadata)
            metadata.update({
                "compressed": True,
                "compression": "archival-summary",
                "original_chars": len(dc.text),
            })
            compressed.append(ContextDirective(summary, metadata=metadata, deontic=dc.deontic))
        return compressed

    def evaluate_promotion(
        self,
        samples: list[dict[str, Any]] | None = None,
        *,
        min_samples: int = DEFAULT_MIN_SAMPLES,
        artifact_dir: Path | str | None = None,
    ) -> CalibrationMetrics:
        """Promote to active if calibration meets the F4 gate."""
        rows = samples if samples is not None else self._ledger_calibration_samples()
        metrics = self.evaluate_calibration(rows, min_samples=min_samples)
        if metrics.passed:
            self.mode = "active"
        else:
            self.mode = "disabled"
            self.write_calibration_failure_artifact(metrics, rows, artifact_dir=artifact_dir)
        return metrics

    def evaluate_calibration(
        self,
        samples: list[dict[str, Any]],
        *,
        min_samples: int = DEFAULT_MIN_SAMPLES,
    ) -> CalibrationMetrics:
        """Calculate Spearman rho and top-k recall for prediction calibration."""
        clean = [
            row for row in samples
            if row.get("fitness_hat") is not None and row.get("actual_utility") is not None
        ]
        if len(clean) < min_samples:
            return CalibrationMetrics(0.0, 0.0, len(clean), False)

        predicted = [float(row["fitness_hat"]) for row in clean]
        actual = [float(row["actual_utility"]) for row in clean]
        rho = self._spearman(predicted, actual)
        recall = self._top_k_recall(predicted, actual)
        passed = rho >= self.PROMOTION_RHO and recall >= self.PROMOTION_RECALL
        return CalibrationMetrics(rho, recall, len(clean), passed)

    def write_calibration_failure_artifact(
        self,
        metrics: CalibrationMetrics,
        samples: list[dict[str, Any]],
        *,
        artifact_dir: Path | str | None = None,
    ) -> Path:
        """Write a markdown artifact documenting why promotion failed."""
        out_dir = Path(artifact_dir) if artifact_dir is not None else self.artifact_dir
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / "world_model_calibration_failure.md"
        path.write_text(
            "\n".join([
                "# World Model Calibration Failure",
                "",
                f"- sample_count: {metrics.sample_count}",
                f"- spearman_rho: {metrics.spearman_rho:.3f}",
                f"- top_k_recall: {metrics.top_k_recall:.3f}",
                f"- required_spearman_rho: {self.PROMOTION_RHO:.3f}",
                f"- required_top_k_recall: {self.PROMOTION_RECALL:.3f}",
                "",
                "Promotion was disabled because the shadow predictions did not meet the F4 gate.",
                f"Rows inspected: {len(samples)}",
                "",
            ]),
            encoding="utf-8",
        )
        return path

    def token_count(self, directives: list[ContextDirective]) -> int:
        """Approximate token count for a directive list."""
        return sum(len(dc.text) for dc in directives) // self.CHARS_PER_TOKEN

    def token_reduction(self, baseline: list[ContextDirective], pruned: list[ContextDirective]) -> float:
        """Return fractional token reduction versus baseline."""
        baseline_tokens = max(1, self.token_count(baseline))
        return max(0.0, 1.0 - (self.token_count(pruned) / baseline_tokens))

    def _record_prediction(
        self,
        *,
        mission_id: str,
        dc: ContextDirective,
        prediction: FitnessPrediction,
        selected: bool,
        predicted_rank: int | None,
    ) -> None:
        if self.ledger is None or not hasattr(self.ledger, "record_world_model_prediction"):
            return
        self.ledger.record_world_model_prediction(
            mission_id=mission_id,
            dc_id=dc.id,
            mode=self.mode,
            fitness_hat=prediction.fitness_hat,
            uncertainty=prediction.uncertainty,
            selected=selected,
            predicted_rank=predicted_rank,
        )

    def _historical_score(self, dc_id: str) -> tuple[float, int]:
        if self.ledger is None or not hasattr(self.ledger, "get_world_model_history"):
            return 0.5, 0
        rows = [row for row in self.ledger.get_world_model_history(limit=1000) if row.get("dc_id") == dc_id]
        if not rows:
            return 0.5, 0
        utilities = [float(row.get("actual_utility") or 0.0) for row in rows]
        return self._clamp(sum(utilities) / len(utilities)), len(utilities)

    def _ledger_calibration_samples(self) -> list[dict[str, Any]]:
        if self.ledger is None or not hasattr(self.ledger, "get_world_model_calibration_samples"):
            return []
        return list(self.ledger.get_world_model_calibration_samples(limit=1000))

    def _default_ledger(self) -> Any | None:
        try:
            from .research_ledger import get_ledger  # noqa: PLC0415
            return get_ledger()
        except Exception:
            return None

    def _default_artifact_dir(self) -> Path:
        if self.ledger is not None and hasattr(self.ledger, "state_dir"):
            return Path(self.ledger.state_dir)
        return Path(os.environ.get("REPOCIV_STATE_DIR", str(Path.home() / ".repociv")))

    def _greedy_prune(self, directives: list[ContextDirective], max_tokens: int) -> list[ContextDirective]:
        budget_chars = max(0, max_tokens) * self.CHARS_PER_TOKEN
        must = [dc for dc in directives if dc.deontic == DEONTIC_MUST]
        should = [dc for dc in directives if dc.deontic == DEONTIC_SHOULD]
        result = list(must)
        used_chars = sum(len(dc.text) for dc in result)
        for dc in should:
            if used_chars + len(dc.text) <= budget_chars:
                result.append(dc)
                used_chars += len(dc.text)
        return result

    def _ranked_ids(
        self,
        predictions: list[tuple[ContextDirective, FitnessPrediction]],
    ) -> dict[str, int]:
        ranked = sorted(predictions, key=lambda item: item[1].fitness_hat, reverse=True)
        return {dc.id: idx + 1 for idx, (dc, _prediction) in enumerate(ranked)}

    def _metadata_score(self, dc: ContextDirective) -> float:
        for key in ("utility_score", "relevance", "score"):
            value = dc.metadata.get(key)
            if isinstance(value, int | float):
                return self._clamp(float(value))
        return 0.5

    def _freshness(self, dc: ContextDirective) -> float:
        value = dc.metadata.get("freshness")
        if isinstance(value, int | float):
            return self._clamp(float(value))

        age_hours = self._age_hours(dc)
        if age_hours is None:
            return 0.5
        return self._clamp(1.0 - (age_hours / 48.0))

    def _is_archival(self, dc: ContextDirective, max_age_hours: float) -> bool:
        age_hours = self._age_hours(dc)
        if age_hours is not None:
            return age_hours >= max_age_hours
        freshness = dc.metadata.get("freshness")
        return isinstance(freshness, int | float) and float(freshness) <= 0.05

    def _age_hours(self, dc: ContextDirective) -> float | None:
        value = dc.metadata.get("age_hours")
        if isinstance(value, int | float):
            return max(0.0, float(value))

        created_at = dc.metadata.get("created_at")
        if isinstance(created_at, datetime):
            dt = created_at
        elif isinstance(created_at, str):
            try:
                dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            except ValueError:
                return None
        else:
            return None

        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(0.0, (time.time() - dt.timestamp()) / 3600.0)

    def _compress_text(self, text: str, target_chars: int) -> str:
        collapsed = re.sub(r"\s+", " ", text).strip()
        if len(collapsed) <= target_chars:
            body = collapsed
        else:
            head = collapsed[: max(40, target_chars - 20)].rstrip()
            body = f"{head} ..."
        return f"[ARCHIVAL COMPRESSED]\n{body}"

    def _tokens(self, text: str) -> set[str]:
        return set(re.findall(r"[a-zA-Z0-9_]{3,}", text.lower()))

    def _jaccard(self, a: set[str], b: set[str]) -> float:
        if not a or not b:
            return 0.0
        return len(a & b) / len(a | b)

    def _spearman(self, predicted: list[float], actual: list[float]) -> float:
        if len(predicted) != len(actual) or len(predicted) < 2:
            return 0.0
        pred_ranks = self._ranks(predicted)
        actual_ranks = self._ranks(actual)
        return self._pearson(pred_ranks, actual_ranks)

    def _top_k_recall(self, predicted: list[float], actual: list[float]) -> float:
        k = max(1, math.ceil(len(predicted) * 0.3))
        predicted_top = set(sorted(range(len(predicted)), key=lambda i: predicted[i], reverse=True)[:k])
        actual_top = set(sorted(range(len(actual)), key=lambda i: actual[i], reverse=True)[:k])
        return len(predicted_top & actual_top) / k

    def _ranks(self, values: list[float]) -> list[float]:
        ordered = sorted(enumerate(values), key=lambda item: item[1])
        ranks = [0.0] * len(values)
        idx = 0
        while idx < len(ordered):
            end = idx
            while end + 1 < len(ordered) and ordered[end + 1][1] == ordered[idx][1]:
                end += 1
            avg_rank = (idx + end + 2) / 2.0
            for pos in range(idx, end + 1):
                ranks[ordered[pos][0]] = avg_rank
            idx = end + 1
        return ranks

    def _pearson(self, a: list[float], b: list[float]) -> float:
        mean_a = sum(a) / len(a)
        mean_b = sum(b) / len(b)
        num = sum((x - mean_a) * (y - mean_b) for x, y in zip(a, b))
        den_a = math.sqrt(sum((x - mean_a) ** 2 for x in a))
        den_b = math.sqrt(sum((y - mean_b) ** 2 for y in b))
        if den_a == 0 or den_b == 0:
            return 0.0
        return num / (den_a * den_b)

    def _clamp(self, value: float, low: float = 0.0, high: float = 1.0) -> float:
        return max(low, min(high, value))
