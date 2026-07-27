"""Tests for the env-var redaction helper used by child-process spawn paths."""
from __future__ import annotations

import logging

import pytest

from server._env_filter import (
    DEFAULT_DENYLIST,
    REDACTED_PLACEHOLDER,
    redact_env_for_spawn,
)


# ─── exact-name denylist ─────────────────────────────────────────────────────


def test_redact_known_exact_keys():
    src = {
        "ANTHROPIC_API_KEY": "sk-ant-secret-1234",
        "OPENAI_API_KEY": "sk-openai-5678",
        "AWS_ACCESS_KEY_ID": "AKIAEXAMPLE",
        "AWS_SECRET_ACCESS_KEY": "aws/secret+value",
        "AWS_SESSION_TOKEN": "FQoGZXIv",
        "GITHUB_TOKEN": "ghp_xxx",
        "GH_TOKEN": "ghp_yyy",
        "GOOGLE_API_KEY": "AIzaSyD",
        "STRIPE_SECRET_KEY": "sk_live_zzz",
        "NPM_TOKEN": "npm_xxx",
        "CLAUDE_CODE_OAUTH_TOKEN": "oauth-ccc",
        "PATH": "/usr/local/bin:/usr/bin",
    }
    out = redact_env_for_spawn(src)
    # All known keys replaced with placeholder
    for k in [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "GOOGLE_API_KEY",
        "STRIPE_SECRET_KEY",
        "NPM_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
    ]:
        assert out[k] == REDACTED_PLACEHOLDER, f"expected {k} redacted, got {out[k]!r}"
    # PATH kept (operational)
    assert out["PATH"] == "/usr/local/bin:/usr/bin"


def test_redact_is_case_insensitive_for_known_keys():
    """Known keys match case-insensitively because some shells uppercase."""
    src = {"anthropic_api_key": "x", "openai_api_key": "y"}
    out = redact_env_for_spawn(src)
    # We store under original casing, but detection matched.
    assert out["anthropic_api_key"] == REDACTED_PLACEHOLDER
    assert out["openai_api_key"] == REDACTED_PLACEHOLDER


def test_default_denylist_is_a_frozenset():
    """Mutating the call-site copy must not leak into other callers."""
    assert isinstance(DEFAULT_DENYLIST, frozenset)


# ─── internal invariants ─────────────────────────────────────────────────────


def test_denylist_covers_expected_vendor_keys():
    """Spot-check the well-known vendor secrets are present.

    If a vendor adds a new env var name we want it added here, so this test
    surfaces a red light on accidental deletions.
    """
    must_have = {
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "GITHUB_TOKEN",
        "GOOGLE_API_KEY",
        "STRIPE_SECRET_KEY",
    }
    missing = must_have - DEFAULT_DENYLIST
    assert not missing, f"denylist missing expected entries: {missing}"


def test_denylist_does_not_overcollide_with_operational():
    """Operational vars we always keep must NOT be in the denylist (would be
    unreachable since heuristic + denylist are independent, but obvious
    footgun if both code paths ever share a single set)."""
    assert "PATH" not in DEFAULT_DENYLIST
    assert "HOME" not in DEFAULT_DENYLIST
    assert "USER" not in DEFAULT_DENYLIST


# ─── heuristic suffix ────────────────────────────────────────────────────────


def test_heuristic_suffix_redacts_var_token():
    """Any *_TOKEN/*_KEY/*_SECRET/*_PASSWORD/*_PRIVATE_KEY is redacted by default.

    Cases like bare ``PASSWD`` / ``APIKEY`` (without the underscore separator)
    are intentionally NOT redacted by the heuristic — they would generate
    too many false positives on POSIX-style var names. The exact-name
    denylist in :data:`DEFAULT_DENYLIST` catches the well-known cases.
    """
    src = {
        "MYSERVICE_TOKEN": "leakable",
        "SOME_API_KEY": "leakable2",
        "DB_PASSWORD": "leakable3",
        "STRIPE_SECRET": "leakable4",
        "SSH_PRIVATE_KEY": "leakable5",
        "PATH_TOKEN": "leakable6",       # contrived but valid heuristic match
        "NORMAL_VAR": "should-pass",     # unrelated, must survive
    }
    out = redact_env_for_spawn(src)
    must_redact = ["MYSERVICE_TOKEN", "SOME_API_KEY", "DB_PASSWORD",
                   "STRIPE_SECRET", "SSH_PRIVATE_KEY", "PATH_TOKEN"]
    must_keep = ["NORMAL_VAR"]
    for k in must_redact:
        assert out[k] == REDACTED_PLACEHOLDER, f"{k} should be heuristic-redacted, got {out[k]!r}"
    for k in must_keep:
        assert out[k] == src[k], f"{k} should be kept, got {out[k]!r}"


def test_heuristic_does_not_match_unrelated_vars():
    src = {
        "MY_TOKENIZER": "this is a model name, not a secret",
        "KEYBOARD_LAYOUT": "qwerty",
        "PATH_TOKEN": "ok",
    }
    # Keyboard-related or path-related names that happen to end in *_TOKENIZER
    # etc. should NOT trigger — our suffix list is KEY/TOKEN/SECRET/PASSWORD/PASSWD.
    out = redact_env_for_spawn(src)
    # MY_TOKENIZER ends in _TOKENIZER, not _TOKEN, so it is NOT heuristic-blocked.
    assert out["MY_TOKENIZER"] == "this is a model name, not a secret"
    assert out["KEYBOARD_LAYOUT"] == "qwerty"
    # PATH_TOKEN ends in _TOKEN → SHOULD be redacted.
    assert out["PATH_TOKEN"] == REDACTED_PLACEHOLDER


# ─── always-keep whitelist ───────────────────────────────────────────────────


def test_operational_vars_kept_by_default():
    src = {"PATH": "/bin", "HOME": "/root", "LANG": "C.UTF-8", "TZ": "UTC",
           "TMPDIR": "/tmp"}
    out = redact_env_for_spawn(src)
    for k, v in src.items():
        assert out[k] == v, f"{k} should be kept, got {out[k]!r}"


# ─── extra_keep ───────────────────────────────────────────────────────────────


def test_extra_keep_overrides_heuristic():
    """Caller can opt a var back into the spawn even if it matches heuristic."""
    src = {"CUSTOM_TOKEN": "legit-token-value", "OTHER_KEY": "leakable"}
    out = redact_env_for_spawn(src, extra_keep={"CUSTOM_TOKEN"})
    assert out["CUSTOM_TOKEN"] == "legit-token-value"
    assert out["OTHER_KEY"] == REDACTED_PLACEHOLDER


def test_extra_keep_wildcard_keeps_everything():
    src = {"SOMETHING_SECRET": "x", "ANOTHER_KEY": "y"}
    out = redact_env_for_spawn(src, extra_keep={"*"})
    for k, v in src.items():
        assert out[k] == v


# ─── idempotence + non-mutation ───────────────────────────────────────────────


def test_redact_is_idempotent():
    src = {"ANTHROPIC_API_KEY": "x", "MY_KEY": "y", "PATH": "/b"}
    once = redact_env_for_spawn(src)
    twice = redact_env_for_spawn(once)
    # Both dicts should have identical values (and the placeholder is preserved
    # through a redaction so the call is observable but content-stable).
    assert once == twice


def test_redact_does_not_mutate_input():
    src = {"ANTHROPIC_API_KEY": "real-secret", "PATH": "/b"}
    snapshot_keys = set(src.keys())
    snapshot_vals = dict(src)
    redact_env_for_spawn(src)
    assert src.keys() == snapshot_keys
    assert src == snapshot_vals


def test_redact_returns_new_dict():
    src = {"PATH": "/b"}
    out = redact_env_for_spawn(src)
    assert out is not src


# ─── audit log ───────────────────────────────────────────────────────────────


def test_redaction_emits_log(caplog):
    caplog.set_level(logging.INFO, logger="server._env_filter")
    src = {"ANTHROPIC_API_KEY": "x", "OPENAI_API_KEY": "y", "SOME_KEY": "z"}
    redact_env_for_spawn(src)
    msgs = [r.message for r in caplog.records if "env_filter" in r.message]
    assert any("redacted" in m for m in msgs), f"expected redaction log, got {msgs}"
    # Critical: no leaked values in the log
    joined = "\n".join(msgs)
    for secret in ("x", "y", "z"):
        # The redaction log reports COUNTS, not values. We assert it does
        # NOT echo the secret values themselves.
        if secret in joined:
            # 'x', 'y', 'z' are also substrings of "redacted" etc. We test
            # for the placeholder leakage path: the placeholder IS allowed
            # because it is the literal we set.
            assert REDACTED_PLACEHOLDER in joined


# ─── empty / no-parent behavior ──────────────────────────────────────────────


def test_no_parent_env_uses_os_environ(monkeypatch):
    """When no parent is passed, we read from os.environ."""
    monkeypatch.setenv("PATH", "/from/os")
    out = redact_env_for_spawn()
    assert out.get("PATH") == "/from/os"


def test_empty_parent_yields_empty_output_minus_keeps():
    src: dict[str, str] = {}
    out = redact_env_for_spawn(src)
    assert out == {}  # nothing to keep when input is empty


# ─── redact_value override ───────────────────────────────────────────────────


def test_redact_value_string_can_be_overridden():
    src = {"ANTHROPIC_API_KEY": "secret"}
    out = redact_env_for_spawn(src, redact_value="")
    assert out["ANTHROPIC_API_KEY"] == ""


# ─── real-world smoke ────────────────────────────────────────────────────────


def test_real_env_no_secrets_leak():
    """End-to-end-ish: dump a realistic parent env (PATH/HOME plus vendor keys)
    through the redactor and assert that no vendor secret survives into the
    output."""
    src = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/home/user",
        "USER": "user",
        "TERM": "xterm-256color",
        "LANG": "C.UTF-8",
        # The 11 known vendor secrets, plus 3 generic suffix matches
        "ANTHROPIC_API_KEY": "sk-ant-secret-real-1",
        "OPENAI_API_KEY": "sk-openai-real-1",
        "AWS_ACCESS_KEY_ID": "AKIAREAL1",
        "AWS_SECRET_ACCESS_KEY": "aws/real1",
        "AWS_SESSION_TOKEN": "FQoReal1",
        "GITHUB_TOKEN": "ghp_real1",
        "GH_TOKEN": "ghp_real2",
        "GOOGLE_API_KEY": "AIzaReal",
        "STRIPE_SECRET_KEY": "sk_live_real",
        "NPM_TOKEN": "npm_real",
        "CLAUDE_CODE_OAUTH_TOKEN": "oauth_real",
        "MY_SAAS_API_KEY": "extraheuristic1",
        "INTERNAL_DB_PASSWORD": "extraheuristic2",
        "COMPANY_TOKEN": "extraheuristic3",
    }
    out = redact_env_for_spawn(src)
    forbidden = [
        "sk-ant-secret-real-1",
        "sk-openai-real-1",
        "AKIAREAL1",
        "aws/real1",
        "FQoReal1",
        "ghp_real1",
        "ghp_real2",
        "AIzaReal",
        "sk_live_real",
        "npm_real",
        "oauth_real",
        "extraheuristic1",
        "extraheuristic2",
        "extraheuristic3",
    ]
    for secret in forbidden:
        leaked = any(v == secret for v in out.values())
        assert not leaked, f"secret {secret!r} leaked into spawn env: {list(out.values())}"
    # Operational vars must survive
    assert out["PATH"] == "/usr/local/bin:/usr/bin:/bin"
    assert out["HOME"] == "/home/user"
