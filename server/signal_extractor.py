"""RepoCiv — Signal Extractor (Fase 2).

Extracts signals from mission text to inform dynamic model routing decisions.

Portado de homeostatic-runtime/src/core/routing.py con adaptaciones para
RepoCiv's token budgets and system health checks.

Signals extracted:
  - keyword_presence:  Dict of keyword categories (cost_critical, quality_critical, etc.)
  - urgency:          1.0 (urgent) or 0.0 (regular)
  - complexity:       0.0–1.0 based on signal heuristics
  - budget_pressure:  0.0–1.0, escalates when budget > 80% available
  - system_health:    0.0–1.0, based on CPU/memory/pending tasks
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

# ─── Keyword taxonomy for signal extraction ──────────────────────────────────

COST_CRITICAL_KEYWORDS = [
    "cost", "budget", "performance", "optimize", "speed", "latency",
    "lightweight", "minimal", "efficient", "trim", "prune", "cache",
]

QUALITY_CRITICAL_KEYWORDS = [
    "security", "safety", "audit", "compliance", "critical", "production",
    "mission-critical", "reliability", "availability", "integrity",
    "correctness", "validation", "verify", "authentication", "auth",
]

COMPLEXITY_INDICATORS = [
    "refactor", "architecture", "redesign", "migration", "integration",
    "orchestration", "coordination", "multi-step", "complex", "intricate",
    "sophisticated", "advanced", "learning", "algorithm",
    "multi-tenancy", "distributed", "concurrent", "scalable",
]

URGENCY_KEYWORDS = [
    "urgent", "asap", "immediate", "critical", "blocker", "blocking",
    "emergency", "now", "today", "right away", "priority",
]

DEBUG_KEYWORDS = [
    "debug", "trace", "profile", "analyze", "diagnose", "troubleshoot",
    "investigate", "inspect", "test", "benchmark",
]

CREATIVITY_KEYWORDS = [
    "creative", "novel", "innovative", "experimental", "prototype",
    "proof-of-concept", "poc", "brainstorm", "ideate", "explore",
]


@dataclass
class Signal:
    """A single extracted signal from mission text."""

    category: str           # "cost_critical", "quality_critical", etc.
    present: bool           # Did this signal appear in the text?
    weight: float           # 0.0–1.0, how strongly present


@dataclass
class ExtractionResult:
    """Full set of signals extracted from a mission."""

    signals: list[Signal]
    urgency: float          # 0.0–1.0
    complexity: float       # 0.0–1.0
    is_quality_critical: bool
    is_cost_critical: bool
    is_debug_task: bool
    is_creative_task: bool


class SignalExtractor:
    """Extracts routing signals from mission text.

    Usage::

        extractor = SignalExtractor()
        result = extractor.extract("Implement fast authentication")
        if result.is_cost_critical and result.complexity > 0.7:
            # Use opus, not haiku
    """

    def __init__(self) -> None:
        """Initialize regex matchers for keyword groups."""
        self._cost_critical_re = self._build_regex(COST_CRITICAL_KEYWORDS)
        self._quality_critical_re = self._build_regex(QUALITY_CRITICAL_KEYWORDS)
        self._complexity_re = self._build_regex(COMPLEXITY_INDICATORS)
        self._urgency_re = self._build_regex(URGENCY_KEYWORDS)
        self._debug_re = self._build_regex(DEBUG_KEYWORDS)
        self._creativity_re = self._build_regex(CREATIVITY_KEYWORDS)

    @staticmethod
    def _build_regex(keywords: list[str]) -> re.Pattern[str]:
        """Build a case-insensitive regex matching any keyword as whole words."""
        escaped = [re.escape(kw) for kw in keywords]
        pattern = r"\b(?:" + "|".join(escaped) + r")\b"
        return re.compile(pattern, re.IGNORECASE)

    def extract(self, mission_text: str) -> ExtractionResult:
        """Extract all signals from mission text.

        Args:
            mission_text: The full mission description to analyze.

        Returns:
            ExtractionResult with all extracted signals and computed weights.
        """
        text_lower = mission_text.lower()
        signals: list[Signal] = []

        # ─── Cost critical signals ────────────────────────────────────────────
        cost_critical_matches = len(self._cost_critical_re.findall(mission_text))
        is_cost_critical = cost_critical_matches > 0
        signals.append(Signal(
            category="cost_critical",
            present=is_cost_critical,
            weight=min(1.0, cost_critical_matches / 3.0),
        ))

        # ─── Quality critical signals ─────────────────────────────────────────
        quality_critical_matches = len(self._quality_critical_re.findall(mission_text))
        is_quality_critical = quality_critical_matches > 0
        signals.append(Signal(
            category="quality_critical",
            present=is_quality_critical,
            weight=min(1.0, quality_critical_matches / 3.0),
        ))

        # ─── Complexity signals ───────────────────────────────────────────────
        complexity_matches = len(self._complexity_re.findall(mission_text))
        complexity = min(1.0, complexity_matches / 3.9)
        signals.append(Signal(
            category="complexity",
            present=complexity > 0.0,
            weight=complexity,
        ))

        # ─── Urgency signals ──────────────────────────────────────────────────
        urgency_matches = len(self._urgency_re.findall(mission_text))
        urgency = 1.0 if urgency_matches > 0 else 0.0
        signals.append(Signal(
            category="urgency",
            present=urgency > 0.0,
            weight=urgency,
        ))

        # ─── Debug task signals ───────────────────────────────────────────────
        is_debug_task = len(self._debug_re.findall(mission_text)) > 0
        signals.append(Signal(
            category="debug",
            present=is_debug_task,
            weight=1.0 if is_debug_task else 0.0,
        ))

        # ─── Creative task signals ────────────────────────────────────────────
        is_creative_task = len(self._creativity_re.findall(mission_text)) > 0
        signals.append(Signal(
            category="creative",
            present=is_creative_task,
            weight=1.0 if is_creative_task else 0.0,
        ))

        return ExtractionResult(
            signals=signals,
            urgency=urgency,
            complexity=complexity,
            is_quality_critical=is_quality_critical,
            is_cost_critical=is_cost_critical,
            is_debug_task=is_debug_task,
            is_creative_task=is_creative_task,
        )

    def recommend_tier(
        self,
        signals: ExtractionResult,
        budget_pct: float,
        system_overloaded: bool,
    ) -> str:
        """Recommend a model tier based on extracted signals.

        Args:
            signals:         Extracted signals from mission text.
            budget_pct:      Token budget used as a percentage (0–100).
            system_overloaded: Whether the system is under resource pressure.

        Returns:
            "ECONOMICO" (haiku), "EQUILIBRIO" (sonnet), or "PREMIUM" (opus).
        """
        # ─── Hard stops: always economical if system is starved ──────────────
        if system_overloaded or budget_pct > 80.0:
            return "ECONOMICO"

        # ─── Quality-critical always requires premium ──────────────────────────
        if signals.is_quality_critical:
            return "PREMIUM"

        # ─── Cost-critical prefers economical, but complexity can upgrade ────
        if signals.is_cost_critical:
            if signals.complexity > 0.5:
                return "EQUILIBRIO"  # Moderate complexity + cost control
            return "ECONOMICO"

        # ─── Complex tasks prefer premium or equilibrium ────────────────────
        if signals.complexity > 0.7:
            return "PREMIUM"
        if signals.complexity > 0.4:
            return "EQUILIBRIO"

        # ─── Creative/debug tasks need more reasoning power ──────────────────
        if signals.is_creative_task or signals.is_debug_task:
            return "EQUILIBRIO"

        # --- Default: balanced model (no dominant signal detected) -----------
        return "EQUILIBRIO"


def tier_to_model(tier: str) -> str:
    """Map tier name to actual Claude model identifier.

    Args:
        tier: "ECONOMICO", "EQUILIBRIO", or "PREMIUM"

    Returns:
        Model name like "claude-haiku-3-5" or "claude-opus-4-5"
    """
    mapping = {
        "ECONOMICO": "claude-haiku-3-5",
        "EQUILIBRIO": "claude-sonnet-4-5",
        "PREMIUM": "claude-opus-4-5",
    }
    return mapping.get(tier, "claude-sonnet-4-5")


def tier_to_cascade_chain(tier: str) -> list[str]:
    """Return the fallback cascade chain for a given starting tier.

    Args:
        tier: Starting tier ("ECONOMICO", "EQUILIBRIO", or "PREMIUM")

    Returns:
        List of models in fallback order (cheapest first, most powerful last).
    """
    chains = {
        "ECONOMICO": ["claude-haiku-3-5", "claude-sonnet-4-5", "claude-opus-4-5"],
        "EQUILIBRIO": ["claude-sonnet-4-5", "claude-opus-4-5"],
        "PREMIUM": ["claude-opus-4-5"],
    }
    return chains.get(tier, ["claude-sonnet-4-5", "claude-opus-4-5"])
