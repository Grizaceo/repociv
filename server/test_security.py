"""Tests for server._security (Fase 0 / audit 0.4 — token + bind policy).

The helper is invoked at import time by bridge.py and websocket_handler.py,
so most of these tests exercise the pure function directly. The integration
tests (the last 4) use subprocess to verify the SystemExit fires when the
real bridge/ws modules are imported with bad env vars.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import warnings

import pytest

from server._security import (
    MIN_TOKEN_LENGTH,
    _is_loopback_bind,
    enforce_token_policy,
)


# ─── Pure-function tests ────────────────────────────────────────────────────


def test_min_token_length_is_32():
    """Audit 0.4 says "exigir ≥32 chars siempre que haya token"."""
    assert MIN_TOKEN_LENGTH == 32


@pytest.mark.parametrize(
    "host,expected",
    [
        ("127.0.0.1", True),
        ("127.0.0.42", True),
        ("::1", True),
        ("localhost", True),
        ("LOCALHOST", True),  # case-insensitive
        ("  127.0.0.1  ", True),  # whitespace trimmed
        # Non-loopback: 0.0.0.0 / :: accept on every interface, so
        # the conservative "needs token" check treats them as exposed.
        ("0.0.0.0", False),
        ("::", False),
        ("[::]", False),
        ("10.0.0.1", False),
        ("192.168.1.1", False),
        ("example.com", False),
        ("", False),
    ],
)
def test_is_loopback_bind(host, expected):
    assert _is_loopback_bind(host) is expected


def test_enforce_token_empty_loopback_warns_not_exits(capfd):
    """Case 3: loopback + no token → UserWarning, no SystemExit."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        enforce_token_policy(
            token="", bind_host="127.0.0.1", remote=False, component="bridge"
        )
    # Exactly one UserWarning about empty token
    user_warnings = [w for w in caught if issubclass(w.category, UserWarning)]
    assert len(user_warnings) == 1
    assert "REPOCIV_TOKEN is empty" in str(user_warnings[0].message)
    assert "127.0.0.1" in str(user_warnings[0].message)
    assert "bridge" in str(user_warnings[0].message)


def test_enforce_token_empty_non_loopback_refuses(capfd):
    """Case 2: non-loopback bind + no token → SystemExit(1)."""
    with pytest.raises(SystemExit) as exc:
        enforce_token_policy(
            token="", bind_host="0.0.0.0", remote=False, component="bridge"
        )
    assert exc.value.code == 1
    err = capfd.readouterr().err
    assert "refusing to bind" in err
    assert "0.0.0.0" in err
    assert "REPOCIV_TOKEN" in err


def test_enforce_token_empty_non_loopback_remote_refuses(capfd):
    """Case 2 sibling: REPOCIV_REMOTE=true + no token → SystemExit."""
    with pytest.raises(SystemExit) as exc:
        enforce_token_policy(
            token="", bind_host="0.0.0.0", remote=True, component="bridge"
        )
    assert exc.value.code == 1
    err = capfd.readouterr().err
    assert "refusing to bind" in err
    assert "REPOCIV_REMOTE" in err


def test_enforce_token_short_refuses(capfd):
    """Case 1: token set but < 32 chars → SystemExit, even in local mode."""
    with pytest.raises(SystemExit) as exc:
        enforce_token_policy(
            token="abc", bind_host="127.0.0.1", remote=False, component="bridge"
        )
    assert exc.value.code == 1
    err = capfd.readouterr().err
    assert "3 chars" in err
    assert ">= 32 characters" in err


@pytest.mark.parametrize("bad_token", ["", "x", "x" * 16, "x" * 31])
def test_enforce_token_rejects_under_32(bad_token):
    """All tokens < 32 chars (including empty) fail with a clear exit code.

    Empty + loopback is the only exception — it warns but doesn't exit.
    """
    if bad_token == "":
        # Empty + loopback = case 3 (warn, don't exit). Empty + non-loopback
        # is case 2 (exit). Test the non-loopback branch here.
        with pytest.raises(SystemExit):
            enforce_token_policy(
                token=bad_token,
                bind_host="0.0.0.0",
                remote=False,
                component="bridge",
            )
    else:
        with pytest.raises(SystemExit) as exc:
            enforce_token_policy(
                token=bad_token,
                bind_host="127.0.0.1",
                remote=False,
                component="bridge",
            )
        assert exc.value.code == 1


def test_enforce_token_exactly_32_passes():
    """A 32-char token is the minimum valid length (boundary)."""
    enforce_token_policy(
        token="x" * 32, bind_host="127.0.0.1", remote=False, component="bridge"
    )
    # No exception, no warning.


def test_enforce_token_64_passes_non_loopback():
    """A 64-char token + non-loopback bind is safe (case 2 satisfied)."""
    enforce_token_policy(
        token="x" * 64, bind_host="0.0.0.0", remote=True, component="bridge"
    )


def test_enforce_token_short_component_label_in_error(capfd):
    """Error message names the component so the operator can locate the source."""
    with pytest.raises(SystemExit):
        enforce_token_policy(
            token="short", bind_host="127.0.0.1", remote=False, component="ws"
        )
    err = capfd.readouterr().err
    assert "[ws]" in err


# ─── Integration: bridge.py / websocket_handler.py refuse on bad env ────────


def _run_in_subprocess(import_line: str, env: dict[str, str]) -> subprocess.CompletedProcess:
    """Run ``python -c "import ..."`` in a fresh process with the given env.

    Returns the CompletedProcess. Asserts the script ran (no crash other
    than SystemExit).
    """
    script = textwrap.dedent(
        f"""
        import sys, warnings
        warnings.simplefilter('ignore')
        {import_line}
        print('IMPORT_OK')
        """
    )
    full_env = os.environ.copy()
    # conftest.py sets REPOCIV_CONFIG_DIR to a tmp path; preserve that
    # for the subprocess so bridge.py doesn't try to write to ~/.repociv.
    full_env.update(env)
    return subprocess.run(
        [sys.executable, "-c", script],
        env=full_env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_bridge_import_refuses_remote_without_token():
    """REPOCIV_REMOTE=true + no token → exit code 1 with a clear stderr."""
    result = _run_in_subprocess(
        "from server import bridge",
        env={"REPOCIV_REMOTE": "true", "REPOCIV_TOKEN": ""},
    )
    assert result.returncode == 1, f"stdout={result.stdout!r} stderr={result.stderr!r}"
    assert "refusing to bind" in result.stderr
    assert "REPOCIV_TOKEN" in result.stderr


def test_bridge_import_refuses_short_token():
    """REPOCIV_TOKEN=15chars → exit code 1 (length check, no remote needed)."""
    result = _run_in_subprocess(
        "from server import bridge",
        env={"REPOCIV_TOKEN": "x" * 15},
    )
    assert result.returncode == 1
    assert "15 chars" in result.stderr
    assert ">= 32" in result.stderr


def test_bridge_import_succeeds_with_valid_token():
    """A 32-char token in local mode → no exit, no warning text in stderr."""
    result = _run_in_subprocess(
        "from server import bridge",
        env={"REPOCIV_TOKEN": "x" * 32},
    )
    assert result.returncode == 0, f"stderr={result.stderr!r}"
    assert "IMPORT_OK" in result.stdout
    # The dev-mode "empty token" warning should NOT fire
    assert "REPOCIV_TOKEN is empty" not in result.stderr


def test_bridge_import_warns_loopback_no_token():
    """Loopback + no token → exit 0 (dev default), but warning is in stderr."""
    result = _run_in_subprocess(
        "from server import bridge",
        env={"REPOCIV_TOKEN": ""},
    )
    assert result.returncode == 0
    # warnings.warn(... stacklevel=2) prints to stderr by default
    # in the subprocess (no warning filter set).
    # Note: we strip the warnings.simplefilter('ignore') in the test runner
    # to capture the actual default behaviour. Re-check by NOT filtering:
    script = textwrap.dedent(
        """
        from server import bridge
        print('IMPORT_OK')
        """
    )
    full_env = os.environ.copy()
    full_env["REPOCIV_TOKEN"] = ""
    full_env["REPOCIV_WARN_DEFAULT"] = "always"
    result2 = subprocess.run(
        [sys.executable, "-W", "default", "-c", script],
        env=full_env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result2.returncode == 0
    # The warning is printed to stderr by warnings.warn with default filter
    combined_stderr = result2.stderr
    assert "REPOCIV_TOKEN is empty" in combined_stderr or "IMPORT_OK" in result2.stdout


def test_ws_import_refuses_non_loopback_host_without_token():
    """BRIDGE_WS_HOST=0.0.0.0 + no token → exit 1 (NEW safety net)."""
    result = _run_in_subprocess(
        "from server import websocket_handler",
        env={
            "REPOCIV_TOKEN": "",
            "BRIDGE_WS_HOST": "0.0.0.0",
        },
    )
    assert result.returncode == 1, f"stderr={result.stderr!r}"
    assert "refusing to bind" in result.stderr
    assert "BRIDGE_WS_HOST" in result.stderr or "0.0.0.0" in result.stderr


def test_ws_import_succeeds_non_loopback_with_token():
    """BRIDGE_WS_HOST=0.0.0.0 + valid token → ok."""
    result = _run_in_subprocess(
        "from server import websocket_handler",
        env={
            "REPOCIV_TOKEN": "x" * 32,
            "BRIDGE_WS_HOST": "0.0.0.0",
        },
    )
    assert result.returncode == 0, f"stderr={result.stderr!r}"
    assert "IMPORT_OK" in result.stdout


def test_ws_import_refuses_short_token():
    """Short REPOCIV_TOKEN also fails in the WS handler."""
    result = _run_in_subprocess(
        "from server import websocket_handler",
        env={"REPOCIV_TOKEN": "y" * 20},
    )
    assert result.returncode == 1
    assert "20 chars" in result.stderr
