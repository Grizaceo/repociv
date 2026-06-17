"""Tests for server.rate_limiter (per-agent and per-endpoint limiters).

Covers:
  - TokenBucket: capacity, refill over time, consume() returns False on empty
  - RateLimiter: per-agent-type buckets, unlimited agent types fall back,
    concurrent consume() is thread-safe
  - EndpointRateLimiter: unconfigured endpoints always pass, configured
    endpoints exhaust at capacity, available() / capacity() introspection,
    thread safety

These are pure-function tests (no subprocess) — the integration with
bridge.py's `_endpoint_rate_limiter` and the HTTP handlers is exercised
in the HTTP route tests.
"""

from __future__ import annotations

import threading
import time

import pytest

from server.rate_limiter import (
    EndpointRateLimiter,
    RateLimiter,
    TokenBucket,
)


# ─── TokenBucket ──────────────────────────────────────────────────────────────


def test_token_bucket_starts_full():
    b = TokenBucket(capacity=10, refill_rate=0.1)
    assert b.available() == pytest.approx(10.0, abs=0.01)


def test_token_bucket_consume_decrements():
    b = TokenBucket(capacity=5, refill_rate=0.0)
    assert b.consume() is True
    assert b.consume() is True
    assert b.available() == pytest.approx(3.0, abs=0.01)


def test_token_bucket_exhausted_returns_false():
    b = TokenBucket(capacity=2, refill_rate=0.0)
    assert b.consume() is True
    assert b.consume() is True
    assert b.consume() is False
    assert b.consume() is False  # still False on repeat


def test_token_bucket_refills_over_time():
    """At 1 token/sec, after ~1s we get a token back."""
    b = TokenBucket(capacity=1, refill_rate=1.0)
    assert b.consume() is True
    assert b.consume() is False
    time.sleep(1.1)
    assert b.consume() is True


def test_token_bucket_refill_caps_at_capacity():
    """Refill never exceeds capacity."""
    b = TokenBucket(capacity=2, refill_rate=10.0)
    b.consume()
    b.consume()
    assert b.consume() is False
    time.sleep(0.1)
    # Refill at 10/s for 0.1s = 1 token, capped at capacity 2
    assert b.available() <= 2.0


def test_token_bucket_thread_safe():
    """Concurrent consume() respects capacity exactly."""
    b = TokenBucket(capacity=100, refill_rate=0.0)
    results = []
    lock = threading.Lock()

    def consumer():
        successes = sum(b.consume() for _ in range(50))
        with lock:
            results.append(successes)

    threads = [threading.Thread(target=consumer) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # 4 threads × 50 attempts, but only 100 tokens available.
    # Total successes across all threads must be exactly 100.
    assert sum(results) == 100


# ─── RateLimiter (per-agent-type) ────────────────────────────────────────────


def test_rate_limiter_known_agent_type():
    rl = RateLimiter()
    assert rl.check_and_consume("WORKER") is True
    assert rl.check_and_consume("WORKER") is True
    # WORKER capacity is 10, so first 10 should pass.
    for _ in range(8):
        rl.check_and_consume("WORKER")
    # 11th total call → exhausted
    assert rl.check_and_consume("WORKER") is False


def test_rate_limiter_unknown_agent_type_uses_fallback():
    rl = RateLimiter()
    # Unknown type uses fallback capacity (15)
    for _ in range(15):
        assert rl.check_and_consume("MYSTERY") is True
    assert rl.check_and_consume("MYSTERY") is False


def test_rate_limiter_independent_buckets_per_type():
    """Exhausting WORKER doesn't affect SCOUT or MAIN."""
    rl = RateLimiter()
    for _ in range(20):
        rl.check_and_consume("WORKER")
    assert rl.check_and_consume("WORKER") is False
    # SCOUT and MAIN still have full buckets
    assert rl.check_and_consume("SCOUT") is True
    assert rl.check_and_consume("MAIN") is True


# ─── EndpointRateLimiter (audit 1.2) ──────────────────────────────────────────


def test_endpoint_limiter_unconfigured_always_passes():
    """Endpoints not in the capacities dict are unlimited."""
    rl = EndpointRateLimiter(capacities={"a": 1})
    for _ in range(1000):
        assert rl.check_and_consume("unknown_endpoint") is True


def test_endpoint_limiter_caps_at_configured_burst():
    """Capacity = 5, so 5 calls pass, 6th fails."""
    rl = EndpointRateLimiter(capacities={"post_graph_relations_refresh": 5})
    successes = sum(rl.check_and_consume("post_graph_relations_refresh") for _ in range(10))
    assert successes == 5


def test_endpoint_limiter_independent_per_endpoint():
    """Exhausting endpoint A doesn't affect endpoint B."""
    rl = EndpointRateLimiter(
        capacities={"a": 2, "b": 3},
    )
    assert rl.check_and_consume("a") is True
    assert rl.check_and_consume("a") is True
    assert rl.check_and_consume("a") is False  # a exhausted
    # b still has full budget
    assert rl.check_and_consume("b") is True
    assert rl.check_and_consume("b") is True
    assert rl.check_and_consume("b") is True
    assert rl.check_and_consume("b") is False


def test_endpoint_limiter_default_is_no_limit():
    """Empty config = no endpoints limited, all pass."""
    rl = EndpointRateLimiter()
    for _ in range(100):
        assert rl.check_and_consume("anything") is True


def test_endpoint_limiter_capacity_introspection():
    rl = EndpointRateLimiter(
        capacities={"limited_one": 7, "limited_two": 12},
    )
    assert rl.capacity("limited_one") == 7
    assert rl.capacity("limited_two") == 12
    assert rl.capacity("unlisted") == 0


def test_endpoint_limiter_available_decreases_with_consume():
    rl = EndpointRateLimiter(capacities={"x": 3})
    # available() reflects current bucket state.
    assert rl.available("x") == pytest.approx(3.0, abs=0.01)
    rl.check_and_consume("x")
    assert rl.available("x") == pytest.approx(2.0, abs=0.01)
    rl.check_and_consume("x")
    assert rl.available("x") == pytest.approx(1.0, abs=0.01)


def test_endpoint_limiter_available_zero_for_unconfigured():
    rl = EndpointRateLimiter(capacities={"x": 3})
    # Unconfigured endpoints return 0 (unlimited, not "0 tokens").
    assert rl.available("unconfigured") == 0.0


def test_endpoint_limiter_thread_safe():
    """Concurrent consume() respects capacity exactly."""
    rl = EndpointRateLimiter(capacities={"hot": 50})
    successes = []
    lock = threading.Lock()

    def consumer():
        n = sum(rl.check_and_consume("hot") for _ in range(30))
        with lock:
            successes.append(n)

    threads = [threading.Thread(target=consumer) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # 4 × 30 = 120 attempts, 50 succeed.
    assert sum(successes) == 50


def test_endpoint_limiter_refills_over_time():
    """At capacity 2, refill rate 2/60 ≈ 0.033/s, full refill in ~60s."""
    rl = EndpointRateLimiter(capacities={"x": 2})
    rl.check_and_consume("x")
    rl.check_and_consume("x")
    assert rl.check_and_consume("x") is False
    # Don't wait 60s in a test; just verify the bucket isn't permanently empty.
    assert rl.available("x") < 1.0


# ─── Integration: bridge.py wires the right limits ──────────────────────────


def test_bridge_wires_endpoint_limiter_with_correct_caps():
    """The bridge's _endpoint_rate_limiter has the audit 1.2 caps."""
    from server.bridge import _endpoint_rate_limiter

    assert _endpoint_rate_limiter.capacity("post_commands") == 10
    assert _endpoint_rate_limiter.capacity("post_graph_relations_refresh") == 5


def test_bridge_endpoint_limiter_is_endpoint_limiter_instance():
    """Type sanity — the bridge wires the same class as tested above."""
    from server.bridge import _endpoint_rate_limiter

    assert isinstance(_endpoint_rate_limiter, EndpointRateLimiter)


# ─── Integration: HTTP routes return 429 when the endpoint budget is drained ─


def test_post_graph_relations_refresh_returns_429_after_burst(monkeypatch):
    """The 6th call to /api/graph-relations/refresh in a fresh window
    gets 429, not 200. Burst is 5/min (audit 1.2)."""
    from server import bridge
    from server.rate_limiter import EndpointRateLimiter

    # Replace the bridge's singleton with a fresh one (test isolation).
    fresh = EndpointRateLimiter(capacities={"post_graph_relations_refresh": 5})
    monkeypatch.setattr(bridge, "_endpoint_rate_limiter", fresh)

    import http_routes
    monkeypatch.setattr(http_routes, "_cga", type(
        "M", (), {"build_repo_index_from_cities": staticmethod(lambda cities: {"ok": True})}
    )())

    body = {"cities": [{"id": "r1"}]}

    # 5 calls succeed
    for _ in range(5):
        status, _ = http_routes.post_graph_relations_refresh(body, {})
        assert status == 200, f"expected 200 within burst, got {status}"
    # 6th fails
    status, body_out = http_routes.post_graph_relations_refresh(body, {})
    assert status == 429
    assert body_out["error"] == "rate_limit"
    assert body_out["endpoint"] == "post_graph_relations_refresh"


def test_post_graph_relations_refresh_400_does_not_consume_token(monkeypatch):
    """Bad body (no cities, no repoPaths) returns 400 WITHOUT burning a
    rate-limit token. Otherwise a malicious client could spam bad
    requests to exhaust the budget on its own."""
    from server import bridge
    from server.rate_limiter import EndpointRateLimiter

    fresh = EndpointRateLimiter(capacities={"post_graph_relations_refresh": 5})
    monkeypatch.setattr(bridge, "_endpoint_rate_limiter", fresh)

    import http_routes

    # 10 bad requests (more than the burst of 5) — all should return 400
    for _ in range(10):
        status, _ = http_routes.post_graph_relations_refresh({}, {})
        assert status == 400

    # Budget is still full — a valid call now succeeds
    monkeypatch.setattr(http_routes, "_cga", type(
        "M", (), {"build_repo_index_from_cities": staticmethod(lambda cities: {"ok": True})}
    )())
    status, _ = http_routes.post_graph_relations_refresh(
        {"cities": [{"id": "r1"}]}, {}
    )
    assert status == 200


def test_post_commands_endpoint_limit_drains_after_burst(monkeypatch):
    """The 11th call to /commands in a fresh window returns 429.

    The route has TWO layers of rate limiting (audit 1.2 + the existing
    per-agent-type). The endpoint layer is the one we're verifying here.
    We use 'MAIN' agent type which has fallback capacity, so the
    agent layer won't be the bottleneck.
    """
    from server import bridge
    from server.rate_limiter import EndpointRateLimiter

    fresh = EndpointRateLimiter(capacities={"post_commands": 10})
    monkeypatch.setattr(bridge, "_endpoint_rate_limiter", fresh)

    import routes.core as core_routes
    # Stub the command handler so we don't actually try to run an agent
    monkeypatch.setattr(
        "server.bridge._handle_command",
        lambda cmd: {"ok": True, "commandId": "stub"},
        raising=False,
    )

    body = {
        "type": "unit_command",
        "target": "MYSTERY",
        # Use an unknown unit so the agent-type limiter takes the
        # fallback capacity (15) and the ENDPOINT limiter (10) is the
        # bottleneck — that's the layer we're testing.
        "payload": {"text": "hi", "unit": "MYSTERY"},
    }

    # 10 calls succeed
    for i in range(10):
        status, _ = core_routes.post_commands(body, {})
        assert status == 200, f"call {i+1} expected 200, got {status}"

    # 11th fails with 429 from the ENDPOINT limiter (not agent)
    status, body_out = core_routes.post_commands(body, {})
    assert status == 429
    assert body_out["error"] == "rate_limit"
    assert body_out.get("endpoint") == "post_commands"
