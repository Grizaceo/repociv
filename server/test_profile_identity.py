"""Tests for profile_identity path resolution and read/write."""
from __future__ import annotations

from pathlib import Path

import pytest

from server import profile_identity as pi


@pytest.fixture
def repociv_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Redirect ~/.repociv/profiles to a temp dir."""
    profiles = tmp_path / "profiles"
    profiles.mkdir()
    monkeypatch.setattr(pi, "_REPOCIV_PROFILES_DIR", profiles)
    return profiles


def test_resolve_managed_claude_identity(repociv_home: Path) -> None:
    path = pi.resolve_identity_path("reviewer", "claude", "default", "managed")
    assert path == repociv_home / "reviewer" / "CLAUDE.md"


def test_resolve_native_hermes_soul(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    hermes = tmp_path / "hermes" / "profiles" / "ops"
    hermes.mkdir(parents=True)
    monkeypatch.setattr(pi, "_HERMES_PROFILES_DIR", tmp_path / "hermes" / "profiles")
    path = pi.resolve_identity_path("MAIN", "hermes", "ops", "native")
    assert path == hermes / "SOUL.md"


def test_write_and_read_identity(repociv_home: Path) -> None:
    result = pi.write_identity(
        "codex-ops",
        "codex",
        "# AGENTS\nBe concise.",
        harness_ref="default",
        identity_mode="managed",
    )
    assert result["ok"] is True
    read = pi.read_identity("codex-ops", "codex", "default", "managed")
    assert read["exists"] is True
    assert "Be concise" in read["content"]
    assert read["path"].endswith("AGENTS.md")


def test_write_identity_creates_backup(repociv_home: Path) -> None:
    pi.write_identity("p1", "cursor", "v1", identity_mode="managed")
    pi.write_identity("p1", "cursor", "v2", identity_mode="managed")
    path = Path(pi.read_identity("p1", "cursor", identity_mode="managed")["path"])
    bak = path.with_suffix(path.suffix + ".bak")
    assert bak.exists()
    assert bak.read_text(encoding="utf-8") == "v1"


def test_list_harness_options_hermes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    base = tmp_path / "hermes" / "profiles"
    (base / "alpha").mkdir(parents=True)
    (base / "beta").mkdir(parents=True)
    monkeypatch.setattr(pi, "_HERMES_PROFILES_DIR", base)
    opts = pi.list_harness_options("hermes")
    assert opts == ["alpha", "beta"]
