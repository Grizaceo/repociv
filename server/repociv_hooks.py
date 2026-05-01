"""RepoCiv — Fase 1: RepoCiv Hooks (H5 from DAVI audit).

Reads the optional ``repociv.yaml`` from each managed repository root to
configure git worktree lifecycle and phase checkpoint behaviour (H4).

Security guarantees:
  - Repo names validated: only [a-zA-Z0-9_-], 1-128 chars. No path traversal.
  - YAML parsed with ``yaml.safe_load`` only — no Python object construction.
  - No shell commands executed; only declarative git worktree git calls.
  - Worktree ``base_dir`` must be a relative path with no ``..`` components.

``repociv.yaml`` schema (all fields optional; sensible defaults apply):

    version: "1"
    checkpoints:
      enabled: false      # H4: pause after spec / plan / all-steps for human review
    worktrees:
      enabled: false
      base_dir: ".worktrees"   # relative to repo root, no ".." allowed
    hooks:
      on_issue_open: null
      before_subagent: null
      after_subagent: null
      on_issue_close: null

The HERMES workspace root is resolved from the ``HERMES_ROOT`` environment
variable, defaulting to ``~/.hermes/workspace/repos``.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

try:
    import yaml as _yaml
    _YAML_AVAILABLE = True
except ImportError:  # pragma: no cover
    _YAML_AVAILABLE = False

# ── Constants ─────────────────────────────────────────────────────────────────

_REPO_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")

_DEFAULT_CONFIG: dict[str, Any] = {
    "version": "1",
    "checkpoints": {"enabled": False},
    "worktrees": {"enabled": False, "base_dir": ".worktrees"},
    "hooks": {
        "on_issue_open": None,
        "before_subagent": None,
        "after_subagent": None,
        "on_issue_close": None,
    },
}

# HERMES workspace root — overridable via env var or set_hermes_root() in tests
_HERMES_ROOT: Path = Path(
    os.environ.get("HERMES_ROOT", str(Path.home() / ".hermes" / "workspace" / "repos"))
)


# ── Public: test helper ───────────────────────────────────────────────────────

def set_hermes_root(path: Path) -> None:
    """Override the HERMES workspace root. Only used in tests."""
    global _HERMES_ROOT
    _HERMES_ROOT = path


# ── Validation ────────────────────────────────────────────────────────────────

def _validate_repo_name(repo: str) -> None:
    """Raise ValueError if ``repo`` contains unsafe characters."""
    if not repo:
        raise ValueError("repo name must not be empty")
    if not _REPO_NAME_RE.match(repo):
        raise ValueError(
            f"Invalid repo name {repo!r}: only [a-zA-Z0-9_-] allowed. "
            "Path traversal characters are rejected."
        )


def _safe_branch_part(s: str) -> str:
    """Sanitize a string for use as a git branch name component."""
    return re.sub(r"[^a-zA-Z0-9_-]", "_", s)[:64]


# ── Path helpers ──────────────────────────────────────────────────────────────

def _repo_root(repo: str) -> Path:
    """Return the absolute filesystem path of a managed repo."""
    _validate_repo_name(repo)
    return _HERMES_ROOT / repo


def _hooks_file(repo: str) -> Path:
    """Return the path to ``repociv.yaml`` within a managed repo."""
    return _repo_root(repo) / "repociv.yaml"


# ── Config loading ────────────────────────────────────────────────────────────

def load_hooks_config(repo: str) -> dict[str, Any]:
    """Load and return the ``repociv.yaml`` configuration for a managed repo.

    Falls back to defaults if the file is absent or PyYAML is unavailable.
    Raises ``ValueError`` on invalid YAML or unsafe config values.
    """
    import copy

    defaults = copy.deepcopy(_DEFAULT_CONFIG)
    _validate_repo_name(repo)
    path = _hooks_file(repo)

    if not path.exists() or not _YAML_AVAILABLE:
        return defaults

    try:
        raw = _yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(
            f"Failed to parse repociv.yaml for {repo!r}: {exc}"
        ) from exc

    if raw is None:
        return defaults

    if not isinstance(raw, dict):
        raise ValueError(
            f"repociv.yaml for {repo!r} must be a YAML mapping at top level"
        )

    # Shallow-merge per top-level key so unknown keys are forwarded
    result = defaults
    for key, val in raw.items():
        if key in result and isinstance(result[key], dict) and isinstance(val, dict):
            result[key] = {**result[key], **val}
        else:
            result[key] = val

    return result


# ── Feature flags ─────────────────────────────────────────────────────────────

def checkpoints_enabled(repo: str) -> bool:
    """Return ``True`` if this repo has hard phase checkpoints enabled (H4).

    When enabled, the orchestrator pauses after spec, plan, and all-steps for
    human review before advancing.
    """
    try:
        return bool(
            load_hooks_config(repo).get("checkpoints", {}).get("enabled", False)
        )
    except Exception:
        return False


def worktrees_enabled(repo: str) -> bool:
    """Return ``True`` if git worktrees are enabled for this repo."""
    try:
        return bool(
            load_hooks_config(repo).get("worktrees", {}).get("enabled", False)
        )
    except Exception:
        return False


# ── Worktree base resolution ──────────────────────────────────────────────────

def _worktree_base(repo: str) -> Path:
    """Resolve the absolute path of the worktree base directory.

    ``base_dir`` must be a relative path with no ``..`` components.
    """
    try:
        base_dir = (
            load_hooks_config(repo)
            .get("worktrees", {})
            .get("base_dir", ".worktrees")
        )
    except Exception:
        base_dir = ".worktrees"

    rel = Path(str(base_dir))
    if rel.is_absolute() or ".." in rel.parts:
        raise ValueError(
            f"worktrees.base_dir must be a relative path within the repo: {base_dir!r}. "
            "Absolute paths and '..' are not allowed."
        )
    return _repo_root(repo) / rel


# ── Git worktree lifecycle ────────────────────────────────────────────────────

def create_worktree(repo: str, issue_id: str) -> Path | None:
    """Create a git worktree for the given issue.

    Branch: ``repociv/<sanitised-issue-id>``
    Path:   ``<repo_root>/<base_dir>/<sanitised-issue-id>``

    Returns:
        The worktree ``Path`` on success, ``None`` if worktrees are disabled.

    Raises:
        RuntimeError: on git failure.
    """
    if not worktrees_enabled(repo):
        return None

    safe_issue = _safe_branch_part(issue_id)
    branch = f"repociv/{safe_issue}"
    repo_root = _repo_root(repo)
    worktree_path = _worktree_base(repo) / safe_issue
    worktree_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        # Try to create branch + worktree in one command
        result = subprocess.run(
            ["git", "worktree", "add", "-b", branch, str(worktree_path), "HEAD"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            # Branch may already exist — try without -b
            result2 = subprocess.run(
                ["git", "worktree", "add", str(worktree_path), branch],
                cwd=str(repo_root),
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result2.returncode != 0:
                raise RuntimeError(
                    f"git worktree add failed for {repo}/{issue_id}: "
                    f"{result2.stderr.strip()}"
                )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"git worktree add timed out for {repo}/{issue_id}"
        ) from exc

    return worktree_path


def remove_worktree(repo: str, issue_id: str) -> bool:
    """Remove the git worktree and prune stale refs for the given issue.

    Returns:
        ``True`` if a removal was attempted, ``False`` if worktrees are
        disabled or the worktree did not exist.

    Never raises — safe to call during crash cleanup.
    """
    if not worktrees_enabled(repo):
        return False

    safe_issue = _safe_branch_part(issue_id)
    repo_root = _repo_root(repo)
    worktree_path = _worktree_base(repo) / safe_issue

    if not worktree_path.exists() and not _is_registered_worktree(
        repo_root, worktree_path
    ):
        return False

    try:
        subprocess.run(
            ["git", "worktree", "remove", "--force", str(worktree_path)],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=30,
        )
        subprocess.run(
            ["git", "worktree", "prune"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception:
        pass  # Best-effort cleanup — never raise on remove

    return True


def cleanup_all_worktrees(repo: str) -> list[str]:
    """Remove all RepoCiv-managed worktrees for a repo (crash recovery).

    Identifies worktrees via ``git worktree list --porcelain``. Only removes
    paths containing ``/repociv/`` or ``/.worktrees/`` to avoid touching the
    main worktree or unrelated entries.

    Returns:
        List of worktree path strings that were cleaned up.
    """
    if not worktrees_enabled(repo):
        return []

    repo_root = _repo_root(repo)
    cleaned: list[str] = []

    try:
        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return []

        for line in result.stdout.splitlines():
            if not line.startswith("worktree "):
                continue
            wt_path = line[len("worktree "):].strip()
            # Only touch RepoCiv-managed worktrees (never the main checkout)
            if "/repociv/" in wt_path or "/.worktrees/" in wt_path:
                subprocess.run(
                    ["git", "worktree", "remove", "--force", wt_path],
                    cwd=str(repo_root),
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                cleaned.append(wt_path)

        if cleaned:
            subprocess.run(
                ["git", "worktree", "prune"],
                cwd=str(repo_root),
                capture_output=True,
                text=True,
                timeout=15,
            )
    except Exception:
        pass  # Best-effort

    return cleaned


# ── Internal helpers ──────────────────────────────────────────────────────────

def _is_registered_worktree(repo_root: Path, worktree_path: Path) -> bool:
    """Return ``True`` if ``worktree_path`` appears in ``git worktree list``."""
    try:
        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=10,
        )
        return str(worktree_path) in result.stdout
    except Exception:
        return False
