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
    "DAVI": 5,
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
