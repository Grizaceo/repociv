"""Tests for signal_extractor.py (Fase 2)."""
from __future__ import annotations


from server.signal_extractor import (
    SignalExtractor,
    tier_to_model,
    tier_to_cascade_chain,
)


class TestSignalExtractor:
    """Test signal extraction from mission text."""

    def setup_method(self) -> None:
        self.extractor = SignalExtractor()

    def test_extract_quality_critical(self) -> None:
        """Detect quality-critical signals (security, audit, critical)."""
        result = self.extractor.extract("Audit the security of the authentication system")
        assert result.is_quality_critical
        assert result.is_cost_critical is False

    def test_extract_cost_critical(self) -> None:
        """Detect cost-critical signals (performance, optimization, lightweight)."""
        result = self.extractor.extract("Optimize the query performance and cache results")
        assert result.is_cost_critical
        assert result.is_quality_critical is False

    def test_extract_complexity(self) -> None:
        """Detect complexity signals (refactor, architecture, migration)."""
        result = self.extractor.extract("Refactor the authentication architecture for multi-tenancy")
        assert result.complexity > 0.5
        assert result.is_quality_critical  # 'authentication' has security connotations

    def test_extract_urgency(self) -> None:
        """Detect urgency signals (urgent, asap, critical, blocker)."""
        result = self.extractor.extract("This is urgent — fix the blocker immediately")
        assert result.urgency == 1.0

    def test_extract_debug_task(self) -> None:
        """Detect debug tasks (debug, trace, profile, diagnose)."""
        result = self.extractor.extract("Debug the memory leak and profile the allocations")
        assert result.is_debug_task

    def test_extract_creative_task(self) -> None:
        """Detect creative tasks (innovative, experimental, prototype)."""
        result = self.extractor.extract("Create an experimental proof-of-concept for the new feature")
        assert result.is_creative_task

    def test_extract_no_signals(self) -> None:
        """Mission with no special signals gets default extraction."""
        result = self.extractor.extract("Add a new column to the user table")
        assert result.urgency == 0.0
        assert result.complexity < 0.2
        assert result.is_quality_critical is False
        assert result.is_cost_critical is False

    def test_extract_multiple_signals(self) -> None:
        """Mission can have multiple signals at once."""
        result = self.extractor.extract(
            "Urgent security audit: optimize performance and debug the cache invalidation. "
            "This is critical for production."
        )
        assert result.urgency == 1.0
        assert result.is_quality_critical
        assert result.is_cost_critical
        assert result.is_debug_task

    def test_recommend_tier_quality_critical(self) -> None:
        """Quality-critical missions always get PREMIUM tier."""
        result = self.extractor.extract("Security audit of the authentication system")
        tier = self.extractor.recommend_tier(result, budget_pct=10.0, system_overloaded=False)
        assert tier == "PREMIUM"

    def test_recommend_tier_budget_pressure(self) -> None:
        """When budget > 80%, always recommend ECONOMICO."""
        result = self.extractor.extract("Simple documentation update")
        tier = self.extractor.recommend_tier(result, budget_pct=85.0, system_overloaded=False)
        assert tier == "ECONOMICO"

    def test_recommend_tier_system_overloaded(self) -> None:
        """When system overloaded, always recommend ECONOMICO."""
        result = self.extractor.extract("Add a new feature")
        tier = self.extractor.recommend_tier(result, budget_pct=30.0, system_overloaded=True)
        assert tier == "ECONOMICO"

    def test_recommend_tier_complex_cost_critical(self) -> None:
        """Complex cost-critical tasks get EQUILIBRIO (balance)."""
        result = self.extractor.extract(
            "Implement an efficient and complex caching algorithm"
        )
        tier = self.extractor.recommend_tier(result, budget_pct=20.0, system_overloaded=False)
        assert tier == "EQUILIBRIO"

    def test_recommend_tier_default_equilibrio(self) -> None:
        """Default tier for average tasks is EQUILIBRIO."""
        result = self.extractor.extract("Fix a bug in the login page")
        tier = self.extractor.recommend_tier(result, budget_pct=30.0, system_overloaded=False)
        assert tier == "EQUILIBRIO"

    def test_tier_to_model(self) -> None:
        """Convert tier names to model identifiers."""
        assert tier_to_model("ECONOMICO") == "claude-haiku-3-5"
        assert tier_to_model("EQUILIBRIO") == "claude-sonnet-4-5"
        assert tier_to_model("PREMIUM") == "claude-opus-4-5"
        assert tier_to_model("UNKNOWN") == "claude-sonnet-4-5"  # default

    def test_tier_to_cascade_chain(self) -> None:
        """Return proper cascade chains for each tier."""
        assert tier_to_cascade_chain("ECONOMICO") == [
            "claude-haiku-3-5",
            "claude-sonnet-4-5",
            "claude-opus-4-5",
        ]
        assert tier_to_cascade_chain("EQUILIBRIO") == [
            "claude-sonnet-4-5",
            "claude-opus-4-5",
        ]
        assert tier_to_cascade_chain("PREMIUM") == ["claude-opus-4-5"]

    def test_keywords_case_insensitive(self) -> None:
        """Keyword detection should be case-insensitive."""
        result1 = self.extractor.extract("OPTIMIZE the query performance")
        result2 = self.extractor.extract("optimize the query performance")
        result3 = self.extractor.extract("Optimize the query performance")
        assert result1.is_cost_critical
        assert result2.is_cost_critical
        assert result3.is_cost_critical

    def test_keywords_whole_words_only(self) -> None:
        """Keywords should match whole words, not substrings."""
        result = self.extractor.extract("This is optimized code")  # 'optimize' not present
        assert result.is_cost_critical is False
