"""RepoCiv — D2: Per-agent-type token-bucket rate limiter.

Each agent type gets its own independent TokenBucket. Requests exceeding
the bucket capacity are rejected.

Default capacities (burst; refills at cap/60 tokens per second):
  WORKER = 10
  SCOUT  = 20
  DAVI   = 5
  *      = 15  (catch-all for unknown agent types)

Thread-safe: every shared state is protected by threading.Lock.
"""

from __future__ import annotations

import threading
import time

# ─── Default capacities per agent type ───────────────────────────────────────
_DEFAULT_CAPACITIES: dict[str, int] = {
    "WORKER": 10,
    "SCOUT": 20,
    "MAIN": 5,
}
_FALLBACK_CAPACITY = 15


# ─── Token Bucket ─────────────────────────────────────────────────────────────

class TokenBucket:
    """Thread-safe token bucket for a single rate-limit slot."""

    def __init__(self, capacity: int, refill_rate: float) -> None:
        """
        Args:
            capacity:    Maximum number of tokens (burst size).
            refill_rate: Tokens added per second (continuous refill).
        """
        self._capacity = capacity
        self._refill_rate = refill_rate  # tokens / second
        self._tokens = float(capacity)
        self._last_refill = time.monotonic()
        self._lock = threading.Lock()

    @property
    def capacity(self) -> int:
        return self._capacity

    def consume(self) -> bool:
        """Try to consume one token. Returns True if allowed, False if exhausted."""
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_refill
            self._tokens = min(
                float(self._capacity),
                self._tokens + elapsed * self._refill_rate,
            )
            self._last_refill = now
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True
            return False

    def available(self) -> float:
        """Return current token count (snapshot, for introspection/tests)."""
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_refill
            return min(
                float(self._capacity),
                self._tokens + elapsed * self._refill_rate,
            )


# ─── Rate Limiter ─────────────────────────────────────────────────────────────

class RateLimiter:
    """Per-agent-type rate limiter backed by independent TokenBuckets."""

    def __init__(
        self,
        capacities: dict[str, int] | None = None,
        fallback_capacity: int = _FALLBACK_CAPACITY,
    ) -> None:
        self._caps: dict[str, int] = {
            k.upper(): v for k, v in (_DEFAULT_CAPACITIES if capacities is None else capacities).items()
        }
        self._fallback = fallback_capacity
        self._buckets: dict[str, TokenBucket] = {}
        self._lock = threading.Lock()

    def _get_bucket(self, agent_type: str) -> TokenBucket:
        key = agent_type.upper()
        with self._lock:
            if key not in self._buckets:
                cap = self._caps.get(key, self._fallback)
                # Full refill roughly every 60 seconds
                self._buckets[key] = TokenBucket(cap, cap / 60.0)
            return self._buckets[key]

    def check_and_consume(self, agent_type: str) -> bool:
        """Return True if the agent may proceed; False if rate-limited."""
        return self._get_bucket(agent_type).consume()


# ─── Endpoint Rate Limiter (Fase 1 / audit 1.2) ────────────────────────────────
# Per-HTTP-endpoint TokenBucket. Defense in depth on top of the global
# per-IP limiter in bridge.py:807-810. Even if a single IP can make
# 60 requests/minute total, an *expensive* endpoint (e.g. /commands,
# /api/graph-relations/refresh) is capped at a much tighter budget so
# a misbehaving tab or a malicious extension can't pin the CPU with
# index rebuilds or agent spawns.
#
# Configuration is global (not per-IP) — a single budget per endpoint
# category. The per-IP check in do_POST already prevents a single
# caller from monopolising the budget; this stops the total aggregate
# cost of the endpoint across all callers.
class EndpointRateLimiter:
    """Global per-endpoint TokenBucket limiter.

    Each named endpoint gets its own bucket. The ``capacities`` dict
    configures the burst (== refill_per_minute) per endpoint. Endpoints
    not in the dict have no limit (returns True always). Thread-safe.
    """

    def __init__(self, capacities: dict[str, int] | None = None) -> None:
        # capacity: max burst. Refill rate is capacity / 60 per second,
        # so the bucket fully refills in ~60s. Mirrors RateLimiter.
        self._caps: dict[str, int] = dict(capacities or {})
        self._buckets: dict[str, TokenBucket] = {}
        self._lock = threading.Lock()

    def _get_bucket(self, endpoint: str) -> TokenBucket | None:
        cap = self._caps.get(endpoint)
        if cap is None:
            return None
        with self._lock:
            if endpoint not in self._buckets:
                self._buckets[endpoint] = TokenBucket(cap, cap / 60.0)
            return self._buckets[endpoint]

    def check_and_consume(self, endpoint: str) -> bool:
        """Return True if the endpoint may proceed; False if rate-limited.

        Endpoints not configured in ``capacities`` are unlimited and
        always return True.
        """
        bucket = self._get_bucket(endpoint)
        if bucket is None:
            return True
        return bucket.consume()

    def capacity(self, endpoint: str) -> int:
        """Return the configured burst for an endpoint, or 0 if unlimited."""
        return self._caps.get(endpoint, 0)

    def available(self, endpoint: str) -> float:
        """Return the current token count for an endpoint (0 if unlimited)."""
        bucket = self._get_bucket(endpoint)
        return 0.0 if bucket is None else bucket.available()

    def reset(self) -> None:
        """Clear all per-endpoint buckets. Tests use this for isolation.

        After reset, the next call to ``check_and_consume`` for any
        configured endpoint creates a fresh full bucket. Does not
        change the configured capacities.
        """
        with self._lock:
            self._buckets.clear()
