"""RepoCiv — workspace-issue state store.

Task-folder portable per issue: spec/plan/state/output under
~/.repociv/workspaces/<repo>/<issue_id>/.

Inspired by sortie's A2O protocol, subtask file-based context passing,
and full-stack-orchestration's artifact-driven state management.
"""
from __future__ import annotations

import json
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


# ── A2O Sentinel File (H1 — from DAVI audit) ─────────────────────────────────

_SENTINEL_VALID: frozenset[str] = frozenset({"blocked", "needs-human-review", "done", "ok"})


def _sentinel_path(repo: str, issue_id: str) -> Path:
    """Return the path to the A2O sentinel status file for this issue.

    Located at ``<issue_dir>/.repociv/status`` — a zero-dependency signal file
    that the agent (or orchestrator) writes to communicate lifecycle state back
    to the orchestrator (or the caller).
    """
    return _issue_dir(repo, issue_id) / ".repociv" / "status"


def write_sentinel(repo: str, issue_id: str, status: str) -> None:
    """Write the A2O sentinel file.

    Valid statuses:
      - ``"blocked"``              — agent cannot proceed; human required.
      - ``"needs-human-review"``   — checkpoint gate; review and clear to resume.
      - ``"done"``                 — task completed successfully.
      - ``"ok"``                   — explicit all-clear.

    The orchestrator reads this before advancing to the next phase.
    The executing agent may also write ``"blocked"`` to stop the loop.
    """
    if status not in _SENTINEL_VALID:
        raise ValueError(
            f"Invalid sentinel status {status!r}. "
            f"Expected one of: {sorted(_SENTINEL_VALID)}"
        )
    _atomic_write(_sentinel_path(repo, issue_id), status)


def read_sentinel(repo: str, issue_id: str) -> str | None:
    """Read the current A2O sentinel status.

    Returns the status string, or ``None`` if the sentinel file does not exist.
    """
    path = _sentinel_path(repo, issue_id)
    if not path.exists():
        return None
    try:
        return path.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def clear_sentinel(repo: str, issue_id: str) -> None:
    """Delete the A2O sentinel file (human resume signal).

    Idempotent: no-op if the file does not exist.
    """
    path = _sentinel_path(repo, issue_id)
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


# ── Git worktree integration (H5) ────────────────────────────────────────────

def ensure_worktree(repo: str, issue_id: str) -> str | None:
    """Create a git worktree for this issue if worktrees are enabled.

    Delegates to ``repociv_hooks.create_worktree()``. Best-effort: returns
    the worktree path string on success, ``None`` if disabled or if the
    operation fails (e.g. repo is not a git repository).

    The worktree path is persisted in ``state.json["worktreePath"]`` so the
    orchestrator can clean it up even after a crash restart.
    """
    try:
        from . import repociv_hooks as _hooks  # deferred — avoids circular import
        wt = _hooks.create_worktree(repo, issue_id)
        if wt:
            patch_issue_state(repo, issue_id, {"worktreePath": str(wt)})
            return str(wt)
    except Exception:
        pass
    return None


def release_worktree(repo: str, issue_id: str) -> bool:
    """Remove the git worktree for this issue (called on close or failure).

    Best-effort: returns ``True`` if a removal was attempted.
    Never raises.
    """
    try:
        from . import repociv_hooks as _hooks
        return _hooks.remove_worktree(repo, issue_id)
    except Exception:
        return False


def _reset() -> None:
    """Test helper: drop in-memory base_dir."""
    global _base_dir
    _base_dir = None


# ── Validation Contract ──────────────────────────────────────────────────────

_VALIDATION_CONTRACT_VERSION = "1.0"


def _validation_contract_path(repo: str, issue_id: str) -> Path:
    """Return path to validation_contract.json for this issue."""
    return _issue_dir(repo, issue_id) / "validation_contract.json"


def _default_validation_contract(repo: str, issue_id: str) -> dict[str, Any]:
    return {
        "version": _VALIDATION_CONTRACT_VERSION,
        "goal": "",
        "deliverables": [],
        "mustPassChecks": [],
        "behaviourChecks": [],
        "forbiddenChanges": [],
        "evidenceRequired": [],
        "doneDefinition": "",
        "autoGenerated": False,
    }


def write_validation_contract(
    repo: str, issue_id: str, contract: dict[str, Any]
) -> dict[str, Any]:
    """Write (overwrite) validation_contract.json for an issue.

    Normalizes the contract: ensures version, autoGenerated flag, and
    all required keys are present.
    """
    with _locks.hold(f"issue:{repo}:{issue_id}"):
        normalized = {**_default_validation_contract(repo, issue_id), **contract}
        normalized["version"] = _VALIDATION_CONTRACT_VERSION
        normalized["autoGenerated"] = bool(normalized.get("autoGenerated", False))
        _issue_dir(repo, issue_id).mkdir(parents=True, exist_ok=True)
        _atomic_write(
            _validation_contract_path(repo, issue_id),
            json.dumps(normalized, ensure_ascii=False, indent=2),
        )
        return normalized


def read_validation_contract(repo: str, issue_id: str) -> dict[str, Any] | None:
    """Read validation_contract.json. Returns None if not found."""
    path = _validation_contract_path(repo, issue_id)
    if not path.exists():
        return None
    with _locks.hold(f"issue:{repo}:{issue_id}"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
    return data if isinstance(data, dict) else None


def has_validation_contract(repo: str, issue_id: str) -> bool:
    """Return True if a validation contract exists for this issue."""
    return _validation_contract_path(repo, issue_id).exists()


def generate_contract_from_spec(repo: str, issue_id: str) -> dict[str, Any]:
    """Auto-generate a minimal validation contract from spec.md content.

    Parses the spec markdown for a '## Goal' section and bullet lists
    to populate the contract. Sets autoGenerated=True.
    """
    spec = read_spec(repo, issue_id) or ""
    goal = ""
    deliverables: list[str] = []
    done_definition = ""

    # Simple heuristic parse: extract first H2 section as goal,
    # bullet items as deliverables
    current_section = ""
    for line in spec.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            current_section = stripped[3:].lower()
            continue
        if stripped.startswith("- ") or stripped.startswith("* "):
            item = stripped[2:].strip()
            if "goal" in current_section:
                if not goal:
                    goal = item
                else:
                    deliverables.append(item)
            elif "deliverable" in current_section:
                deliverables.append(item)
            elif "done" in current_section or "definition" in current_section:
                done_definition = item
        elif current_section and stripped and not stripped.startswith("#"):
            if "goal" in current_section and not goal:
                goal = stripped[:200]

    contract = _default_validation_contract(repo, issue_id)
    contract["goal"] = goal
    contract["deliverables"] = deliverables
    contract["doneDefinition"] = done_definition
    contract["autoGenerated"] = True
    # Only add must-pass checks if the spec explicitly mentions tests or quality
    spec_lower = spec.lower()
    if "test" in spec_lower or "quality" in spec_lower or "lint" in spec_lower:
        contract["mustPassChecks"] = ["tests-pass"]
    return write_validation_contract(repo, issue_id, contract)


# ── Handoff artifacts ────────────────────────────────────────────────────────

_HANDOFF_VERSION = "1.0"
_HANDOFF_AGENT_TYPES = frozenset({"SCOUT", "WORKER", "VALIDATOR", "MAIN"})


def _handoff_path(repo: str, issue_id: str, phase_or_step: str, role: str) -> Path:
    """Return path to a handoff JSON file."""
    safe_role = "".join(c if c.isalnum() or c == "_" else "_" for c in role.upper())
    safe_phase = "".join(c if c.isalnum() or c == "_" else "_" for c in phase_or_step.lower())
    return _issue_dir(repo, issue_id) / "output" / f"handoff-{safe_phase}-{safe_role}.json"


def write_handoff(
    repo: str,
    issue_id: str,
    phase_or_step: str,
    role: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Write a structured handoff artifact.

    The handoff captures the work completed by one role so the next role
    can pick it up without depending on context window.

    Payload should include:
      - completed_work: list[str]
      - commands_run: list[str]
      - files_changed: list[str]
      - tests_run: list[str]
      - open_risks: list[str]
      - known_failures: list[str]
      - recommended_next_role: str
      - recommended_next_action: str
    """
    if role.upper() not in _HANDOFF_AGENT_TYPES and role.upper() not in {"ORCHESTRATOR"}:
        raise ValueError(f"Unknown handoff role {role!r}. Expected one of: {sorted(_HANDOFF_AGENT_TYPES | {'ORCHESTRATOR'})}")

    with _locks.hold(f"issue:{repo}:{issue_id}"):
        handoff = {
            "version": _HANDOFF_VERSION,
            "repo": repo,
            "issueId": issue_id,
            "phase": phase_or_step,
            "role": role.upper(),
            "timestamp": _now_iso(),
            "completedWork": payload.get("completed_work", []),
            "commandsRun": payload.get("commands_run", []),
            "filesChanged": payload.get("files_changed", []),
            "testsRun": payload.get("tests_run", []),
            "openRisks": payload.get("open_risks", []),
            "knownFailures": payload.get("known_failures", []),
            "recommendedNextRole": payload.get("recommended_next_role", ""),
            "recommendedNextAction": payload.get("recommended_next_action", ""),
        }
        path = _handoff_path(repo, issue_id, phase_or_step, role)
        _atomic_write(path, json.dumps(handoff, ensure_ascii=False, indent=2))
        return handoff


def read_latest_handoff(
    repo: str, issue_id: str, *, role: str | None = None
) -> dict[str, Any] | None:
    """Read the latest handoff artifact for an issue.

    If role is specified, only returns handoffs from that role.
    Returns the most recent handoff by file modification time.
    """
    out_dir = _output_dir(repo, issue_id)
    if not out_dir.exists():
        return None

    handoffs: list[tuple[Path, float]] = []
    for path in out_dir.iterdir():
        if not path.name.startswith("handoff-") or not path.name.endswith(".json"):
            continue
        if role:
            # Filename format: handoff-<phase>-<role>.json
            parts = path.stem.replace("handoff-", "").rsplit("-", 1)
            if len(parts) == 2 and parts[1].upper() != role.upper():
                continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        handoffs.append((path, mtime))

    if not handoffs:
        return None

    # Return the most recently modified
    handoffs.sort(key=lambda x: x[1], reverse=True)
    try:
        data = json.loads(handoffs[0][0].read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None
