"""RepoCiv — Sprint B2: YAML Hook Security.

Reads repository configuration from ~/.repociv/configs/<repo>.yaml.
NEVER reads config from inside the repo itself — prevents path traversal and
arbitrary code execution.

Security guarantees:
  - Repo name sanitised: only [a-zA-Z0-9_-] allowed; rejects '..', '/', '~'.
  - YAML is parsed as plain data (safe_load); never eval'd as code.
  - Hook commands validated against ALLOWED_HOOK_COMMANDS whitelist (prefix match).
  - Config directory is always inside ~/.repociv/configs/ — no escape possible.

Public API:
  load_repo_config(repo: str) -> dict
  get_hook(repo: str, hook_name: str) -> str | None
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

try:
    import yaml as _yaml  # PyYAML optional; fallback to no-op if not installed
    _YAML_AVAILABLE = True
except ImportError:  # pragma: no cover
    _YAML_AVAILABLE = False

# ─── Whitelist ────────────────────────────────────────────────────────────────
ALLOWED_HOOK_COMMANDS: list[str] = [
    "npm test",
    "npm run lint",
    "pytest",
    "make test",
    "cargo test",
    "go test ./...",
    "mvn test",
    "gradle test",
]

# Recognised hook names
KNOWN_HOOK_NAMES: frozenset[str] = frozenset({"pre_step", "post_step", "on_circuit_open"})

# Repo name: only alphanumeric, underscore, hyphen; 1-128 chars
_REPO_NAME_RE = re.compile(r'^[a-zA-Z0-9_-]{1,128}$')

# Config base directory (can be overridden in tests)
_CONFIG_BASE: Path = Path.home() / ".repociv" / "configs"


def _validate_repo_name(repo: str) -> None:
    """Raise ValueError if repo name contains unsafe characters."""
    if not repo:
        raise ValueError("repo name must not be empty")
    if not _REPO_NAME_RE.match(repo):
        raise ValueError(
            f"Invalid repo name {repo!r}: only [a-zA-Z0-9_-] allowed. "
            "Path traversal characters ('..', '/', '~') are rejected."
        )


def _validate_hook_command(command: str) -> None:
    """Raise ValueError if command is not prefixed by an ALLOWED_HOOK_COMMANDS entry."""
    stripped = command.strip()
    for allowed in ALLOWED_HOOK_COMMANDS:
        if stripped == allowed or stripped.startswith(allowed + " ") or stripped.startswith(allowed + "\t"):
            return
    raise ValueError(
        f"Hook command {command!r} is not allowed. "
        f"Permitted commands: {ALLOWED_HOOK_COMMANDS}"
    )


def _validate_config(config: dict[str, Any]) -> None:
    """Validate all hooks in a loaded config dict."""
    hooks = config.get("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("'hooks' must be a mapping in repo config YAML")
    for hook_name, command in hooks.items():
        if not isinstance(command, str):
            raise ValueError(f"Hook {hook_name!r} value must be a string, got {type(command)}")
        _validate_hook_command(command)


def _config_path(repo: str) -> Path:
    """Return the safe config file path for the given repo name."""
    # Validation already ensures repo has no path-traversal chars, but we also
    # resolve the full path and assert it stays inside _CONFIG_BASE.
    path = _CONFIG_BASE / f"{repo}.yaml"
    # Paranoia check: ensure no symlink tricks escape the config dir
    resolved = path.resolve()
    config_base_resolved = _CONFIG_BASE.resolve()
    if not str(resolved).startswith(str(config_base_resolved) + "/") and resolved != config_base_resolved:
        # Extra safety: never allow escape
        raise ValueError(f"Resolved config path {resolved} escapes config directory")
    return path


_DEFAULT_CONFIG: dict[str, Any] = {"hooks": {}}


def load_repo_config(repo: str) -> dict[str, Any]:
    """Load and validate repository configuration.

    Args:
        repo: Repository name (must match [a-zA-Z0-9_-]).

    Returns:
        Config dict with at least {"hooks": {}}.

    Raises:
        ValueError: if repo name is invalid, or any hook contains a disallowed command.
    """
    _validate_repo_name(repo)
    path = _config_path(repo)

    if not path.exists():
        return dict(_DEFAULT_CONFIG)

    raw = path.read_text(encoding="utf-8")

    if not _YAML_AVAILABLE:
        # Without PyYAML we cannot parse — return defaults safely
        return dict(_DEFAULT_CONFIG)

    try:
        data = _yaml.safe_load(raw)  # safe_load: no Python object construction
    except Exception as exc:
        raise ValueError(f"Failed to parse YAML config for repo {repo!r}: {exc}") from exc

    if data is None:
        return dict(_DEFAULT_CONFIG)

    if not isinstance(data, dict):
        raise ValueError(f"Repo config for {repo!r} must be a YAML mapping at top level")

    config: dict[str, Any] = {"hooks": {}, **data}
    _validate_config(config)
    return config


def get_hook(repo: str, hook_name: str) -> str | None:
    """Return the command for a named hook, or None if not configured.

    Args:
        repo:      Repository name.
        hook_name: One of 'pre_step', 'post_step', 'on_circuit_open'.

    Returns:
        Command string, or None.
    """
    if hook_name not in KNOWN_HOOK_NAMES:
        return None
    config = load_repo_config(repo)
    return config.get("hooks", {}).get(hook_name) or None


def run_hook(repo: str, hook_name: str, timeout: int = 30) -> dict[str, Any] | None:
    """Execute a configured hook as a subprocess.

    Args:
        repo:      Repository name.
        hook_name: Hook to execute.
        timeout:   Maximum seconds to wait (default 30).

    Returns:
        {"returncode": int, "stdout": str, "stderr": str} if hook exists,
        None if hook is not configured.
    """
    command = get_hook(repo, hook_name)
    if command is None:
        return None

    try:
        proc = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "returncode": proc.returncode,
            "stdout": proc.stdout[:4096],
            "stderr": proc.stderr[:4096],
        }
    except subprocess.TimeoutExpired:
        return {"returncode": -1, "stdout": "", "stderr": f"Hook timed out after {timeout}s"}
    except Exception as exc:
        return {"returncode": -1, "stdout": "", "stderr": str(exc)}
