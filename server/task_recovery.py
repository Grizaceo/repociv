"""Read-only startup reconciliation. No automatic resume or approval renewal.

Workspace issues and checkpoints are authoritative task progress. Registry is a
cache. Event bindings correlate stable process identity, never a PID alone.
Unknown outcomes remain interrupted: absence of a process is not proof an
external effect never happened. Recovery deliberately offers no replay action.
"""
from __future__ import annotations

from . import workspace_issue as wi
from . import checkpoint
from . import event_store as es
from . import agent_processes as ap

TERMINAL = {"complete", "failed", "cancelled", "failed_by_validation"}
BLOCKED = {"blocked", "circuit_open"}


def build_recovery_view() -> dict:
    tasks = []
    for item in wi.list_issues():
        repo, issue = item["repo"], item["issueId"]
        state = wi.load_issue_state(repo, issue) or {}
        phase = state.get("phase", "unknown")
        if phase in TERMINAL:
            continue
        ckpt = checkpoint.load_checkpoint(repo, issue)
        tasks.append({"repo": repo, "issueId": issue, "taskKey": f"{repo}::{issue}",
                      "persistedPhase": phase,
                      "recoveryPhase": phase if phase in BLOCKED else "interrupted",
                      "runIds": list(state.get("runIds") or []),
                      "checkpointStepIndex": (ckpt or {}).get("stepIndex"),
                      "stepCount": state.get("stepCount"),
                      "stepCurrent": state.get("stepCurrent"),
                      "checkpointGate": state.get("checkpointGate"),
                      "resumeAvailable": False})
    return {"readOnly": True, "autoResume": False, "tasks": tasks}


def correlate_surviving_work(view: dict | None = None) -> dict:
    view = build_recovery_view() if view is None else view
    bindings = {}
    for event in es.read_events(limit=20000):
        if event.get("type") == "ProcessBound":
            data = event.get("data") or {}
            bindings[es.command_id(event)] = data
    tasks = []
    for entry in view["tasks"]:
        surviving, unknown = [], []
        for run_id in entry["runIds"]:
            data = bindings.get(run_id, {})
            pid, recorded = data.get("pid"), data.get("processIdentity")
            if not isinstance(pid, int) or not recorded:
                unknown.append(run_id)
                continue
            live = ap.process_identity(pid)
            if live == recorded:
                surviving.append({"commandId": run_id, "pid": pid,
                                  "processIdentity": recorded})
            elif live is not None:
                unknown.append(run_id)  # PID reuse; no action offered
        tasks.append({**entry, "survivingProcesses": surviving,
                      "ownedSurvivingWork": bool(surviving),
                      "unresolvedIdentityRunIds": unknown})
    return {**view, "tasks": tasks}


def reconcile_on_startup() -> dict:
    from . import task_orchestrator as to
    view = correlate_surviving_work()
    for task in view["tasks"]:
        to.register_recovered_task(task["repo"], task["issueId"], task["recoveryPhase"],
                                  info={**task, "readOnly": True})
    return view


def resume_interrupted_task(repo: str, issue_id: str, **_kwargs) -> dict:
    # Deliberately no force escape, no unverified retry and no alternate
    # dispatch path. Operator must reconcile side effects before a new command.
    return {"resumed": False, "reason": "manual-reconciliation-required",
            "approvalsTouched": False}
