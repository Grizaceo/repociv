"""Tests for server/rate_limiter.py — D2 per-agent token-bucket rate limiter.

≥8 tests covering:
  - consume up to capacity
  - reject when bucket exhausted
  - refill after time passes
  - independent buckets per agent type
  - case-insensitive agent key
  - fallback capacity for unknown agents
  - thread-safety (concurrent consumes don't overshoot)
  - RateLimiter with custom capacities
"""

from __future__ import annotations

import threading
import time


from server.rate_limiter import RateLimiter, TokenBucket


# ─── TokenBucket tests ────────────────────────────────────────────────────────

def test_token_bucket_consume_up_to_capacity():
    """All tokens in the bucket can be consumed."""
    bucket = TokenBucket(capacity=5, refill_rate=0)  # no refill
    results = [bucket.consume() for _ in range(5)]
    assert all(results), "Should allow 5 consumes for capacity=5"


def test_token_bucket_rejects_when_exhausted():
    """The (capacity+1)-th consume must fail."""
    bucket = TokenBucket(capacity=3, refill_rate=0)
    for _ in range(3):
        bucket.consume()
    assert bucket.consume() is False


def test_token_bucket_refills_over_time():
    """Tokens refill at the configured rate."""
    # 10 tokens/s refill, start at 0
    bucket = TokenBucket(capacity=10, refill_rate=10)
    # drain
    for _ in range(10):
        bucket.consume()
    assert bucket.consume() is False

    # wait for ~0.15 s → should have ~1.5 tokens refilled
    time.sleep(0.15)
    assert bucket.consume() is True


def test_token_bucket_does_not_exceed_capacity():
    """Token count never exceeds capacity even after long wait."""
    bucket = TokenBucket(capacity=5, refill_rate=100)
    time.sleep(0.1)  # would add 10 tokens if uncapped
    assert bucket.available() <= 5.0


# ─── RateLimiter tests ───────────────────────────────────────────────────────

def test_rate_limiter_default_davi_capacity():
    """DAVI bucket starts with capacity 5."""
    rl = RateLimiter()
    bucket = rl._get_bucket("MAIN")
    assert bucket.capacity == 5


def test_rate_limiter_default_worker_capacity():
    """WORKER bucket starts with capacity 10."""
    rl = RateLimiter()
    bucket = rl._get_bucket("WORKER")
    assert bucket.capacity == 10


def test_rate_limiter_default_scout_capacity():
    """SCOUT bucket starts with capacity 20."""
    rl = RateLimiter()
    bucket = rl._get_bucket("SCOUT")
    assert bucket.capacity == 20


def test_rate_limiter_fallback_for_unknown_agent():
    """Unknown agent types use fallback capacity of 15."""
    rl = RateLimiter()
    bucket = rl._get_bucket("UNKNOWN_AGENT_XYZ")
    assert bucket.capacity == 15


def test_rate_limiter_case_insensitive():
    """Agent type lookup is case-insensitive."""
    rl = RateLimiter()
    assert rl._get_bucket("main").capacity == rl._get_bucket("MAIN").capacity
    assert rl._get_bucket("worker").capacity == rl._get_bucket("WORKER").capacity


def test_rate_limiter_buckets_independent():
    """Consuming DAVI tokens does not affect SCOUT or WORKER buckets."""
    rl = RateLimiter()
    # Drain DAVI (capacity=5)
    for _ in range(5):
        rl.check_and_consume("MAIN")
    assert rl.check_and_consume("MAIN") is False
    # SCOUT should still be full
    assert rl.check_and_consume("SCOUT") is True
    assert rl.check_and_consume("WORKER") is True


def test_rate_limiter_check_and_consume_returns_bool():
    """check_and_consume returns True when allowed, False when rate-limited."""
    rl = RateLimiter(capacities={"TEST": 2}, fallback_capacity=2)
    assert rl.check_and_consume("TEST") is True
    assert rl.check_and_consume("TEST") is True
    assert rl.check_and_consume("TEST") is False


def test_rate_limiter_custom_capacities():
    """RateLimiter accepts custom capacity overrides."""
    rl = RateLimiter(capacities={"MYAGENT": 7}, fallback_capacity=3)
    assert rl._get_bucket("MYAGENT").capacity == 7
    assert rl._get_bucket("OTHER").capacity == 3


def test_rate_limiter_thread_safety():
    """Concurrent consumes never grant more tokens than capacity."""
    capacity = 10
    rl = RateLimiter(capacities={"SAFE": capacity}, fallback_capacity=capacity)
    successes = []
    lock = threading.Lock()

    def consume():
        result = rl.check_and_consume("SAFE")
        with lock:
            successes.append(result)

    threads = [threading.Thread(target=consume) for _ in range(capacity * 3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert successes.count(True) <= capacity, (
        f"Granted {successes.count(True)} tokens but capacity is {capacity}"
    )
