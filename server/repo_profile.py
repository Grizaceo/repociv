#!/usr/bin/env python3
"""RepoCiv — Cheap local repo profiler for Foreign Relations Reports.

Builds a lightweight profile of a local repo using:
  - README (first 4K chars)
  - package.json / pyproject.toml / Cargo.toml / go.mod if present
  - Top-level directory listing
  - Recent git files (last ~50 commits aggregated)
  - Skill tags if ~/.hermes/skills/<repo>/SKILL.md exists

No full repo scan. No embeddings. No LLM.
Intended to run on-demand (not per-news-item).
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

_PROFILE_CACHE: dict[str, dict[str, Any] | None] = {}
_CACHE_MAX_AGE = 300  # 5 minutes


def _read_first_n(path: Path, n_bytes: int = 4096) -> str:
    """Read up to n_bytes from a file, return as string."""
    try:
        data = path.read_bytes()[:n_bytes]
        return data.decode("utf-8", errors="replace")
    except (FileNotFoundError, PermissionError, OSError):
        return ""


def _find_file(repo_path: Path, *names: str) -> tuple[str, str] | None:
    """Return (filename, content) for the first existing file among *names."""
    for name in names:
        fp = repo_path / name
        if fp.is_file():
            content = _read_first_n(fp, 4096)
            if content.strip():
                return name, content
    return None


def _top_level_dirs(repo_path: Path) -> list[str]:
    """List top-level directories (non-hidden) sorted."""
    try:
        return sorted(
            p.name
            for p in repo_path.iterdir()
            if p.is_dir() and not p.name.startswith(".") and not p.name.startswith("__")
        )[:30]
    except PermissionError:
        return []


def _recent_git_files(repo_path: Path, count: int = 50) -> list[str]:
    """Return a list of recently modified file paths via git log."""
    try:
        result = subprocess.run(
            ["git", "log", f"-{count}", "--name-only", "--pretty=format:", "--diff-filter=AM"],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=str(repo_path),
        )
        seen: set[str] = set()
        files: list[str] = []
        for line in result.stdout.strip().split("\n"):
            f = line.strip()
            if f and f not in seen:
                seen.add(f)
                files.append(f)
        return files[:100]
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return []


def _find_skill_tags(repo_path: Path) -> list[str]:
    """If the repo has a SKILL.md under ~/.hermes/skills/, read related tags."""
    repo_name = repo_path.name
    hermes_skills = Path.home() / ".hermes" / "skills"
    for skill_dir in hermes_skills.iterdir():
        if not skill_dir.is_dir():
            continue
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            continue
        content = skill_file.read_text(encoding="utf-8", errors="replace")[:2000]
        # Check if this skill references our repo
        if repo_name in content:
            tags = re.findall(r"(?i)(?:(?:tags|category|domain):\s*)([\w\s,_-]+)", content)
            if tags:
                return [t.strip() for t in tags[0].split(",")]
    return []


def _repo_hash(repo_path: Path) -> str:
    """Quick hash of repo path for dedup."""
    return str(repo_path.resolve())


def build_profile(repo_path: str) -> dict[str, Any] | None:
    """Build a cheap local profile for a repo path.

    Returns None if the path doesn't exist or isn't a directory.
    Caches results for _CACHE_MAX_AGE seconds.
    """
    path = Path(repo_path).expanduser().resolve()
    if not path.is_dir():
        return None

    cache_key = _repo_hash(path)
    cached = _PROFILE_CACHE.get(cache_key)
    if cached is not None:
        return cached

    readme = _read_first_n(path / "README.md") or _read_first_n(path / "Readme.md") or ""
    manifest_entry = (
        _find_file(path, "package.json")
        or _find_file(path, "pyproject.toml")
        or _find_file(path, "Cargo.toml")
        or _find_file(path, "go.mod")
    )
    manifest_name = manifest_entry[0] if manifest_entry else None
    manifest = manifest_entry[1] if manifest_entry else None
    top_dirs = _top_level_dirs(path)
    recent_files = _recent_git_files(path)
    tags = _find_skill_tags(path)

    profile: dict[str, Any] = {
        "repoPath": str(path),
        "repoName": path.name,
        "readmePreview": readme[:4096],
        "manifestSnippet": manifest[:2048] if manifest else None,
        "manifestType": manifest_name,
        "topLevelDirs": top_dirs,
        "recentFilesCount": len(recent_files),
        "recentFiles": recent_files[:50],
        "skillTags": tags,
        "isGitRepo": (path / ".git").is_dir(),
    }

    _PROFILE_CACHE[cache_key] = profile
    return profile


def clear_cache() -> None:
    """Clear the profile cache (e.g., after a deploy)."""
    _PROFILE_CACHE.clear()


def get_cached_profiles() -> dict[str, dict[str, Any] | None]:
    """Return a copy of the current cache (for diagnostics)."""
    return dict(_PROFILE_CACHE)
