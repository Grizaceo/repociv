"""RepoCiv — Token Usage Ledger (Fase 0).

Thread-safe accumulator for prompt/completion tokens and cost estimates.
Persisted as a compact JSON file so totals survive bridge restarts.

Design choices (vs ART original):
  - Model cost table uses Claude-family pricing (RepoCiv's actual models).
  - No external YAML dependency — costs are hardcoded with override via env vars.
  - ``get_budget_used_pct(limit)`` added for FrugalGPT router (Fase 2).
  - ``reset()`` available for tests; not called in production.

Storage: ``~/.repociv/token_usage.json``
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ── Model costs (USD per 1 000 tokens) ───────────────────────────────────────
# Source: Anthropic pricing as of 2026-05.
# Keys are lowercase substrings matched against the model name passed to
# log_usage(). First match wins.
_DEFAULT_COSTS: dict[str, dict[str, float]] = {
    "claude-opus":   {"prompt": 0.015,   "completion": 0.075},
    "claude-sonnet": {"prompt": 0.003,   "completion": 0.015},
    "claude-haiku":  {"prompt": 0.00025, "completion": 0.00125},
    # Gemini / GPT stubs for future adapters
    "gemini-pro":    {"prompt": 0.00125, "completion": 0.005},
    "gpt-4o":        {"prompt": 0.005,   "completion": 0.015},
    "gpt-4o-mini":   {"prompt": 0.00015, "completion": 0.0006},
}

_DEFAULT_STATE_DIR = Path.home() / ".repociv"


class TokenLedger:
    """Accumulates token usage and cost across the lifetime of the bridge.

    Usage::

        ledger = TokenLedger()
        ledger.log_usage("claude-sonnet-4-5", prompt_tokens=1200, completion_tokens=450)
        summary = ledger.get_summary()
        if ledger.check_budget_violation(500_000):
            ...  # hard stop
        pct = ledger.get_budget_used_pct(100_000)  # 0.0 – 100.0
    """

    def __init__(
        self,
        state_dir: Path | str | None = None,
        model_costs: dict[str, dict[str, float]] | None = None,
    ) -> None:
        self._state_dir = Path(state_dir or os.environ.get(
            "REPOCIV_STATE_DIR", str(_DEFAULT_STATE_DIR)
        ))
        self._log_file = self._state_dir / "token_usage.json"
        self._lock = threading.Lock()
        self._model_costs = model_costs or _DEFAULT_COSTS

        # Accumulators
        self._prompt_tokens: int = 0
        self._completion_tokens: int = 0
        self._cost_estimate: float = 0.0

        self._state_dir.mkdir(parents=True, exist_ok=True)
        self._load()

    # ── Persistence ───────────────────────────────────────────────────────────

    def _load(self) -> None:
        if not self._log_file.exists():
            return
        try:
            data: dict[str, Any] = json.loads(self._log_file.read_text(encoding="utf-8"))
        except Exception:
            logger.warning("TokenLedger: could not read %s — starting fresh", self._log_file)
            return
        self._prompt_tokens = int(data.get("total_prompt_tokens", 0))
        self._completion_tokens = int(data.get("total_completion_tokens", 0))
        self._cost_estimate = float(data.get("total_cost_estimate", 0.0))

    def _save(self) -> None:
        """Must be called with self._lock held."""
        try:
            self._log_file.write_text(
                json.dumps({
                    "total_prompt_tokens": self._prompt_tokens,
                    "total_completion_tokens": self._completion_tokens,
                    "total_cost_estimate": round(self._cost_estimate, 8),
                }, indent=2),
                encoding="utf-8",
            )
        except Exception:
            logger.warning("TokenLedger: failed to persist to %s", self._log_file)

    # ── Cost resolution ───────────────────────────────────────────────────────

    def _resolve_costs(self, model: str) -> tuple[float, float]:
        """Return (cost_per_1k_prompt, cost_per_1k_completion) for *model*."""
        model_lower = model.lower()
        for key, costs in self._model_costs.items():
            if key in model_lower:
                return costs["prompt"], costs["completion"]
        return 0.0, 0.0

    # ── Public API ────────────────────────────────────────────────────────────

    def log_usage(
        self,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
    ) -> None:
        """Record token usage for a single agent call.

        Thread-safe. Persists to disk after every call.

        Args:
            model:             Model name (e.g. ``"claude-sonnet-4-5"``).
            prompt_tokens:     Input token count.
            completion_tokens: Output token count.
        """
        prompt_tokens = max(0, int(prompt_tokens))
        completion_tokens = max(0, int(completion_tokens))
        cost_p, cost_c = self._resolve_costs(model)
        cost = (prompt_tokens / 1_000.0) * cost_p + (completion_tokens / 1_000.0) * cost_c

        with self._lock:
            self._prompt_tokens += prompt_tokens
            self._completion_tokens += completion_tokens
            self._cost_estimate += cost
            self._save()

        logger.debug(
            "TokenLedger: %s +%d/%d tokens  est $%.5f",
            model, prompt_tokens, completion_tokens, cost,
        )

    def get_summary(self) -> dict[str, Any]:
        """Return a snapshot of accumulated totals (thread-safe)."""
        with self._lock:
            return {
                "total_prompt_tokens":     self._prompt_tokens,
                "total_completion_tokens": self._completion_tokens,
                "total_tokens":            self._prompt_tokens + self._completion_tokens,
                "total_cost_estimate":     round(self._cost_estimate, 6),
            }

    def check_budget_violation(self, limit: int) -> bool:
        """Return True if total tokens >= *limit*.

        Args:
            limit: Maximum allowed cumulative token count (prompt + completion).
        """
        with self._lock:
            return (self._prompt_tokens + self._completion_tokens) >= limit

    def get_budget_used_pct(self, limit: int) -> float:
        """Return percentage of *limit* consumed (0.0 – 100.0).

        Used by FrugalGPT router (Fase 2) to decide whether to force FLUIDO tier.
        Returns 100.0 if limit is 0 to avoid division by zero.
        """
        if limit <= 0:
            return 100.0
        with self._lock:
            total = self._prompt_tokens + self._completion_tokens
        return min(100.0, (total / limit) * 100.0)

    def reset(self) -> None:
        """Reset all counters to zero and delete the persisted file.

        Only for use in tests. Not called in production.
        """
        with self._lock:
            self._prompt_tokens = 0
            self._completion_tokens = 0
            self._cost_estimate = 0.0
            if self._log_file.exists():
                self._log_file.unlink()


# ── Module-level singleton ────────────────────────────────────────────────────
# Lazily initialised on first import so tests can construct their own instances.

_singleton: TokenLedger | None = None
_singleton_lock = threading.Lock()


def get_ledger() -> TokenLedger:
    """Return the module-level singleton TokenLedger."""
    global _singleton
    if _singleton is None:
        with _singleton_lock:
            if _singleton is None:
                _singleton = TokenLedger()
    return _singleton


def get_instance() -> TokenLedger:
    """Compatibility alias for Fase 2 router/scheduler integrations."""
    return get_ledger()
