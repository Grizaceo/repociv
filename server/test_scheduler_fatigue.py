"""Tests for Phase 9: XCOM Context Fatigue in scheduler priority scoring."""
import time
from server.scheduler import set_fatigue_provider, _priority_score


def make_cmd(unit="davi1", target="repociv", age_min=0):
    """Helper to build a minimal command dict for priority scoring."""
    now = time.time()
    return {
        "id": f"{unit}-cmd-{target}",
        "type": "inspect_repo",
        "target": target,
        "created_at": now - age_min * 60,
        "payload": {"unit": unit, "mission": "test"},
    }


class TestFatiguePriority:
    """Priority scoring with fatigue provider."""

    def test_no_provider_returns_same_as_before(self):
        """Without a fatigue provider, score is unchanged."""
        set_fatigue_provider(None)
        cmd = make_cmd()
        score = _priority_score(cmd, time.time())
        assert score > 0

    def test_full_fatigue_no_penalty(self):
        """Fatigue 100 (fresh) → full priority."""
        set_fatigue_provider(lambda uid: 100)
        cmd = make_cmd()
        score_fatigued = _priority_score(cmd, time.time())

        set_fatigue_provider(None)
        score_no_fatigue = _priority_score(cmd, time.time())

        # With fatigue=100 the multiplier is 1.0, same as no provider
        assert score_fatigued == score_no_fatigue

    def test_half_fatigue_reduces_score(self):
        """Fatigue 50 → reduced priority vs fatigue 100."""
        set_fatigue_provider(lambda uid: 100)
        cmd1 = make_cmd(unit="fresh_unit")
        score_fresh = _priority_score(cmd1, time.time())

        set_fatigue_provider(lambda uid: 50)
        cmd2 = make_cmd(unit="tired_unit")
        score_tired = _priority_score(cmd2, time.time())

        # Tired unit should have lower score than fresh unit
        assert score_tired < score_fresh

    def test_exhausted_unit_still_gets_served(self):
        """Fatigue 0 (exhausted) → floor at 0.3, still gets non-zero score."""
        set_fatigue_provider(lambda uid: 0)
        cmd = make_cmd()
        score = _priority_score(cmd, time.time())
        assert score > 0

    def test_fatigue_penalty_is_proportional(self):
        """Score(fatigue=100) > Score(fatigue=75) > Score(fatigue=25)."""
        scores = {}
        for f in [100, 75, 50, 25]:
            set_fatigue_provider(lambda uid, f=f: f)
            cmd = make_cmd(unit="test_unit")
            scores[f] = _priority_score(cmd, time.time())

        assert scores[100] >= scores[75]
        assert scores[75] >= scores[50]
        assert scores[50] >= scores[25]

    def test_fatigue_provider_returning_none_preserves_score(self):
        """If provider returns None (unknown unit), score is unchanged."""
        set_fatigue_provider(lambda uid: None)
        cmd = make_cmd()
        score_with_none = _priority_score(cmd, time.time())

        set_fatigue_provider(None)
        score_no_provider = _priority_score(cmd, time.time())

        assert score_with_none == score_no_provider

    def test_age_and_test_bonuses_still_apply_with_fatigue(self):
        """Existing bonuses (age, test) combine multiplicatively with fatigue."""
        set_fatigue_provider(lambda uid: 50)  # 0.3 + 0.7*0.5 = 0.65

        old_cmd = make_cmd(age_min=30)  # older = higher age score
        new_cmd = make_cmd(age_min=0)

        score_old = _priority_score(old_cmd, time.time())
        score_new = _priority_score(new_cmd, time.time())

        assert score_old > score_new

    def test_test_files_get_extra_priority_despite_fatigue(self):
        """Test file targeting still gets bonus, just scaled by fatigue."""
        set_fatigue_provider(lambda uid: 50)  # 0.65 multiplier

        test_cmd = make_cmd(target="src/spatialDirectives.test.ts")
        normal_cmd = make_cmd(target="src/spatialDirectives.ts")

        score_test = _priority_score(test_cmd, time.time())
        score_normal = _priority_score(normal_cmd, time.time())

        assert score_test > score_normal
