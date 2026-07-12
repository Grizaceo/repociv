"""RepoCiv — token + bind security policy.

Single source of truth for the bridge and websocket startup checks
enforced at import time. Keeping it in one place means the HTTP bridge
and the WebSocket transport never drift on what counts as "safe".

Enforced invariants (Fase 0 / audit 0.4):
  1. If ``REPOCIV_TOKEN`` is set, it MUST be ``>= MIN_TOKEN_LENGTH``
     characters. This catches footguns like ``REPOCIV_TOKEN=dev`` that
     silently run with a guessable secret.
  2. If the bridge is bound to a non-loopback address, ``REPOCIV_TOKEN``
     MUST be set (not empty). Refuses to start instead of warning —
     the warning is easy to miss in a long boot log.
  3. If ``REPOCIV_TOKEN`` is empty in local (loopback) mode, emit a
     ``UserWarning``: browser mutations and streams remain same-origin-only,
     but non-browser clients need a token.

The "warning vs refuse" decision for case (2) follows the audit's
stronger option (refuse). The warning-vs-exit split between (1) and
(3) keeps the dev path quiet while making misconfiguration loud.

Usage from bridge.py / websocket_handler.py:

    from server._security import enforce_token_policy, MIN_TOKEN_LENGTH

    if REPOCIV_TOKEN and len(REPOCIV_TOKEN) < MIN_TOKEN_LENGTH:
        # exit / raise (we use raise for the helper signature, callers
        # can convert to SystemExit if they prefer).
        ...
    enforce_token_policy(
        token=REPOCIV_TOKEN,
        bind_host=BRIDGE_HOST,
        remote=REPOCIV_REMOTE,
        component="bridge",
    )
"""

from __future__ import annotations

import hmac
import sys
import warnings
from typing import Final, Iterable

#: Minimum acceptable token length when REPOCIV_TOKEN is set. Picked to
#: match the docs and the existing remote-mode check; 32 hex chars =
#: 128 bits of entropy, which is the modern floor for shared-secret
#: auth tokens.
MIN_TOKEN_LENGTH: Final[int] = 32

#: Loopback host literals treated as "safe" — binding the bridge here
#: means only the local machine can reach it, so the empty-token dev
#: mode is acceptable.
_LOOPBACK_HOSTS: Final[frozenset[str]] = frozenset(
    {"127.0.0.1", "::1", "localhost", "0.0.0.0"}  # 0.0.0.0 is "all" — see below
)
# Note: 0.0.0.0 is intentionally treated as NON-loopback for this check
# because it accepts connections on every interface. The function below
# checks the resolved bind host, not the source.

_NON_LOOPBACK_HOSTS: Final[frozenset[str]] = frozenset(
    {"0.0.0.0", "::", "[::]"}
)


def _is_loopback_bind(host: str) -> bool:
    """Return True if ``host`` is a loopback bind address.

    127.0.0.1 / ::1 / localhost → loopback. 0.0.0.0 / :: → all interfaces,
    treated as NON-loopback (the auth check below is conservative).
    """
    if not host:
        return False
    h = host.strip().lower()
    if h in _NON_LOOPBACK_HOSTS:
        return False
    return h in _LOOPBACK_HOSTS or h.startswith("127.")


def _emit_token_too_short_error(token: str, component: str) -> None:
    """Print the loud "token too short" message and raise SystemExit."""
    actual = len(token) if token else 0
    msg = (
        f"[{component}] REPOCIV_TOKEN is set but is only {actual} chars. "
        f"RepoCiv requires >= {MIN_TOKEN_LENGTH} characters when a token is configured. "
        f"Generate a new one with: "
        f'python3 -c "import secrets; print(secrets.token_hex(32))"'
    )
    print(msg, file=sys.stderr)
    raise SystemExit(1)


def _emit_no_token_non_loopback_error(
    bind_host: str, component: str, *, has_remote: bool
) -> None:
    """Refuse to start when a non-loopback bind has no token."""
    why = "REPOCIV_REMOTE=true" if has_remote else f"BRIDGE_WS_HOST={bind_host!r}"
    msg = (
        f"[{component}] refusing to bind {bind_host!r} without REPOCIV_TOKEN. "
        f"({why}). "
        f"Either set REPOCIV_TOKEN to a {MIN_TOKEN_LENGTH}+ char secret, "
        f"or unset {why.split('=')[0]} and bind to 127.0.0.1."
    )
    print(msg, file=sys.stderr)
    raise SystemExit(1)


def build_allowed_origins(
    port: int, *, remote: bool, remote_origin: str, extra_origins: str
) -> set[str]:
    origins = {f"http://localhost:{port}", f"http://127.0.0.1:{port}"}
    if remote and remote_origin.strip():
        origins.add(remote_origin.strip())
    origins.update(origin.strip() for origin in extra_origins.split(",") if origin.strip())
    return origins


def _token_matches(received: str, expected: str) -> bool:
    return bool(received and expected) and hmac.compare_digest(
        received.encode("utf-8"), expected.encode("utf-8")
    )


def is_trusted_mutation(
    *,
    expected_token: str,
    received_token: str,
    origin: str,
    content_type: str,
    allowed_origins: Iterable[str],
) -> bool:
    media_type = content_type.partition(";")[0].strip().lower()
    if media_type != "application/json":
        return False
    if expected_token:
        return _token_matches(received_token, expected_token)
    return bool(origin) and origin in set(allowed_origins)


def is_trusted_stream(
    expected_token: str,
    received_token: str,
    origin: str,
    allowed_origins: Iterable[str],
) -> bool:
    if expected_token:
        return _token_matches(received_token, expected_token)
    return bool(origin) and origin in set(allowed_origins)


def enforce_token_policy(
    *,
    token: str,
    bind_host: str,
    remote: bool,
    component: str,
) -> None:
    """Run the bridge/ws startup checks. Raises SystemExit on hard errors.

    Callers can pass the resolved bind host and the REPOCIV_REMOTE flag;
    this function is the single source of truth for what counts as a
    safe configuration. ``component`` is a short label used in error
    messages (``"bridge"``, ``"ws"``).

    Behaviour:

    1. ``token`` non-empty AND ``len(token) < MIN_TOKEN_LENGTH`` →
       SystemExit (loud error).
    2. ``token`` empty AND bind is non-loopback (either ``remote=True``
       OR the host is 0.0.0.0 / ::) → SystemExit (refuse).
    3. ``token`` empty AND bind is loopback → emit a UserWarning so the
       operator sees it in the boot log. (Does not exit — dev mode is
       a documented default.)
    """
    # (1) token set but too short — always fail
    if token and len(token) < MIN_TOKEN_LENGTH:
        _emit_token_too_short_error(token, component)
        return  # for type checkers; the function above raises

    # (2) bind is non-loopback and no token — refuse
    if not token and (remote or not _is_loopback_bind(bind_host)):
        _emit_no_token_non_loopback_error(bind_host, component, has_remote=remote)
        return

    # (3) loopback + no token — warn once, don't exit
    if not token and _is_loopback_bind(bind_host):
        warnings.warn(
            f"[{component}] REPOCIV_TOKEN is empty. The bridge is bound to "
            f"{bind_host!r}; browser mutations and streams are restricted to "
            f"allowlisted Origins. Set REPOCIV_TOKEN to a {MIN_TOKEN_LENGTH}+ char "
            f"secret for MCP, CLI, remote, or other non-browser clients.",
            UserWarning,
            stacklevel=2,
        )


__all__ = [
    "MIN_TOKEN_LENGTH",
    "enforce_token_policy",
    "_is_loopback_bind",  # exported for tests
]
