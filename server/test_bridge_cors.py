"""Tests for bridge CORS allowed-origins builder (F2.2 — WSL2 / Tailscale).

The CORS allowlist is a frozen set at module import time, but the
build logic is exposed via ``_build_allowed_origins()`` so we can
test it without reloading ``server.bridge`` (which would invalidate
the class identity of ``WonderLauncherError`` for sibling tests).
"""

from __future__ import annotations

from server.bridge import _build_allowed_origins


def test_default_local_origins():
    out = _build_allowed_origins(port=5273, remote=False, remote_origin="", extra_origins="")
    assert "http://localhost:5273" in out
    assert "http://127.0.0.1:5273" in out
    assert len(out) == 2


def test_cors_origins_env_adds_extra():
    """F2.2 regression: WSL2 IP must be accepted without enabling remote."""
    out = _build_allowed_origins(
        port=5273,
        remote=False,
        remote_origin="",
        extra_origins="http://100.123.206.92:5273",
    )
    assert "http://100.123.206.92:5273" in out
    assert "http://localhost:5273" in out
    assert "http://127.0.0.1:5273" in out


def test_cors_origins_env_multiple():
    """F2.2: comma-separated extra origins."""
    out = _build_allowed_origins(
        port=5273,
        remote=False,
        remote_origin="",
        extra_origins=("http://100.123.206.92:5273, http://my-tailscale-host.ts.net:5273"),
    )
    assert "http://100.123.206.92:5273" in out
    assert "http://my-tailscale-host.ts.net:5273" in out


def test_cors_origins_env_strips_whitespace():
    """F2.2: trailing/leading whitespace per origin is trimmed."""
    out = _build_allowed_origins(
        port=5273,
        remote=False,
        remote_origin="",
        extra_origins="  http://100.123.206.92:5273  ",
    )
    assert "http://100.123.206.92:5273" in out


def test_remote_mode_with_remote_origin():
    """REPOCIV_REMOTE_ORIGIN still works (existing behavior)."""
    out = _build_allowed_origins(
        port=5273,
        remote=True,
        remote_origin="https://foo.example.com:5273",
        extra_origins="",
    )
    assert "https://foo.example.com:5273" in out
    # Localhost pair is still added (so Vite dev proxy works)
    assert "http://localhost:5273" in out
    assert "http://127.0.0.1:5273" in out


def test_remote_mode_without_remote_origin_uses_localhost():
    """REPOCIV_REMOTE without REMOTE_ORIGIN falls back to localhost pair."""
    out = _build_allowed_origins(
        port=5273,
        remote=True,
        remote_origin="",
        extra_origins="",
    )
    # Only the localhost pair (not the REMOTE_ORIGIN)
    assert "http://localhost:5273" in out
    assert "http://127.0.0.1:5273" in out
    assert len(out) == 2


def test_remote_mode_combined_with_extra_origins():
    """F2.2: REMOTE_ORIGIN + extra_origins both work together."""
    out = _build_allowed_origins(
        port=5273,
        remote=True,
        remote_origin="https://foo.example.com:5273",
        extra_origins="http://100.123.206.92:5273",
    )
    assert "https://foo.example.com:5273" in out
    assert "http://100.123.206.92:5273" in out
    assert "http://localhost:5273" in out
    assert len(out) == 4
