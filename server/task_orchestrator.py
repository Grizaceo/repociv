"""RepoCiv — P3: Task Orchestrator (mission runner).

Full cycle per issue: spec → plan → dispatch → collect → close.
Connects workspace_issue (P2), workspace_state (P1), and run_state (P0).

Phase machine:
  init → spec → planned → executing → complete (or failed / cancelled)

Usage (real):
  orchestrator.set_step_executor(my_dispatch_fn)
  orchestrator.run_task("my-repo", "ISSUE-1")

Usage (test):
  orchestrator.set_step_executor(lambda *a: "mock-run-id")
"""

from __future__ import annotations

import json
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable

from . import locks as _locks
from . import workspace_issue as _wi
from . import workspace_state as _ws
from . import run_state as _rs


# ─── Injectable step executor ─────────────────────────────────────────────────
# fn(repo, issue_id, step_description, step_meta) -> run_id
_step_executor: Callable[..., str] | None = None


def set_step_executor(fn: Callable[..., str]) -> None:
    """Register the function that executes one plan step. Returns a run_id."""
    global _step_executor
    _step_executor = fn


# ─── Async task registry ──────────────────────────────────────────────────────
_registry_lock = threading.Lock()
_registry: dict[str, dict[str, Any]] = {}  # task_key → {phase, startedAt, ...}


def _task_key(repo: str, issue_id: str) -> str:
    return f"{repo}::{issue_id}"


def _now_iso(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts or time.time()))


# ─── Plan helpers ─────────────────────────────────────────────────────────────

def _generate_plan_from_spec(spec: str) -> str:
    """Generate a minimal plan.md from spec content (fallback)."""
    title_line = ""
    for line in spec.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            title_line = stripped[2:].strip()
            break
    name = title_line or "task"
    return (
        f"# Plan: {name}\n\n"
        f"- [ ] Analyze requirements from spec.md\n"
        f"- [ ] Implement the changes described in spec.md\n"
        f"- [ ] Verify with tests\n"
        f"- [ ] Document result\n"
    )


def _extract_steps(plan: str) -> list[str]:
    """Extract actionable steps from plan.md content.

    Looks for lines starting with '- [ ]', '- ', '* ', '1.', etc.
    Falls back to treating the whole plan as one step.
    """
    steps: list[str] = []
    for line in plan.splitlines():
        stripped = line.strip()
        # Match markdown checkboxes, bullets, numbered lists
        if (
            stripped.startswith("- [ ]")
            or stripped.startswith("- [x]")
            or stripped.startswith("- [X]")
        ):
            steps.append(stripped[5:].strip())
        elif stripped.startswith("- ") or stripped.startswith("* "):
            step = stripped[2:].strip()
            if step:
                steps.append(step)
        elif (
            len(stripped) > 2
            and stripped[0].isdigit()
            and stripped[1:].startswith(". ")
        ):
            steps.append(stripped.split(". ", 1)[1].strip())

    if not steps:
        # Fallback: single step
        steps.append(plan.strip()[:200])

    return steps


def _step_slug(step: str) -> str:
    """Safe filename slug from step text."""
    slug = "".join(c if c.isalnum() or c in "_-" else "_" for c in step.lower())
    return slug[:40].strip("_")


# ─── Public API ───────────────────────────────────────────────────────────────


def run_task(repo: str, issue_id: str) -> dict[str, Any]:
    """Execute the full task cycle synchronously.

    Phases: init → spec → planned → executing → complete
    On error: phase → failed with traceback artifact.
    Idempotent: tasks already complete/failed/cancelled return immediately.
    """
    lock_key = f"task_orch:{repo}:{issue_id}"
    task_key = _task_key(repo, issue_id)

    with _locks.hold(lock_key):
        # ── Load or init state ────────────────────────────────────────────
        state = _wi.load_issue_state(repo, issue_id)
        if state is None:
            state = _wi.init_issue_workspace(repo, issue_id)

        phase = state.get("phase", "init")

        # Idempotency guard
        if phase in ("complete", "failed", "cancelled"):
            with _registry_lock:
                _registry[task_key] = {
                    "phase": phase,
                    "startedAt": state.get("startedAt", ""),
                    "updatedAt": _now_iso(),
                }
            return state

        # Register as in-flight
        with _registry_lock:
            _registry[task_key] = {
                "phase": "executing",
                "startedAt": _now_iso(),
            }

        try:
            # ── Phase: init/any → spec ────────────────────────────────────
            spec = _wi.read_spec(repo, issue_id)
            # Strip markdown headings to detect heading-only specs
            import re as _re
            _body = _re.sub(r'^#.*$', '', spec, flags=_re.MULTILINE).strip()
            if not _body or len(_body.strip()) < 10:
                raise ValueError(
                    f"spec.md is empty or too short for {repo}/{issue_id}"
                )
            _wi.patch_issue_state(repo, issue_id, {
                "phase": "spec", "startedAt": _now_iso(),
            })

            # ── Phase: spec → planned ─────────────────────────────────────
            plan = _wi.read_plan(repo, issue_id)
            if not plan or len(plan.strip()) < 20:
                plan = _generate_plan_from_spec(spec)
                _wi.write_plan(repo, issue_id, plan)

            _wi.patch_issue_state(repo, issue_id, {"phase": "planned"})

            # ── Phase: planned → executing ────────────────────────────────
            steps = _extract_steps(plan)
            total = len(steps)
            _wi.patch_issue_state(repo, issue_id, {
                "phase": "executing",
                "stepCount": total,
                "stepCurrent": 0,
            })

            # Register in workspace_state as active mission
            _ws.add_active_mission(repo, issue_id, {
                "type": "task_orchestrator",
                "stepCount": total,
            })

            for i, step in enumerate(steps):
                # Check for cancellation mid-flight
                current = _wi.load_issue_state(repo, issue_id)
                if current and current.get("phase") == "cancelled":
                    with _registry_lock:
                        _registry[task_key] = {
                            "phase": "cancelled",
                            "updatedAt": _now_iso(),
                        }
                    return current

                # Update progress
                _wi.patch_issue_state(repo, issue_id, {"stepCurrent": i + 1})

                # Execute step
                step_meta = {
                    "stepIndex": i,
                    "totalSteps": total,
                    "step": step,
                }
                try:
                    if _step_executor is not None:
                        run_id = _step_executor(repo, issue_id, step, step_meta)
                    else:
                        run_id = f"sim-{uuid.uuid4().hex[:8]}"

                    # Register run
                    _wi.register_run(repo, issue_id, run_id)

                    # Save step artifact
                    artifact_name = f"step_{i:03d}_{_step_slug(step)}.json"
                    _wi.add_artifact(
                        repo, issue_id, artifact_name,
                        content=json.dumps({
                            "stepIndex": i,
                            "step": step,
                            "runId": run_id,
                            "completedAt": _now_iso(),
                        }, ensure_ascii=False, indent=2),
                    )

                    # Save run state snapshot
                    _rs.save(run_id, {
                        "unitId": "DAVI",
                        "repo": repo,
                        "issueId": issue_id,
                        "commandType": "task_step",
                        "phase": "completed",
                        "status": "completed",
                        "step": step,
                        "stepIndex": i,
                        "stepCount": total,
                        "startedAt": _now_iso(),
                        "finishedAt": _now_iso(),
                    })

                except Exception as step_err:
                    tb = traceback.format_exc()
                    _wi.add_artifact(
                        repo, issue_id,
                        f"step_{i:03d}_error.txt",
                        content=f"Error: {step_err}\n\nStep: {step}\n\n{tb}",
                    )
                    raise  # re-raise to trigger failed phase

            # ── Phase: executing → complete ────────────────────────────────
            _wi.patch_issue_state(repo, issue_id, {
                "phase": "complete",
                "finishedAt": _now_iso(),
            })

            # Clean workspace_state
            _ws.remove_active_mission(repo, issue_id)

            result = _wi.load_issue_state(repo, issue_id)
            with _registry_lock:
                _registry[task_key] = {
                    "phase": "complete",
                    "startedAt": result.get("startedAt", "") if result else "",
                    "updatedAt": _now_iso(),
                }
            return result or {}

        except Exception as e:
            tb = traceback.format_exc()
            # Phase → failed
            _wi.patch_issue_state(repo, issue_id, {
                "phase": "failed",
                "lastError": str(e),
                "finishedAt": _now_iso(),
            })
            # Save traceback artifact
            _wi.add_artifact(
                repo, issue_id,
                "error_traceback.txt",
                content=f"Task failed: {e}\n\n{tb}",
            )
            # Clean workspace_state
            try:
                _ws.remove_active_mission(repo, issue_id)
            except Exception:
                pass
            # Update registry
            with _registry_lock:
                _registry[task_key] = {
                    "phase": "failed",
                    "lastError": str(e),
                    "updatedAt": _now_iso(),
                }
            raise


def run_task_async(repo: str, issue_id: str) -> str:
    """Run the full task cycle in a background thread.

    Returns the task_key for status queries.
    Does NOT block.
    """
    task_key = _task_key(repo, issue_id)

    # Mark as queued before spawning
    with _registry_lock:
        _registry[task_key] = {"phase": "queued", "startedAt": _now_iso()}

    def _runner() -> None:
        try:
            run_task(repo, issue_id)
        except Exception:
            # Error already handled inside run_task; just ensure registry updated
            pass

    t = threading.Thread(target=_runner, daemon=True, name=f"task-{task_key}")
    t.start()
    return task_key


def get_task_status(repo: str, issue_id: str) -> dict[str, Any]:
    """Return current status of a task.

    Returns dict with: repo, issueId, phase, progress, lastError, updatedAt.
    """
    task_key = _task_key(repo, issue_id)
    state = _wi.load_issue_state(repo, issue_id)

    # Build progress info
    phase = "unknown"
    progress: dict[str, int] | None = None
    last_error: str | None = None

    if state:
        phase = state.get("phase", "unknown")
        step_count = state.get("stepCount")
        step_current = state.get("stepCurrent")
        if step_count is not None:
            progress = {
                "current": step_current or 0,
                "total": step_count,
            }
        last_error = state.get("lastError")

    # Merge with async registry if more recent
    with _registry_lock:
        reg = _registry.get(task_key, {})

    return {
        "repo": repo,
        "issueId": issue_id,
        "phase": reg.get("phase", phase),
        "progress": progress,
        "lastError": reg.get("lastError", last_error),
        "updatedAt": state.get("updatedAt", "") if state else "",
        "startedAt": reg.get("startedAt", state.get("startedAt", "") if state else ""),
    }


def cancel_task(repo: str, issue_id: str) -> bool:
    """Cancel a running or queued task.

    Sets phase to 'cancelled' in both the issue state and registry.
    Returns True if the task was found and cancellable.
    """
    task_key = _task_key(repo, issue_id)
    state = _wi.load_issue_state(repo, issue_id)

    if state is None:
        return False

    current_phase = state.get("phase", "")
    if current_phase in ("complete", "failed", "cancelled"):
        return False  # already terminal

    # Mark cancelled
    _wi.patch_issue_state(repo, issue_id, {
        "phase": "cancelled",
        "finishedAt": _now_iso(),
    })

    with _registry_lock:
        _registry[task_key] = {
            "phase": "cancelled",
            "updatedAt": _now_iso(),
        }

    # Clean workspace_state
    try:
        _ws.remove_active_mission(repo, issue_id)
    except Exception:
        pass

    return True


def _reset() -> None:
    """Test helper: drop registry and executor."""
    global _step_executor
    _step_executor = None
    with _registry_lock:
        _registry.clear()
