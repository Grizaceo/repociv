"""RepoCiv — environment-variable redaction for child-process spawns.

When the bridge spawns sub-agents, wonders, or editor helpers via
``subprocess``, Python copies the parent process environment unless
``env=`` is set explicitly. That means every API key, OAuth token,
or SSH key present in the running bridge leaks into the child.

This module provides :func:`redact_env_for_spawn`, a single-entry
helper every spawn path can use. It removes:

  • exact-name matches from ``DEFAULT_DENYLIST`` (Anthropic / OpenAI /
    AWS / GitHub / Google / Stripe / NPM / Claude OAuth tokens);
  • heuristic matches — any name ending in ``_KEY``, ``_SECRET``,
    ``_TOKEN``, ``_PASSWORD`` that is NOT explicitly kept by the
    caller.

Callers can opt back in with ``extra_keep={...}`` (e.g. the LGB
launcher legitimately needs ``LGB_HOST`` / ``BRIDGE_HOST`` to bind
on 0.0.0.0). ``redact_env_for_spawn`` is idempotent: redacting an
already-redacted env returns the same dict (with the same redacted
count log, so the operation is observable without leaking values).

The original parent env is never mutated — we always return a fresh
``dict`` so callers can safely compose it with their own overrides.

Design choices:
  • Operate on ``MutableMapping`` so callers can pass a copy or a
    custom mapping.
  • Never log the *values* (only the names). This avoids accidentally
    creating an audit log that itself leaks secrets.
  • Heuristics cover the long tail (``*_KEY`` etc.) so a forgotten
    explicit denylist entry does not silently pass through.
"""
from __future__ import annotations

import logging
import os
import re
from collections.abc import Iterable, MutableMapping
from typing import Final

_logger = logging.getLogger(__name__)

#: Exact-name denylist. Lower-cased. Any env var whose name (case-insensitive)
#: matches one of these is unconditionally redacted from the spawn env.
DEFAULT_DENYLIST: Final[frozenset[str]] = frozenset(
    {
        # Anthropic / Claude
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        # OpenAI
        "OPENAI_API_KEY",
        # AWS
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        # GitHub
        "GITHUB_TOKEN",
        "GH_TOKEN",
        # Google
        "GOOGLE_API_KEY",
        # Stripe
        "STRIPE_SECRET_KEY",
        # NPM
        "NPM_TOKEN",
    }
)

#: Heuristic suffix denylist. Any env var whose name ends with one of
#: these (case-insensitive) is redacted unless explicitly kept.
_HEURISTIC_SUFFIXES: Final[tuple[str, ...]] = (
    "_KEY",
    "_APIKEY",
    "_SECRET",
    "_TOKEN",
    "_PASSWORD",
    "_PASSWD",
    "_PRIVATE_KEY",
    "_PRIVATEKEY",
)

#: Vars that look like secrets but are operational — keep these by default.
#: The launcher can override this with ``extra_keep``.
_DEFAULT_KEEP: Final[frozenset[str]] = frozenset(
    {
        "PATH",
        "HOME",
        "USER",
        "LANG",
        "LC_ALL",
        "TZ",
        "SHELL",
        "TERM",
        "PWD",
        "OLDPWD",
        "LOGNAME",
        "TMPDIR",
    }
)

#: Canonical placeholder used when a sensitive var is present but we do not
#: want to leak its value to the child. Empty string is also valid; we use
#: an explicit placeholder so absence vs redaction is distinguishable in
#: debug logs.
_REDACTED_PLACEHOLDER: Final[str] = "<REDACTED_BY_REPOCIV>"


#: Public alias of :data:`_REDACTED_PLACEHOLDER`. Exposed under ``REDACTED_PLACEHOLDER``
#: for callers and tests that want to detect or compare against the placeholder.
REDACTED_PLACEHOLDER: Final[str] = _REDACTED_PLACEHOLDER


def _matches_heuristic(name: str) -> bool:
    up = name.upper()
    return any(up.endswith(s) for s in _HEURISTIC_SUFFIXES)


def redact_env_for_spawn(
    parent_env: MutableMapping[str, str] | None = None,
    *,
    extra_keep: Iterable[str] | None = None,
    redact_value: str = _REDACTED_PLACEHOLDER,
) -> dict[str, str]:
    """Return a dict safe to pass as ``env=`` to ``subprocess.*``.

    Walks the parent env, copying through all non-sensitive keys and
    replacing sensitive values with ``redact_value`` (default:
    ``<REDACTED_BY_REPOCIV>``).

    :param parent_env: source environment. Defaults to ``os.environ``.
    :param extra_keep: variable names (case-insensitive) the caller wants
        preserved even if they match the heuristic denylist (e.g.
        ``LGB_HOST``).
    :param redact_value: replacement string for sensitive values; use
        empty string if you want the var removed entirely. Defaults to
        a non-empty placeholder so the spawn can distinguish "missing"
        from "redacted" via its own logic.
    :returns: a new dict with sensitive values redacted. Always a fresh
        dict — the input ``parent_env`` is never mutated.
    """
    src = parent_env if parent_env is not None else os.environ
    keep_extras = {k.upper() for k in (extra_keep or ())}
    keep_everything = "*" in keep_extras
    out: dict[str, str] = {}
    redacted = 0
    redacted_by_heuristic = 0

    # Use deterministic ordering so two redacted envs diff identically.
    # OS-environ ordering on Linux is insertion-order so this is stable
    # for in-process reads. Pure-dict inputs are similarly ordered.
    for name in sorted(src.keys(), key=str.upper):
        value = src[name]
        up = name.upper()

        # 1) Always-keep operational defaults.
        if up in _DEFAULT_KEEP:
            out[name] = value
            continue

        # 2) Caller keeps it explicitly.
        if up in keep_extras or keep_everything:
            out[name] = value
            continue

        # 3) Exact-name denylist.
        if up in DEFAULT_DENYLIST:
            out[name] = redact_value
            redacted += 1
            continue

        # 4) Heuristic suffix denylist (*_KEY, *_SECRET, ...).
        if _matches_heuristic(name):
            out[name] = redact_value
            redacted += 1
            redacted_by_heuristic += 1
            continue

        # 5) Pass through.
        out[name] = value

    if redacted:
        _logger.info(
            "[env_filter] redacted %d sensitive env vars (heuristic=%d) before spawn",
            redacted,
            redacted_by_heuristic,
        )

    return out


__all__ = [
    "DEFAULT_DENYLIST",
    "REDACTED_PLACEHOLDER",
    "redact_env_for_spawn",
]  # public surface for tests and external callers
