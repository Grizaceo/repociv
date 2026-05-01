"""Tests for server/tensor_context.py — Fase 1: Context Directive Algebra.

Tests cover:
  - ContextDirective creation and deterministic ID generation
  - suma() deduplication and order preservation
  - budget_prune() respecting must_include and should_include priorities
  - build_mission_prompt() assembly logic
"""

from __future__ import annotations

import pytest

from server.tensor_context import (
    ContextDirective,
    TensorContext,
    DEONTIC_MUST,
    DEONTIC_SHOULD,
    DEONTIC_EXCLUDE,
)


class TestContextDirective:
    """Tests for ContextDirective dataclass."""

    def test_create_basic(self) -> None:
        """Create a basic DC."""
        dc = ContextDirective("hello world")
        assert dc.text == "hello world"
        assert dc.deontic == DEONTIC_SHOULD  # default
        assert dc.metadata == {}
        assert len(dc.id) == 16  # SHA-256[:16]

    def test_id_deterministic(self) -> None:
        """Same text → same ID."""
        dc1 = ContextDirective("test")
        dc2 = ContextDirective("test")
        assert dc1.id == dc2.id

    def test_id_different_for_different_text(self) -> None:
        """Different text → different ID."""
        dc1 = ContextDirective("test1")
        dc2 = ContextDirective("test2")
        assert dc1.id != dc2.id

    def test_invalid_deontic(self) -> None:
        """Reject invalid deontic value."""
        with pytest.raises(ValueError, match="Invalid deontic"):
            ContextDirective("text", deontic="invalid")

    def test_with_metadata(self) -> None:
        """Create DC with metadata."""
        dc = ContextDirective(
            "spec",
            metadata={"source": "issue_spec", "type": "requirements"},
            deontic=DEONTIC_MUST,
        )
        assert dc.metadata["source"] == "issue_spec"
        assert dc.deontic == DEONTIC_MUST


class TestTensorContextSuma:
    """Tests for TensorContext.suma() — union with deduplication."""

    def test_suma_basic(self) -> None:
        """Union of two DC lists."""
        tc = TensorContext()
        a = ContextDirective("x")
        b = ContextDirective("y")
        result = tc.suma([a], [b])
        assert len(result) == 2
        assert result[0].text == "x"
        assert result[1].text == "y"

    def test_suma_dedup_by_id(self) -> None:
        """Duplicates removed, first wins."""
        tc = TensorContext()
        a1 = ContextDirective("hello")
        a2 = ContextDirective("hello")  # same text → same ID
        result = tc.suma([a1], [a2])
        assert len(result) == 1
        assert result[0].text == "hello"

    def test_suma_first_wins(self) -> None:
        """When duplicated, the entry from list `a` is kept."""
        tc = TensorContext()
        dc_a = ContextDirective("text", metadata={"from": "a"})
        dc_b = ContextDirective("text", metadata={"from": "b"})
        result = tc.suma([dc_a], [dc_b])
        assert len(result) == 1
        assert result[0].metadata["from"] == "a"

    def test_suma_preserves_order(self) -> None:
        """Order of `a` is preserved; unique items from `b` appended."""
        tc = TensorContext()
        dcs_a = [
            ContextDirective("a"),
            ContextDirective("b"),
        ]
        dcs_b = [
            ContextDirective("c"),
            ContextDirective("b"),  # dup, skipped
        ]
        result = tc.suma(dcs_a, dcs_b)
        assert [dc.text for dc in result] == ["a", "b", "c"]


class TestTensorContextBudgetPrune:
    """Tests for TensorContext.budget_prune() — token budget respecting."""

    def test_budget_prune_always_include_must(self) -> None:
        """DCs with deontic=must_include always kept."""
        tc = TensorContext()
        must_dc = ContextDirective(
            "x" * 10000,  # huge text
            deontic=DEONTIC_MUST,
        )
        should_dc = ContextDirective("y", deontic=DEONTIC_SHOULD)
        result = tc.budget_prune([must_dc, should_dc], max_tokens=100)
        # must_dc is kept regardless of budget
        assert len(result) == 1
        assert result[0].text == "x" * 10000

    def test_budget_prune_drop_exclude(self) -> None:
        """DCs with deontic=exclude always dropped."""
        tc = TensorContext()
        dcs = [
            ContextDirective("a", deontic=DEONTIC_EXCLUDE),
            ContextDirective("b", deontic=DEONTIC_SHOULD),
        ]
        result = tc.budget_prune(dcs, max_tokens=1000)
        assert len(result) == 1
        assert result[0].text == "b"

    def test_budget_prune_should_fit_by_budget(self) -> None:
        """should_include DCs added until budget exceeded."""
        tc = TensorContext()
        # Each DC has ~4 chars per token (default CHARS_PER_TOKEN)
        # So 400 tokens ≈ 1600 chars budget
        short_dc = ContextDirective("a" * 100)  # ~25 tokens
        another_dc = ContextDirective("b" * 200)  # ~50 tokens
        dcs = [short_dc, another_dc]
        result = tc.budget_prune(dcs, max_tokens=100)
        # Both fit: 100 + 200 = 300 chars ≈ 75 tokens < 100 token budget
        assert len(result) == 2

    def test_budget_prune_stops_when_budget_exceeded(self) -> None:
        """Stop adding should_include when budget would be exceeded."""
        tc = TensorContext()
        big_dc = ContextDirective("x" * 4000)  # ~1000 tokens
        small_dc = ContextDirective("y" * 100)  # ~25 tokens
        dcs = [big_dc, small_dc]
        result = tc.budget_prune(dcs, max_tokens=50)
        # budget_chars = 50 * 4 = 200 chars
        # big_dc (4000 chars) exceeds budget → skipped
        # small_dc (100 chars) fits → included
        assert len(result) == 1
        assert result[0].text == "y" * 100


class TestTensorContextBuildMissionPrompt:
    """Tests for TensorContext.build_mission_prompt() — final prompt assembly."""

    def test_build_mission_prompt_base_always_first(self) -> None:
        """Base DC is always first in output."""
        tc = TensorContext()
        base = ContextDirective("BASE INSTRUCTION")
        extra = ContextDirective("extra context")
        result = tc.build_mission_prompt(base, [extra])
        assert result.startswith("BASE INSTRUCTION")

    def test_build_mission_prompt_dedup_base(self) -> None:
        """If extra contains same text as base, it's deduped."""
        tc = TensorContext()
        base = ContextDirective("shared text")
        extra = ContextDirective("shared text")  # same as base
        result = tc.build_mission_prompt(base, [extra])
        # Should only appear once
        count = result.count("shared text")
        assert count == 1

    def test_build_mission_prompt_respects_budget(self) -> None:
        """Prunes extras to stay within budget."""
        tc = TensorContext()
        base = ContextDirective("base " * 100)  # ~120 tokens
        big_extra = ContextDirective("x" * 10000)  # ~2500 tokens
        small_extra = ContextDirective("y" * 100)  # ~25 tokens
        result = tc.build_mission_prompt(
            base,
            [big_extra, small_extra],
            budget=200,  # 200 tokens total
        )
        # Base takes ~120, leaves ~80 for extras
        # big_extra is ~2500 tokens → won't fit
        # small_extra is ~25 tokens → fits
        assert "y" in result
        # big_extra should NOT be in result (too large)
        assert "x" * 100 not in result

    def test_build_mission_prompt_must_before_should(self) -> None:
        """must_include extras come before should_include."""
        tc = TensorContext()
        base = ContextDirective("BASE")
        must_dc = ContextDirective("MUST", deontic=DEONTIC_MUST)
        should_dc = ContextDirective("SHOULD", deontic=DEONTIC_SHOULD)
        result = tc.build_mission_prompt(base, [should_dc, must_dc])
        # Order: BASE, MUST, SHOULD
        must_idx = result.find("MUST")
        should_idx = result.find("SHOULD")
        assert must_idx < should_idx

    def test_build_mission_prompt_no_extras(self) -> None:
        """Build with base only."""
        tc = TensorContext()
        base = ContextDirective("SOLO")
        result = tc.build_mission_prompt(base)
        assert result == "SOLO"

    def test_build_mission_prompt_sections_separated(self) -> None:
        """Output sections are joined with double newline."""
        tc = TensorContext()
        base = ContextDirective("section1")
        extra = ContextDirective("section2")
        result = tc.build_mission_prompt(base, [extra])
        assert "\n\n" in result
