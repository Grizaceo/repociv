"""RepoCiv — P3: Task Orchestrator (mission runner).

Full cycle per issue: spec → plan → dispatch → collect → close.
Connects workspace_issue (P2), workspace_state (P1), and run_state (P0).

Phase machine:
  init → spec → planned → executing → validating → complete
                                              ↓
                                         failed_by_validation
                                         blocked (needs-human-review)

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
from . import repo_config as _rc
from . import metrics as _metrics
from . import checkpoint as _checkpoint
from . import repociv_hooks as _rh
from . import swarm_engine as _swarm


# ─── Circuit breaker ──────────────────────────────────────────────────────────
MAX_CONSECUTIVE_FAILURES = 3


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


# ─── Swarm helpers (Fase 3) ───────────────────────────────────────────────────

_HIGH_PRIORITY_VALUES = {"high", "critical", "urgent", "p0", "p1", "blocker"}
_CRITICAL_SURFACE_MARKERS = (
    "server/",
    "orchestrator",
    "security",
    "ledger",
    "router",
    "runtime",
    "core",
)


def _infer_agent_for_step(step: str, step_meta: dict[str, Any]) -> str:
    """Infer the executor role without depending on a real dispatch call."""
    if step_meta.get("agent"):
        return str(step_meta["agent"]).upper()
    try:
        from .step_executor import select_agent_for_step
        return select_agent_for_step(step).upper()
    except Exception:
        lowered = step.lower()
        if any(k in lowered for k in ("implement", "create", "fix", "add", "wire")):
            return "WORKER"
        if any(k in lowered for k in ("inspect", "review", "audit", "analyze")):
            return "SCOUT"
        return "DAVI"


def _priority_is_high(state: dict[str, Any], step_meta: dict[str, Any]) -> bool:
    raw = (
        step_meta.get("priority")
        or state.get("priority")
        or state.get("priorityLevel")
        or state.get("severity")
        or ""
    )
    if isinstance(raw, (int, float)):
        return float(raw) >= 8.0
    return str(raw).strip().lower() in _HIGH_PRIORITY_VALUES


def _should_run_swarm(
    *,
    state: dict[str, Any],
    step: str,
    step_meta: dict[str, Any],
    consecutive_failures: int,
) -> bool:
    """Decide whether a post-WORKER debate is worth the added latency."""
    explicit = step_meta.get("swarm", state.get("swarm"))
    if explicit is False:
        return False
    agent = _infer_agent_for_step(step, step_meta)
    if agent != "WORKER":
        return False
    if explicit is True:
        return True
    lowered = step.lower()
    return (
        _priority_is_high(state, step_meta)
        or consecutive_failures > 0
        or any(marker in lowered for marker in _CRITICAL_SURFACE_MARKERS)
    )


def _record_swarm_debate(
    *,
    repo: str,
    issue_id: str,
    step_idx: int,
    step: str,
    run_id: str,
    mission_text: str,
    agent_output: str,
) -> None:
    """Run swarm debate and persist it as JSON plus a context artifact."""
    result = _swarm.get_engine().debate(
        mission_id=f"{run_id}:swarm",
        mission_text=mission_text,
        step=step,
        agent_output=agent_output,
        metadata={"repo": repo, "issue_id": issue_id, "step_index": step_idx},
    )
    _wi.add_artifact(
        repo,
        issue_id,
        f"swarm_debate_{step_idx:03d}.json",
        content=result.model_dump_json(indent=2),
    )
    _wi.write_step_artifact(
        repo,
        issue_id,
        step_idx,
        "swarm",
        result.context_directive_text,
    )


# ─── Public API ───────────────────────────────────────────────────────────────


def run_task(repo: str, issue_id: str) -> dict[str, Any]:
    """Execute the full task cycle synchronously.

    Phases: init → spec → planned → executing → validating → complete
    On validation fail: phase → failed_by_validation.
    On validation needs-human-review: phase → blocked (checkpointGate: post-validation).
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
            # Ensure git worktree for new issues if enabled (H5 — best-effort)
            _wi.ensure_worktree(repo, issue_id)

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

        # ── Checkpoint gate resume (H4) ──────────────────────────────────
        # When the orchestrator writes a checkpoint sentinel and returns
        # early (phase="blocked", checkpointGate set), subsequent calls
        # check whether the human cleared the sentinel and resume from
        # after the gated phase.
        checkpoint_gate = state.get("checkpointGate")
        _skip_to_plan = False       # resume after post-diagnose gate cleared
        _skip_to_dispatch = False   # resume after post-plan gate cleared
        _skip_to_close = False      # resume after post-fix gate cleared

        if phase == "blocked" and checkpoint_gate:
            _gate_sentinel = _wi.read_sentinel(repo, issue_id)
            if _gate_sentinel in ("blocked", "needs-human-review"):
                # Human hasn't reviewed yet — remain blocked
                with _registry_lock:
                    _registry[task_key] = {
                        "phase": "blocked",
                        "updatedAt": _now_iso(),
                    }
                return state
            # Human cleared the sentinel → resume execution
            _wi.clear_sentinel(repo, issue_id)
            _wi.patch_issue_state(repo, issue_id, {
                "phase": "executing",
                "checkpointGate": None,
            })
            state = _wi.load_issue_state(repo, issue_id) or {}
            phase = "executing"
            if checkpoint_gate == "post-diagnose":
                _skip_to_plan = True
            elif checkpoint_gate == "post-plan":
                _skip_to_dispatch = True
            elif checkpoint_gate == "post-fix":
                _skip_to_close = True

        # ── A2O sentinel check (H1) ──────────────────────────────────────
        # Stop immediately if a blocking sentinel is present (set by the
        # executing agent or by a previous call to the orchestrator).
        if not checkpoint_gate:
            _a2o = _wi.read_sentinel(repo, issue_id)
            if _a2o in ("blocked", "needs-human-review"):
                _wi.patch_issue_state(repo, issue_id, {"phase": "blocked"})
                with _registry_lock:
                    _registry[task_key] = {
                        "phase": "blocked",
                        "updatedAt": _now_iso(),
                    }
                return _wi.load_issue_state(repo, issue_id) or {}

        # Register as in-flight
        with _registry_lock:
            _registry[task_key] = {
                "phase": "executing",
                "startedAt": _now_iso(),
            }

        try:
            # ── Phase: init/any → spec ────────────────────────────────────
            spec = _wi.read_spec(repo, issue_id)
            if not _skip_to_plan and not _skip_to_dispatch and not _skip_to_close:
                # Validate spec content (strip headings to detect empty body)
                import re as _re
                if spec is None:
                    raise ValueError(f"spec.md not found for {repo}/{issue_id}")
                _body = _re.sub(r'^#.*$', '', spec, flags=_re.MULTILINE).strip()
                if not _body or len(_body.strip()) < 10:
                    raise ValueError(
                        f"spec.md is empty or too short for {repo}/{issue_id}"
                    )
                _wi.patch_issue_state(repo, issue_id, {
                    "phase": "spec", "startedAt": _now_iso(),
                })

                # H4: Post-diagnose checkpoint — pause for human review
                if _rh.checkpoints_enabled(repo):
                    _wi.write_sentinel(repo, issue_id, "needs-human-review")
                    _wi.patch_issue_state(repo, issue_id, {
                        "phase": "blocked",
                        "checkpointGate": "post-diagnose",
                    })
                    with _registry_lock:
                        _registry[task_key] = {
                            "phase": "blocked",
                            "updatedAt": _now_iso(),
                        }
                    return _wi.load_issue_state(repo, issue_id) or {}

            # ── Phase: spec → planned ─────────────────────────────────────
            plan = _wi.read_plan(repo, issue_id)
            if not _skip_to_dispatch and not _skip_to_close:
                if not plan or len(plan.strip()) < 20:
                    plan = _generate_plan_from_spec(spec or "")
                    _wi.write_plan(repo, issue_id, plan)

                _wi.patch_issue_state(repo, issue_id, {"phase": "planned"})

                # H4: Post-plan checkpoint — pause for human review
                if _rh.checkpoints_enabled(repo):
                    _wi.write_sentinel(repo, issue_id, "needs-human-review")
                    _wi.patch_issue_state(repo, issue_id, {
                        "phase": "blocked",
                        "checkpointGate": "post-plan",
                    })
                    with _registry_lock:
                        _registry[task_key] = {
                            "phase": "blocked",
                            "updatedAt": _now_iso(),
                        }
                    return _wi.load_issue_state(repo, issue_id) or {}

            # ── Phase: planned → executing ────────────────────────────────
            # Validation Contract gate: ensure a contract exists before executing
            if not _skip_to_close:
                if not _wi.has_validation_contract(repo, issue_id):
                    # Auto-generate from spec; if no spec, create minimal contract
                    _wi.generate_contract_from_spec(repo, issue_id)
                contract = _wi.read_validation_contract(repo, issue_id)
                _wi.patch_issue_state(repo, issue_id, {
                    "validationContractPresent": True,
                    "validationContractAutoGenerated": contract.get("autoGenerated", False) if contract else True,
                    "validationVerdict": None,
                })

            steps = _extract_steps(plan or "")
            total = len(steps)
            if not _skip_to_close:
                _wi.patch_issue_state(repo, issue_id, {
                    "phase": "executing",
                    "stepCount": total,
                    "stepCurrent": 0,
                })

            # Register in workspace_state as active mission
            if not _skip_to_close:
                _ws.add_active_mission(repo, issue_id, {
                    "type": "task_orchestrator",
                    "stepCount": total,
                })

            # ── Resume from checkpoint if available ───────────────────────
            _ckpt = _checkpoint.load_checkpoint(repo, issue_id)
            # When resuming after post-fix gate, all steps are already done.
            _resume_from = total if _skip_to_close else (
                (_ckpt.get("stepIndex", -1) + 1) if _ckpt else 0
            )

            consecutive_failures = 0

            for i, step in enumerate(steps):
                # Skip steps already completed before the checkpoint
                if i < _resume_from:
                    continue
                # A2O sentinel check — stop if agent or human has blocked (H1)
                _step_sentinel = _wi.read_sentinel(repo, issue_id)
                if _step_sentinel in ("blocked", "needs-human-review"):
                    _wi.patch_issue_state(repo, issue_id, {
                        "phase": "blocked",
                        "blockedAtStep": i,
                        "blockedAt": _now_iso(),
                    })
                    with _registry_lock:
                        _registry[task_key] = {
                            "phase": "blocked",
                            "blockedAtStep": i,
                            "updatedAt": _now_iso(),
                        }
                    return _wi.load_issue_state(repo, issue_id) or {}
                # Check for cancellation mid-flight
                current = _wi.load_issue_state(repo, issue_id)
                if current and current.get("phase") == "cancelled":
                    _checkpoint.delete_checkpoint(repo, issue_id)
                    with _registry_lock:
                        _registry[task_key] = {
                            "phase": "cancelled",
                            "updatedAt": _now_iso(),
                        }
                    return current

                # Update progress
                _wi.patch_issue_state(repo, issue_id, {"stepCurrent": i + 1})

                # Run pre_step hook if configured (warn-only, never aborts step)
                try:
                    _pre_result = _rc.run_hook(repo, "pre_step")
                    if _pre_result is not None and _pre_result.get("returncode", 0) != 0:
                        _wi.add_artifact(
                            repo, issue_id,
                            f"step_{i:03d}_prehook_warn.txt",
                            content=(
                                f"pre_step hook returned {_pre_result['returncode']}\n\n"
                                f"stdout:\n{_pre_result.get('stdout', '')}\n\n"
                                f"stderr:\n{_pre_result.get('stderr', '')}"
                            ),
                        )
                    if _pre_result is not None:
                        try:
                            _metrics.record_hook_result(
                                "pre_step", repo,
                                _pre_result.get("returncode", 0),
                                0.0,
                            )
                        except Exception:
                            pass
                except Exception:
                    pass  # Hook errors never abort the orchestration

                # Execute step
                step_meta = {
                    "stepIndex": i,
                    "totalSteps": total,
                    "step": step,
                }
                _step_start = time.time()
                try:
                    if _step_executor is not None:
                        run_id = _step_executor(repo, issue_id, step, step_meta)
                    else:
                        run_id = f"sim-{uuid.uuid4().hex[:8]}"

                    # Register run
                    _wi.register_run(repo, issue_id, run_id)

                    # Save step artifact — include agent output if available
                    run_result = _rs.load(run_id)
                    agent_output = ""
                    if run_result:
                        agent_output = str(
                            run_result.get("result") or run_result.get("error") or ""
                        )
                    artifact_name = f"step_{i:03d}_{_step_slug(step)}.json"
                    _wi.add_artifact(
                        repo, issue_id, artifact_name,
                        content=json.dumps({
                            "stepIndex": i,
                            "step": step,
                            "runId": run_id,
                            "agentOutput": agent_output,
                            "completedAt": _now_iso(),
                        }, ensure_ascii=False, indent=2),
                    )

                    # Fase 3: run an optional post-WORKER swarm debate only for
                    # high-risk/high-priority steps. Default path stays unchanged.
                    _swarm_state = _wi.load_issue_state(repo, issue_id) or state
                    if _should_run_swarm(
                        state=_swarm_state,
                        step=step,
                        step_meta=step_meta,
                        consecutive_failures=consecutive_failures,
                    ):
                        _record_swarm_debate(
                            repo=repo,
                            issue_id=issue_id,
                            step_idx=i,
                            step=step,
                            run_id=run_id,
                            mission_text=f"{spec or ''}\n\n{step}",
                            agent_output=agent_output,
                        )

                    # Also write human-readable step artifact for context seeding
                    if agent_output:
                        _wi.write_step_artifact(
                            repo, issue_id, i,
                            step_meta.get("agent", "agent"),
                            agent_output,
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

                    # Step succeeded — reset circuit breaker counter
                    consecutive_failures = 0

                    # Save checkpoint so we can resume from next step on restart
                    _checkpoint.save_checkpoint(repo, issue_id, {
                        "stepIndex": i,
                        "stepCount": total,
                        "repo": repo,
                        "issueId": issue_id,
                        "savedAt": _now_iso(),
                    })

                    # Record step latency
                    _step_agent = str(step_meta.get("agent", "DAVI"))
                    try:
                        _metrics.record_step_latency(
                            repo, issue_id, i, _step_agent,
                            time.time() - _step_start,
                        )
                    except Exception:
                        pass

                    # Run post_step hook if configured
                    try:
                        _post_result = _rc.run_hook(repo, "post_step")
                        if _post_result is not None:
                            try:
                                _metrics.record_hook_result(
                                    "post_step", repo,
                                    _post_result.get("returncode", 0),
                                    0.0,
                                )
                            except Exception:
                                pass
                    except Exception:
                        pass  # Hook errors never abort the orchestration

                except Exception as step_err:
                    # Record latency even on failure
                    _step_agent = str(step_meta.get("agent", "DAVI"))
                    try:
                        _metrics.record_step_latency(
                            repo, issue_id, i, _step_agent,
                            time.time() - _step_start,
                        )
                    except Exception:
                        pass
                    tb = traceback.format_exc()
                    _wi.add_artifact(
                        repo, issue_id,
                        f"step_{i:03d}_error.txt",
                        content=f"Error: {step_err}\n\nStep: {step}\n\n{tb}",
                    )
                    consecutive_failures += 1
                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                        # ── Circuit breaker tripped ───────────────────────
                        _wi.patch_issue_state(repo, issue_id, {
                            "phase": "circuit_open",
                            "circuitBreaker": {
                                "trippedAt": _now_iso(),
                                "consecutiveFailures": consecutive_failures,
                                "lastStep": step,
                                "lastError": str(step_err),
                            },
                            "finishedAt": _now_iso(),
                        })
                        try:
                            _ws.remove_active_mission(repo, issue_id)
                        except Exception:
                            pass
                        with _registry_lock:
                            _registry[task_key] = {
                                "phase": "circuit_open",
                                "consecutiveFailures": consecutive_failures,
                                "updatedAt": _now_iso(),
                            }
                        # Run on_circuit_open hook if configured
                        try:
                            _circ_result = _rc.run_hook(repo, "on_circuit_open")
                            if _circ_result is not None:
                                try:
                                    _metrics.record_hook_result(
                                        "on_circuit_open", repo,
                                        _circ_result.get("returncode", 0),
                                        0.0,
                                    )
                                except Exception:
                                    pass
                        except Exception:
                            pass  # Hook errors never abort the orchestration
                        return _wi.load_issue_state(repo, issue_id) or {}
                    # Below threshold — log and continue to next step

            # H4: Post-fix checkpoint — pause after all steps for human review
            if not _skip_to_close and _rh.checkpoints_enabled(repo):
                _wi.write_sentinel(repo, issue_id, "needs-human-review")
                _wi.patch_issue_state(repo, issue_id, {
                    "phase": "blocked",
                    "checkpointGate": "post-fix",
                })
                with _registry_lock:
                    _registry[task_key] = {
                        "phase": "blocked",
                        "updatedAt": _now_iso(),
                    }
                return _wi.load_issue_state(repo, issue_id) or {}

            # ── Phase: executing → validating ──────────────────────────────
            # Validation gate: run validator before marking complete
            validation_verdict = None
            validation_summary = ""
            try:
                from . import validator as _validator
                val_result = _validator.validate_issue(repo, issue_id)
                validation_verdict = val_result.get("verdict", "needs-human-review")
                validation_summary = val_result.get("summary", "")
            except ImportError:
                # Validator module not yet available — skip gracefully
                validation_verdict = "pass"
                validation_summary = "validator module not installed, auto-pass"
            except Exception as e:
                validation_verdict = "needs-human-review"
                validation_summary = f"validator error: {e}"

            _wi.patch_issue_state(repo, issue_id, {
                "validationVerdict": validation_verdict,
                "validationSummary": validation_summary,
            })

            # If validation fails or needs human review, block completion
            if validation_verdict == "fail":
                _wi.patch_issue_state(repo, issue_id, {
                    "phase": "failed_by_validation",
                    "finishedAt": _now_iso(),
                })
                _wi.write_sentinel(repo, issue_id, "blocked")
                _ws.remove_active_mission(repo, issue_id)
                with _registry_lock:
                    _registry[task_key] = {
                        "phase": "failed_by_validation",
                        "validationVerdict": validation_verdict,
                        "updatedAt": _now_iso(),
                    }
                return _wi.load_issue_state(repo, issue_id) or {}

            if validation_verdict == "needs-human-review":
                _wi.patch_issue_state(repo, issue_id, {
                    "phase": "blocked",
                    "checkpointGate": "post-validation",
                })
                _wi.write_sentinel(repo, issue_id, "needs-human-review")
                with _registry_lock:
                    _registry[task_key] = {
                        "phase": "blocked",
                        "checkpointGate": "post-validation",
                        "updatedAt": _now_iso(),
                    }
                return _wi.load_issue_state(repo, issue_id) or {}

            # ── Phase: validating → complete ───────────────────────────────
            _wi.patch_issue_state(repo, issue_id, {
                "phase": "complete",
                "finishedAt": _now_iso(),
            })

            # Delete checkpoint — task finished cleanly
            _checkpoint.delete_checkpoint(repo, issue_id)

            # Release git worktree on successful completion (H5) — best-effort
            _wi.release_worktree(repo, issue_id)

            # Write "done" sentinel — signals completion to monitoring tools
            _wi.write_sentinel(repo, issue_id, "done")

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
            # Release git worktree on failure (H5) — best-effort
            _wi.release_worktree(repo, issue_id)
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


def get_circuit_status(repo: str, issue_id: str) -> dict[str, Any]:
    """Return circuit breaker status for a task.

    Returns a dict with: repo, issueId, open (bool), info (dict | None).
    ``open`` is True only when phase == 'circuit_open'.
    """
    state = _wi.load_issue_state(repo, issue_id)
    if state is None:
        return {"repo": repo, "issueId": issue_id, "open": False, "info": None}
    breaker_info = state.get("circuitBreaker")
    return {
        "repo": repo,
        "issueId": issue_id,
        "open": state.get("phase") == "circuit_open",
        "info": breaker_info,
    }


def count_circuit_open() -> int:
    """Return the number of tasks currently in circuit_open phase."""
    with _registry_lock:
        return sum(
            1 for v in _registry.values() if v.get("phase") == "circuit_open"
        )


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


def list_tasks() -> list[dict[str, Any]]:
    """Return a snapshot of all known tasks from the registry.

    Each entry contains: key, phase, stepCurrent, stepCount, startedAt, updatedAt.
    stepCurrent and stepCount are read from the issue_state if available.

    Returns:
        List of task dicts, one per registered task (active or terminal).
    """
    with _registry_lock:
        registry_copy = dict(_registry)

    result: list[dict[str, Any]] = []
    for key, reg in registry_copy.items():
        # Parse repo and issue_id from key ("repo::ISSUE-1")
        parts = key.split("::", 1)
        repo = parts[0] if parts else key
        issue_id = parts[1] if len(parts) > 1 else ""

        # Enrich with step progress from issue_state
        step_current: int | None = None
        step_count: int | None = None
        try:
            state = _wi.load_issue_state(repo, issue_id)
            if state:
                step_current = state.get("stepCurrent")
                step_count = state.get("stepCount")
        except Exception:
            pass

        result.append({
            "key": key,
            "repo": repo,
            "issueId": issue_id,
            "phase": reg.get("phase", "unknown"),
            "stepCurrent": step_current,
            "stepCount": step_count,
            "startedAt": reg.get("startedAt", ""),
            "updatedAt": reg.get("updatedAt", reg.get("startedAt", "")),
        })

    return result


def _reset() -> None:
    """Test helper: drop registry and executor."""
    global _step_executor
    _step_executor = None
    with _registry_lock:
        _registry.clear()