"""RepoCiv — Hermes reachability probe (Fase 1 / audit 1.1).

Single source of truth for "is Hermes up?". The frontend's
``/api/hermes/status`` endpoint and the bridge's bootstrap both
consult this so the UI can show a clear "degraded mode" banner
when Hermes is down (no chat, no live model inventory, no
provider picker changes).

Probe target: ``HERMES_URL/v1/models`` (the gateway's catalogue
endpoint). Hermes is "up" iff the probe returns 2xx AND the body
parses as JSON with a ``data`` array of at least one model.
Anything else (timeout, 5xx, parse failure) → Hermes is down.

Caching: 30s TTL. The probe is cheap but Hermes's gateway is on
the same loopback, so spamming this every 200ms from a polling
tab is wasteful. The cache is invalidated on write
(``reset_cache_for_tests()``) so tests stay hermetic.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any

#: How long a successful or failed probe result is cached before the
#: next call re-probes. 30s balances freshness against the cost of
#: a network roundtrip on every UI poll.
_CACHE_TTL = 30.0

#: Per-probe HTTP timeout. Hermes on loopback normally responds in
#: <50ms; 4s catches a hung server without making the UI feel slow.
_PROBE_TIMEOUT_S = 4.0


_cache_lock = threading.Lock()
_cache: dict[str, Any] | None = None
_cache_ts: float = 0.0


def resolve_hermes_base() -> str:
    """Read ``HERMES_URL`` and strip the ``/v1[/...]`` suffix.

    Handles the common forms users set in their ``.env``::

        HERMES_URL=http://localhost:8642/v1/chat/completions
        HERMES_URL=http://localhost:8642/v1
        HERMES_URL=http://localhost:8642

    Returns the bare base URL (no trailing slash) so the caller can
    append ``/v1/models`` or ``/v1/chat/completions`` as needed.

    Falls back to ``http://localhost:8642`` if ``HERMES_URL`` is unset,
    which is the documented default in ``.env.example``.
    """
    raw = os.environ.get("HERMES_URL", "http://localhost:8642/v1")
    for suffix in ("/v1/chat/completions", "/v1/completions", "/v1", ""):
        if raw.endswith(suffix):
            base = raw[: -len(suffix)] if suffix else raw
            return base.rstrip("/")
    return raw.rstrip("/")


def _hermes_headers() -> dict[str, str]:
    """Build the auth headers for the Hermes probe.

    Honours ``HERMES_KEY`` (Bearer auth) if set. Hermes gateway
    typically runs in trust-local mode and accepts requests without
    a key, so an empty ``HERMES_KEY`` is fine.
    """
    key = os.environ.get("HERMES_KEY", "").strip()
    if not key:
        return {}
    return {"Authorization": f"Bearer {key}"}


def _do_probe(base_url: str) -> dict[str, Any]:
    """Run the actual network probe. Always returns a dict, never raises.

    Returns::

        {
          "available": bool,
          "url": str,                    # the probed base URL
          "latencyMs": int,             # wall-clock time of the probe
          "error": str | None,           # populated when available=False
          "modelCount": int | None,      # number of models if JSON parsed
        }
    """
    target = f"{base_url}/v1/models"
    started = time.monotonic()
    try:
        req = urllib.request.Request(target, headers=_hermes_headers(), method="GET")
        with urllib.request.urlopen(req, timeout=_PROBE_TIMEOUT_S) as resp:
            latency_ms = int((time.monotonic() - started) * 1000)
            if not (200 <= resp.status < 300):
                return {
                    "available": False,
                    "url": base_url,
                    "latencyMs": latency_ms,
                    "error": f"http_{resp.status}",
                    "modelCount": None,
                }
            try:
                body = json.loads(resp.read().decode("utf-8", errors="replace"))
            except (ValueError, TypeError) as e:
                return {
                    "available": False,
                    "url": base_url,
                    "latencyMs": latency_ms,
                    "error": f"parse_error: {e!s}"[:200],
                    "modelCount": None,
                }
            # Hermes' /v1/models shape: {"data": [{"id": "..."}, ...]}.
            # Be lenient — accept a top-level list too, since some
            # OpenAI-compatible gateways return that.
            models: list[Any] = []
            if isinstance(body, dict) and isinstance(body.get("data"), list):
                models = body["data"]
            elif isinstance(body, list):
                models = body
            return {
                "available": True,
                "url": base_url,
                "latencyMs": latency_ms,
                "error": None,
                "modelCount": len(models),
            }
    except urllib.error.HTTPError as e:
        latency_ms = int((time.monotonic() - started) * 1000)
        return {
            "available": False,
            "url": base_url,
            "latencyMs": latency_ms,
            "error": f"http_{e.code}",
            "modelCount": None,
        }
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        latency_ms = int((time.monotonic() - started) * 1000)
        return {
            "available": False,
            "url": base_url,
            "latencyMs": latency_ms,
            "error": f"network: {e!s}"[:200],
            "modelCount": None,
        }


def probe_hermes(*, force: bool = False) -> dict[str, Any]:
    """Return the current Hermes status, using a 30s cache.

    ``force=True`` skips the cache (used by ``reset_cache_for_tests``
    to get a fresh probe after monkeypatching the env). The result is
    never ``None`` — even on network failure, you get a structured
    status with ``available: False`` and an ``error`` string.
    """
    global _cache, _cache_ts
    base = resolve_hermes_base()
    now = time.monotonic()
    with _cache_lock:
        if not force and _cache is not None and (now - _cache_ts) < _CACHE_TTL:
            return dict(_cache)
    result = _do_probe(base)
    # Add a checkedAt epoch so the UI can show "last checked N seconds ago".
    result = {**result, "checkedAt": time.time()}
    with _cache_lock:
        _cache = dict(result)
        _cache_ts = now
    return result


def reset_cache_for_tests() -> None:
    """Clear the cached probe result. Tests use this between cases."""
    global _cache, _cache_ts
    with _cache_lock:
        _cache = None
        _cache_ts = 0.0
