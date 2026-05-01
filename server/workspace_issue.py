"""RepoCiv — workspace-issue state store.

Task-folder portable per issue: spec/plan/state/output under
~/.repociv/workspaces/<repo>/<issue_id>/.

Inspired by sortie's A2O protocol, subtask file-based context passing,
and full-stack-orchestration's artifact-driven state management.
"""
from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Any

from . import locks as _locks


_base_dir: Path | None = None


def init(store_dir: Path) -> None:
    """Initialize the workspace-issue store under store_dir/workspaces/."""
    global _base_dir
    _base_dir = store_dir / "workspaces"
    _base_dir.mkdir(parents=True, exist_ok=True)


def _require_base() -> Path:
    if _base_dir is None:
        raise RuntimeError("workspace-issue store not initialized")
    return _base_dir


def _sanitize(s: str) -> str:
    """Sanitize repo/issue IDs for filesystem safety."""
    return s.replace("/", "_").replace("\\", "_")


def _issue_dir(repo: str, issue_id: str) -> Path:
    return _require_base() / _sanitize(repo) / _sanitize(issue_id)


def _state_path(repo: str, issue_id: str) -> Path:
    return _issue_dir(repo, issue_id) / "state.json"


def _output_dir(repo: str, issue_id: str) -> Path:
    return _issue_dir(repo, issue_id) / "output"


def _spec_path(repo: str, issue_id: str) -> Path:
    return _issue_dir(repo, issue_id) / "spec.md"


def _plan_path(repo: str, issue_id: str) -> Path:
    return _issue_dir(repo, issue_id) / "plan.md"


def _atomic_write(path: Path, content: str) -> None:
    """Write content atomically via tmp + rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def _now_iso(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts or time.time()))


def _default_state(repo: str, issue_id: str) -> dict[str, Any]:
    return {
        "repo": repo,
        "issueId": issue_id,
        "phase": "init",
        "runIds": [],
        "artifactCount": 0,
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
    }


# ── Public API ────────────────────────────────────────────────────────────────


def init_issue_workspace(repo: str, issue_id: str) -> dict[str, Any]:
    """Create the full issue workspace: spec.md, plan.md, state.json, output/.

    Idempotent — safe to call on an already-initialized workspace. Returns the
    current (or newly created) state dict.
    """
    lock_key = f"issue:{repo}:{issue_id}"
    with _locks.hold(lock_key):
        issue_dir = _issue_dir(repo, issue_id)
        issue_dir.mkdir(parents=True, exist_ok=True)
        _output_dir(repo, issue_id).mkdir(exist_ok=True)

        # spec.md — create empty template if missing
        spec_p = _spec_path(repo, issue_id)
        if not spec_p.exists():
            spec_p.write_text(f"# {issue_id}\n\n> repo: {repo}\n\n", encoding="utf-8")

        # plan.md — create empty template if missing
        plan_p = _plan_path(repo, issue_id)
        if not plan_p.exists():
            plan_p.write_text(f"# Plan: {issue_id}\n\n", encoding="utf-8")

        # state.json — create default if missing
        state_p = _state_path(repo, issue_id)
        if state_p.exists():
            existing = load_issue_state(repo, issue_id)
            if existing is not None:
                return existing
        state = _default_state(repo, issue_id)
        _atomic_write(state_p, json.dumps(state, ensure_ascii=False, indent=2))
        return state


def load_issue_state(repo: str, issue_id: str) -> dict[str, Any] | None:
    """Load the state.json for an issue. Returns None if not found."""
    path = _state_path(repo, issue_id)
    if not path.exists():
        return None
    with _locks.hold(f"issue:{repo}:{issue_id}"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
    return data if isinstance(data, dict) else None


def save_issue_state(repo: str, issue_id: str, state: dict[str, Any]) -> dict[str, Any]:
    """Persist a full state dict. Overwrites existing."""
    with _locks.hold(f"issue:{repo}:{issue_id}"):
        data = dict(state)
        data["repo"] = repo
        data["issueId"] = issue_id
        data["updatedAt"] = _now_iso()
        _atomic_write(_state_path(repo, issue_id),
                      json.dumps(data, ensure_ascii=False, indent=2))
        return data


def patch_issue_state(repo: str, issue_id: str,
                      patch_dict: dict[str, Any]) -> dict[str, Any]:
    """Update fields in the issue state. Creates state if it doesn't exist."""
    with _locks.hold(f"issue:{repo}:{issue_id}"):
        current = load_issue_state(repo, issue_id)
        if current is None:
            current = _default_state(repo, issue_id)
        current.update(patch_dict)
        current["updatedAt"] = _now_iso()
        _atomic_write(_state_path(repo, issue_id),
                      json.dumps(current, ensure_ascii=False, indent=2))
        return current


def add_artifact(repo: str, issue_id: str, name: str, *,
                 content: str | None = None,
                 source_path: str | None = None) -> dict[str, Any]:
    """Add an artifact to the output/ directory.

    Provide either ``content`` (text written directly) or ``source_path``
    (an existing file copied in). The artifact counter in state.json is
    incremented.
    """
    if content is None and source_path is None:
        raise ValueError("add_artifact requires content= or source_path=")

    with _locks.hold(f"issue:{repo}:{issue_id}"):
        out_dir = _output_dir(repo, issue_id)
        out_dir.mkdir(parents=True, exist_ok=True)
        dest = out_dir / name

        if source_path:
            shutil.copy2(source_path, str(dest))
        else:
            dest.write_text(content, encoding="utf-8")  # type: ignore[arg-type]

        # Bump counter in state
        state = load_issue_state(repo, issue_id)
        if state is None:
            state = _default_state(repo, issue_id)
        state["artifactCount"] = state.get("artifactCount", 0) + 1
        state["updatedAt"] = _now_iso()
        _atomic_write(_state_path(repo, issue_id),
                      json.dumps(state, ensure_ascii=False, indent=2))
        return state


def list_artifacts(repo: str, issue_id: str) -> list[str]:
    """Return sorted list of artifact filenames in output/."""
    out_dir = _output_dir(repo, issue_id)
    if not out_dir.exists():
        return []
    return sorted(p.name for p in out_dir.iterdir() if p.is_file())


# ── Step artifact helpers (context seeding) ───────────────────────────────────

def write_step_artifact(
    repo: str, issue_id: str, step_idx: int, agent: str, content: str
) -> None:
    """Write a numbered step output artifact for context seeding.

    Files are named ``{step_idx:02d}-{agent}-output.md`` inside output/.
    These are the files read by the next step's context builder.
    """
    safe_agent = "".join(c if c.isalnum() or c == "_" else "_" for c in agent.lower())
    name = f"{step_idx:02d}-{safe_agent}-output.md"
    with _locks.hold(f"issue:{repo}:{issue_id}"):
        out_dir = _output_dir(repo, issue_id)
        out_dir.mkdir(parents=True, exist_ok=True)
        _atomic_write(out_dir / name, content)


def read_output_artifacts(
    repo: str, issue_id: str, up_to_step: int
) -> list[tuple[str, str]]:
    """Return (name, content) pairs for step artifacts BEFORE up_to_step.

    Only returns ``*-output.md`` files whose step index is < up_to_step,
    sorted ascending. Returns an empty list if none exist.
    """
    out_dir = _output_dir(repo, issue_id)
    if not out_dir.exists():
        return []

    results: list[tuple[str, str]] = []
    for path in sorted(out_dir.iterdir()):
        name = path.name
        if not name.endswith("-output.md"):
            continue
        # Filename format: NN-agent-output.md
        parts = name.split("-", 1)
        if not parts[0].isdigit():
            continue
        idx = int(parts[0])
        if idx >= up_to_step:
            continue
        try:
            content = path.read_text(encoding="utf-8")
            results.append((name, content))
        except OSError:
            pass
    return results


def read_artifact(repo: str, issue_id: str, name: str) -> str | None:
    """Read an artifact's text content. Returns None if not found."""
    path = _output_dir(repo, issue_id) / name
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def write_spec(repo: str, issue_id: str, content_md: str) -> None:
    """Write (overwrite) spec.md for an issue."""
    with _locks.hold(f"issue:{repo}:{issue_id}"):
        _issue_dir(repo, issue_id).mkdir(parents=True, exist_ok=True)
        _spec_path(repo, issue_id).write_text(content_md, encoding="utf-8")


def write_plan(repo: str, issue_id: str, content_md: str) -> None:
    """Write (overwrite) plan.md for an issue."""
    with _locks.hold(f"issue:{repo}:{issue_id}"):
        _issue_dir(repo, issue_id).mkdir(parents=True, exist_ok=True)
        _plan_path(repo, issue_id).write_text(content_md, encoding="utf-8")


def read_spec(repo: str, issue_id: str) -> str | None:
    """Read spec.md content. Returns None if not found."""
    path = _spec_path(repo, issue_id)
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def read_plan(repo: str, issue_id: str) -> str | None:
    """Read plan.md content. Returns None if not found."""
    path = _plan_path(repo, issue_id)
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def get_issue_summary(repo: str, issue_id: str) -> dict[str, Any]:
    """Return an operational summary of the issue workspace."""
    state = load_issue_state(repo, issue_id)
    has_spec = _spec_path(repo, issue_id).exists()
    has_plan = _plan_path(repo, issue_id).exists()
    artifacts = list_artifacts(repo, issue_id)

    return {
        "repo": repo,
        "issueId": issue_id,
        "exists": state is not None,
        "phase": state.get("phase", "unknown") if state else "unknown",
        "hasSpec": has_spec,
        "hasPlan": has_plan,
        "artifactCount": state.get("artifactCount", 0) if state else 0,
        "artifactNames": artifacts,
        "runIds": state.get("runIds", []) if state else [],
        "updatedAt": state.get("updatedAt", "") if state else "",
    }


def list_issues(repo: str | None = None) -> list[dict[str, str]]:
    """List all initialized issues, optionally filtered by repo.

    Returns a list of {repo, issueId} dicts.
    """
    base = _require_base()
    if not base.exists():
        return []

    out: list[dict[str, str]] = []

    if repo is not None:
        safe_repo = _sanitize(repo)
        repo_dir = base / safe_repo
        if not repo_dir.is_dir():
            return []
        for issue_dir in sorted(repo_dir.iterdir()):
            if issue_dir.is_dir() and (issue_dir / "state.json").exists():
                out.append({"repo": repo, "issueId": issue_dir.name})
        return out

    # No repo filter — traverse all
    for repo_dir in sorted(base.iterdir()):
        if not repo_dir.is_dir():
            continue
        r_name = repo_dir.name.replace("_", "/")
        for issue_dir in sorted(repo_dir.iterdir()):
            if issue_dir.is_dir() and (issue_dir / "state.json").exists():
                out.append({"repo": r_name, "issueId": issue_dir.name})
    return out


# ── Helpers for bridge integration ────────────────────────────────────────────


def register_run(repo: str, issue_id: str, run_id: str) -> dict[str, Any]:
    """Record a run_id in the issue's runIds list. Called after command dispatch."""
    with _locks.hold(f"issue:{repo}:{issue_id}"):
        state = load_issue_state(repo, issue_id)
        if state is None:
            state = _default_state(repo, issue_id)
        run_ids: list[str] = state.get("runIds", [])
        if run_id not in run_ids:
            run_ids.append(run_id)
            state["runIds"] = run_ids
        state["updatedAt"] = _now_iso()
        _atomic_write(_state_path(repo, issue_id),
                      json.dumps(state, ensure_ascii=False, indent=2))
        return state


def _reset() -> None:
    """Test helper: drop in-memory base_dir."""
    global _base_dir
    _base_dir = None
