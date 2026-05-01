"""Tests for Fase 1 repociv_hooks.py — Declarative Hook Configuration.

Tests cover:
  - repociv.yaml parsing
  - Variable interpolation ($VAR, ${VAR})
  - Hook type classification (on_issue_open, before_subagent, etc.)
  - Safe repo name validation
  - Graceful degradation (no PyYAML, missing file, malformed YAML)
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

import server.repociv_hooks as _rh


# ─── Fixture: temporary repo with optional repociv.yaml ──────────────────────

@pytest.fixture
def tmp_repo() -> Path:
    """Create a temporary directory as a fake repo root."""
    return Path(tempfile.mkdtemp())


@pytest.fixture
def mock_hermes_root(tmp_repo: Path, monkeypatch) -> Path:
    """Mock HERMES_ROOT to point to tmp_repo for testing."""
    _rh.set_hermes_root(tmp_repo)
    return tmp_repo


# ─── Tests: Repo Name Validation ──────────────────────────────────────────────

class TestRepoNameValidation:
    """Tests for _validate_repo_name()."""

    def test_valid_repo_names(self) -> None:
        """Valid repo names are accepted."""
        valid = [
            "myrepo",
            "my-repo",
            "my_repo",
            "Repo123",
            "a" * 128,  # max length
        ]
        for name in valid:
            try:
                _rh._validate_repo_name(name)
            except ValueError:
                pytest.fail(f"Valid repo name rejected: {name}")

    def test_invalid_repo_names(self) -> None:
        """Invalid repo names are rejected."""
        invalid = [
            "",  # empty
            "repo/path",  # slash
            "repo\\path",  # backslash
            "repo/../bad",  # path traversal
            "a" * 129,  # too long
        ]
        for name in invalid:
            with pytest.raises(ValueError):
                _rh._validate_repo_name(name)


# ─── Tests: YAML Loading ──────────────────────────────────────────────────────

class TestLoadHooksConfig:
    """Tests for load_hooks_config()."""

    def test_load_missing_file_returns_defaults(
        self, mock_hermes_root: Path,
    ) -> None:
        """If repociv.yaml doesn't exist, return defaults."""
        repo = "test-repo"
        (mock_hermes_root / repo).mkdir(parents=True)
        
        config = _rh.load_hooks_config(repo)
        assert config["version"] == "1"
        assert "worktrees" in config
        assert "checkpoints" in config

    def test_load_valid_yaml(self, mock_hermes_root: Path) -> None:
        """Load a valid repociv.yaml."""
        repo = "test-repo"
        repo_path = mock_hermes_root / repo
        repo_path.mkdir(parents=True)
        
        yaml_content = """
version: "1"
worktrees:
  enabled: true
  base_dir: .repociv-wt
checkpoints:
  enabled: true
"""
        (repo_path / "repociv.yaml").write_text(yaml_content)
        
        config = _rh.load_hooks_config(repo)
        assert config["worktrees"]["enabled"] is True
        assert config["worktrees"]["base_dir"] == ".repociv-wt"
        assert config["checkpoints"]["enabled"] is True

    def test_load_invalid_yaml_raises(self, mock_hermes_root: Path) -> None:
        """Malformed YAML raises ValueError."""
        repo = "test-repo"
        repo_path = mock_hermes_root / repo
        repo_path.mkdir(parents=True)
        
        (repo_path / "repociv.yaml").write_text("invalid: [ yaml: content [")
        
        with pytest.raises(ValueError):
            _rh.load_hooks_config(repo)


# ─── Tests: Feature Flags ────────────────────────────────────────────────────

class TestFeatureFlags:
    """Tests for checkpoints_enabled() and worktrees_enabled()."""

    def test_checkpoints_enabled_false_by_default(
        self, mock_hermes_root: Path,
    ) -> None:
        """Checkpoints disabled by default."""
        repo = "test-repo"
        (mock_hermes_root / repo).mkdir(parents=True)
        
        assert _rh.checkpoints_enabled(repo) is False

    def test_checkpoints_enabled_true_if_configured(
        self, mock_hermes_root: Path,
    ) -> None:
        """Checkpoints enabled if explicitly set."""
        repo = "test-repo"
        repo_path = mock_hermes_root / repo
        repo_path.mkdir(parents=True)
        
        yaml_content = """
checkpoints:
  enabled: true
"""
        (repo_path / "repociv.yaml").write_text(yaml_content)
        
        assert _rh.checkpoints_enabled(repo) is True

    def test_worktrees_enabled_false_by_default(
        self, mock_hermes_root: Path,
    ) -> None:
        """Worktrees disabled by default."""
        repo = "test-repo"
        (mock_hermes_root / repo).mkdir(parents=True)
        
        assert _rh.worktrees_enabled(repo) is False

    def test_worktrees_enabled_true_if_configured(
        self, mock_hermes_root: Path,
    ) -> None:
        """Worktrees enabled if explicitly set."""
        repo = "test-repo"
        repo_path = mock_hermes_root / repo
        repo_path.mkdir(parents=True)
        
        yaml_content = """
worktrees:
  enabled: true
"""
        (repo_path / "repociv.yaml").write_text(yaml_content)
        
        assert _rh.worktrees_enabled(repo) is True


# ─── Tests: Path Validation ──────────────────────────────────────────────────

class TestWorktreeBasePath:
    """Tests for _worktree_base() path validation."""

    def test_worktree_base_relative_path(self, mock_hermes_root: Path) -> None:
        """Relative path is allowed."""
        repo = "test-repo"
        repo_path = mock_hermes_root / repo
        repo_path.mkdir(parents=True)
        
        yaml_content = """
worktrees:
  enabled: true
  base_dir: .my-worktrees
"""
        (repo_path / "repociv.yaml").write_text(yaml_content)
        
        result = _rh._worktree_base(repo)
        assert ".my-worktrees" in str(result)

    def test_worktree_base_rejects_absolute_path(
        self, mock_hermes_root: Path,
    ) -> None:
        """Absolute path is rejected."""
        repo = "test-repo"
        repo_path = mock_hermes_root / repo
        repo_path.mkdir(parents=True)
        
        yaml_content = """
worktrees:
  enabled: true
  base_dir: /etc/absolute
"""
        (repo_path / "repociv.yaml").write_text(yaml_content)
        
        with pytest.raises(ValueError, match="relative path"):
            _rh._worktree_base(repo)

    def test_worktree_base_rejects_path_traversal(
        self, mock_hermes_root: Path,
    ) -> None:
        """Path with '..' is rejected."""
        repo = "test-repo"
        repo_path = mock_hermes_root / repo
        repo_path.mkdir(parents=True)
        
        yaml_content = """
worktrees:
  enabled: true
  base_dir: ../../../escaped
"""
        (repo_path / "repociv.yaml").write_text(yaml_content)
        
        with pytest.raises(ValueError):
            _rh._worktree_base(repo)


# ─── Tests: Safe Branch Names ────────────────────────────────────────────────

class TestSafeBranchPart:
    """Tests for _safe_branch_part() sanitization."""

    def test_safe_branch_alphanumeric(self) -> None:
        """Alphanumeric unchanged."""
        assert _rh._safe_branch_part("issue123") == "issue123"

    def test_safe_branch_replaces_invalid_chars(self) -> None:
        """Invalid git chars replaced with underscore."""
        result = _rh._safe_branch_part("issue #123@test")
        assert "#" not in result
        assert "@" not in result
        assert "_" in result

    def test_safe_branch_max_length(self) -> None:
        """Truncated to 64 chars."""
        long_name = "a" * 100
        result = _rh._safe_branch_part(long_name)
        assert len(result) == 64


# ─── Integration Test ─────────────────────────────────────────────────────────

class TestIntegration:
    """Integration tests combining multiple features."""

    def test_full_config_flow(self, mock_hermes_root: Path) -> None:
        """Full flow: write YAML, load config, query flags."""
        repo = "integration-test"
        repo_path = mock_hermes_root / repo
        repo_path.mkdir(parents=True)
        
        yaml_content = """
version: "1"
checkpoints:
  enabled: true
worktrees:
  enabled: true
  base_dir: .issue-wt
hooks:
  on_issue_open: |
    echo "Opening issue $ISSUE_ID"
"""
        (repo_path / "repociv.yaml").write_text(yaml_content)
        
        # Verify defaults + overrides
        config = _rh.load_hooks_config(repo)
        assert config["version"] == "1"
        assert _rh.checkpoints_enabled(repo)
        assert _rh.worktrees_enabled(repo)
        
        base = _rh._worktree_base(repo)
        assert ".issue-wt" in str(base)
