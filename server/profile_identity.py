"""RepoCiv — Profile identity I/O per harness.

Resolves the identity file path for a given profile and provides
read/write helpers. The UI shows this as "Alma" (soul).

Resolution table (matches harness_cards/*/profile_binding):

  hermes   native  → ~/.hermes/profiles/<harness_ref>/SOUL.md
  hermes   managed → ~/.repociv/profiles/<name>/identity.md
  claude   native  → ~/.claude/CLAUDE.md
  claude   managed → ~/.repociv/profiles/<name>/CLAUDE.md
  codex    native  → ~/.codex/AGENTS.md  (global; harness_ref not used)
  codex    managed → ~/.repociv/profiles/<name>/AGENTS.md
  openclaw native  → ~/.openclaw/agents/<harness_ref>/agent.md
  openclaw managed → ~/.repociv/profiles/<name>/identity.md
  cursor   native  → ~/.cursor/rules/repociv-<name>.mdc  (workspace rules)
  cursor   managed → ~/.repociv/profiles/<name>/identity.md

For all harnesses the managed path is always writable by RepoCiv without
touching the harness's own filesystem.

harness_options:
  hermes   → list subdirs of ~/.hermes/profiles/
  codex    → `codex profiles list` (best-effort) + .config.toml glob
  openclaw → `openclaw agents list` (best-effort)
  claude   → []  (no native profile system)
  cursor   → []  (no native profile system)
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

# ─── Constants ────────────────────────────────────────────────────────────────

_REPOCIV_PROFILES_DIR = Path.home() / ".repociv" / "profiles"
_HERMES_PROFILES_DIR = Path.home() / ".hermes" / "profiles"
_CLAUDE_USER_DIR = Path.home() / ".claude"
_CODEX_DIR = Path.home() / ".codex"
_OPENCLAW_AGENTS_DIR = Path.home() / ".openclaw" / "agents"
_CURSOR_RULES_DIR = Path.home() / ".cursor" / "rules"


# ─── Path resolution ──────────────────────────────────────────────────────────

def _repociv_profile_dir(profile_name: str) -> Path:
    return _REPOCIV_PROFILES_DIR / profile_name


def resolve_identity_path(
    profile_name: str,
    harness: str,
    harness_ref: str = "default",
    identity_mode: str = "managed",
) -> Path:
    """Return the Path of the identity file for this profile.

    Does NOT create the file; use write_identity() for that.
    """
    mode = identity_mode or "managed"
    h = harness.strip().lower()

    if h == "hermes":
        if mode == "native" and harness_ref and harness_ref != "default":
            return _HERMES_PROFILES_DIR / harness_ref / "SOUL.md"
        return _repociv_profile_dir(profile_name) / "identity.md"

    if h == "claude":
        if mode == "native":
            return _CLAUDE_USER_DIR / "CLAUDE.md"
        return _repociv_profile_dir(profile_name) / "CLAUDE.md"

    if h == "codex":
        if mode == "native":
            return _CODEX_DIR / "AGENTS.md"
        return _repociv_profile_dir(profile_name) / "AGENTS.md"

    if h == "openclaw":
        if mode == "native" and harness_ref and harness_ref != "default":
            return _OPENCLAW_AGENTS_DIR / harness_ref / "agent.md"
        return _repociv_profile_dir(profile_name) / "identity.md"

    # cursor + unknown
    if mode == "native":
        return _CURSOR_RULES_DIR / f"repociv-{profile_name}.mdc"
    return _repociv_profile_dir(profile_name) / "identity.md"


# ─── Read / Write ─────────────────────────────────────────────────────────────

def read_identity(
    profile_name: str,
    harness: str,
    harness_ref: str = "default",
    identity_mode: str = "managed",
) -> dict[str, Any]:
    """Return {"content": str, "path": str, "exists": bool}."""
    path = resolve_identity_path(profile_name, harness, harness_ref, identity_mode)
    if path.exists():
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as exc:
            return {"content": "", "path": str(path), "exists": False, "error": str(exc)}
        return {"content": content, "path": str(path), "exists": True}
    return {"content": "", "path": str(path), "exists": False}


def write_identity(
    profile_name: str,
    harness: str,
    content: str,
    harness_ref: str = "default",
    identity_mode: str = "managed",
) -> dict[str, Any]:
    """Write identity content. Makes .bak backup if file already exists.

    Returns {"ok": bool, "path": str, "error"?: str}
    """
    path = resolve_identity_path(profile_name, harness, harness_ref, identity_mode)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            bak = path.with_suffix(path.suffix + ".bak")
            shutil.copy2(str(path), str(bak))
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(content, encoding="utf-8")
        os.replace(str(tmp), str(path))
        return {"ok": True, "path": str(path)}
    except OSError as exc:
        return {"ok": False, "path": str(path), "error": str(exc)}


# ─── Harness options (available refs) ─────────────────────────────────────────

def list_harness_options(harness: str) -> list[str]:
    """Return available harness_ref values for the given harness.

    Best-effort: returns [] on any subprocess/filesystem failure.
    """
    h = harness.strip().lower()

    if h == "hermes":
        return _list_dirs(_HERMES_PROFILES_DIR)

    if h == "codex":
        # Try subprocess first
        codex_bin = shutil.which("codex")
        if codex_bin:
            try:
                result = subprocess.run(
                    [codex_bin, "profiles", "list"],
                    capture_output=True, text=True, timeout=8,
                )
                if result.returncode == 0:
                    lines = [l.strip() for l in result.stdout.splitlines() if l.strip()]
                    if lines:
                        return lines
            except Exception:
                pass
        # Fallback: .config.toml files in ~/.codex/
        return [
            p.stem.replace(".config", "")
            for p in _CODEX_DIR.glob("*.config.toml")
            if p.is_file()
        ] if _CODEX_DIR.exists() else []

    if h == "openclaw":
        openclaw_bin = shutil.which("openclaw")
        if openclaw_bin:
            try:
                result = subprocess.run(
                    [openclaw_bin, "agents", "list"],
                    capture_output=True, text=True, timeout=8,
                )
                if result.returncode == 0:
                    data = json.loads(result.stdout)
                    if isinstance(data, list):
                        return [
                            str(item.get("id") or item.get("name") or item)
                            for item in data if item
                        ]
            except Exception:
                pass
        # Fallback: subdirs of ~/.openclaw/agents/
        return _list_dirs(_OPENCLAW_AGENTS_DIR)

    # claude, cursor — no native profile list
    return []


def _list_dirs(base: Path) -> list[str]:
    if not base.exists() or not base.is_dir():
        return []
    return sorted(d.name for d in base.iterdir() if d.is_dir())
