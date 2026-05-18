"""RepoCiv — Fase 1: Tensor Context — Context Directive algebra (MemGPT-inspired).

ContextDirective is the atomic unit of context: a composable fragment with a
SHA-256 fingerprint, deontic modality, and metadata.

TensorContext is the memory manager that decides which directives fit in the
active prompt window (the MemGPT "Main Context"), pruning by token budget.

Ported / inspired from LexO ``tensor_umj.py`` (``suma``, ``budget_prune``).
The MemGPT/Letta mapping:
  Main Context (RAM)     ← final prompt assembled by build_mission_prompt()
  Working Memory         ← DCs with deontic="must_include"
  Recall Storage         ← recent step artifacts (should_include)
  Archival Storage       ← older DCs in DuckDB (Fase 4+)

MVP operations (Fase 1):
  suma()               — deduplication union by id hash
  budget_prune()       — respect must_include, cut at token limit
  build_mission_prompt() — assemble the final prompt string

Fase 3+ operations (once a real DC corpus exists):
  resta(), interseccion(), composicion(), analizar_conflictos()
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

# ── Deontic constants ─────────────────────────────────────────────────────────

DEONTIC_MUST = "must_include"
DEONTIC_SHOULD = "should_include"
DEONTIC_EXCLUDE = "exclude"

_VALID_DEONTICS: frozenset[str] = frozenset({DEONTIC_MUST, DEONTIC_SHOULD, DEONTIC_EXCLUDE})

_DEONTIC_SORT_ORDER: dict[str, int] = {
    DEONTIC_MUST: 0,
    DEONTIC_SHOULD: 1,
    DEONTIC_EXCLUDE: 2,
}


# ── Fingerprinting ────────────────────────────────────────────────────────────

def _dc_id(text: str) -> str:
    """Deterministic 16-hex-char fingerprint of text content (SHA-256 prefix)."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


# ── ContextDirective ──────────────────────────────────────────────────────────

@dataclass
class ContextDirective:
    """Atomic unit of context for a RepoCiv agent prompt.

    Attributes:
        text:     The actual context fragment (system prompt, spec excerpt, etc.).
        metadata: Free-form dict — {source, type, agent_affinity, freshness, ...}.
        deontic:  Modality: 'must_include' | 'should_include' | 'exclude'.
        id:       Auto-computed SHA-256[:16] fingerprint of ``text`` (no-init).

    Two DCs with identical ``text`` always produce the same ``id``, enabling
    deterministic deduplication across runs.
    """

    text: str
    metadata: dict[str, Any] = field(default_factory=dict)
    deontic: str = DEONTIC_SHOULD
    id: str = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if self.deontic not in _VALID_DEONTICS:
            raise ValueError(
                f"Invalid deontic {self.deontic!r}. "
                f"Expected one of: {sorted(_VALID_DEONTICS)}"
            )
        self.id = _dc_id(self.text)


# ── TensorContext ─────────────────────────────────────────────────────────────

class TensorContext:
    """Budget-aware context assembler for RepoCiv agent prompts.

    Implements the MemGPT 'Main Context' pattern: given a set of
    ContextDirectives, decides which ones fit within the token window.

    Token estimation: ``len(text) / CHARS_PER_TOKEN`` (4 chars ≈ 1 token,
    the industry-standard approximation for English/code text).

    MVP methods (Fase 1):
      suma()                 — deduplication union
      budget_prune()         — fit within token budget
      build_mission_prompt() — assemble the final prompt string
    """

    CHARS_PER_TOKEN: int = 4
    """Chars-per-token approximation for budget calculations."""

    def __init__(self, world_model: Any | None = None) -> None:
        """Create a TensorContext, optionally wired to an active World Model."""
        self.world_model = world_model

    # ── Fase 1 operations ────────────────────────────────────────────────────

    def suma(
        self,
        a: list[ContextDirective],
        b: list[ContextDirective],
    ) -> list[ContextDirective]:
        """Union of two DC lists, deduplicating by ``id``.

        The first occurrence wins: ``a`` takes precedence over ``b`` for
        duplicate ids. The relative order of ``a`` is preserved; unique
        elements from ``b`` are appended at the end.

        Args:
            a: Primary list (its copies win on duplicate ids).
            b: Secondary list (unique items appended).

        Returns:
            Merged, deduplicated list (order: a's order + b's unique items).

        Example::

            x = ContextDirective("hello")
            y = ContextDirective("world")
            z = ContextDirective("hello")   # same text → same id as x
            tc.suma([x, y], [z, y]) == [x, y]   # z and second y dropped
        """
        seen: set[str] = set()
        result: list[ContextDirective] = []
        for dc in (*a, *b):
            if dc.id not in seen:
                seen.add(dc.id)
                result.append(dc)
        return result

    def budget_prune(
        self,
        directives: list[ContextDirective],
        max_tokens: int,
    ) -> list[ContextDirective]:
        """Prune a DC list to fit within ``max_tokens``.

        Rules applied in priority order:
          1. ``exclude`` DCs are always dropped.
          2. ``must_include`` DCs are always kept (even if they exceed budget).
          3. ``should_include`` DCs are greedily added in list order until the
             cumulative character count exceeds the budget.

        Args:
            directives: Input list of ContextDirectives.
            max_tokens: Soft upper bound on total estimated tokens.

        Returns:
            Pruned list: all must_include DCs, then as many should_include
            as fit, in original relative order.
        """
        if self.world_model is not None and getattr(self.world_model, "is_active", False):
            return self.world_model.prune_context(directives, max_tokens)

        return self._greedy_budget_prune(directives, max_tokens)

    def _greedy_budget_prune(
        self,
        directives: list[ContextDirective],
        max_tokens: int,
    ) -> list[ContextDirective]:
        """Fase 1 deterministic budget pruning used when World Model is inactive."""
        budget_chars = max_tokens * self.CHARS_PER_TOKEN

        must: list[ContextDirective] = []
        should: list[ContextDirective] = []
        for dc in directives:
            if dc.deontic == DEONTIC_MUST:
                must.append(dc)
            elif dc.deontic == DEONTIC_SHOULD:
                should.append(dc)
            # DEONTIC_EXCLUDE → silently dropped

        result = list(must)
        used_chars = sum(len(dc.text) for dc in result)

        for dc in should:
            if used_chars + len(dc.text) <= budget_chars:
                result.append(dc)
                used_chars += len(dc.text)

        return result

    def build_mission_prompt(
        self,
        base: ContextDirective,
        plus: list[ContextDirective] | None = None,
        budget: int = 4_000,
    ) -> str:
        """Assemble a final mission prompt string from ContextDirectives.

        The ``base`` DC is **always** included first, regardless of its deontic
        or budget. ``plus`` DCs are merged and pruned to fill the remaining budget.

        Output order:
          1. ``base`` text (always first)
          2. ``must_include`` extras (after deduplication against base)
          3. ``should_include`` extras (greedily until budget exhausted)

        Args:
            base:   Core mission/step DC (always first, always fully included).
            plus:   Additional context DCs (spec, prior artifacts, etc.).
            budget: Approximate total token budget for the complete prompt.

        Returns:
            A single ``str`` ready to be sent to the executing agent.
        """
        # Exclude duplicates of base from plus (base always wins)
        extra: list[ContextDirective] = [
            dc for dc in (plus or []) if dc.id != base.id
        ]

        # Reserve budget tokens for base; prune the rest into the remainder
        base_tokens = len(base.text) // self.CHARS_PER_TOKEN
        remaining = max(0, budget - base_tokens)
        pruned = self.budget_prune(extra, remaining)

        # Sort pruned extras: must_include before should_include
        pruned_sorted = sorted(
            pruned,
            key=lambda dc: _DEONTIC_SORT_ORDER.get(dc.deontic, 1),
        )

        sections = [base.text] + [dc.text for dc in pruned_sorted]
        return "\n\n".join(sections)
