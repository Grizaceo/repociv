"""RepoCiv — state reconciliation layer.

Cross-references the operational state stores (event_store, sessions,
run_state, workspace_state) to detect inconsistencies, rebuild derived
state from sources of truth, and provide a unified health view.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from . import event_store as _es
from . import sessions as _sessions
from . import run_state as _run_state
from . import workspace_state as _ws
from . import locks as _locks


# ─── Types ────────────────────────────────────────────────────────────────────

@dataclass
class ReconciliationResult:
    workspace_id: str
    unit_id: str = ""
    run_id: str = ""
    ok: bool = True
    issues: list[str] = field(default_factory=list)
    actions_taken: list[str] = field(default_factory=list)
    rebuilt: bool = False


# ─── Low-level consistency checks ─────────────────────────────────────────────


def check_run_consistency(run_id: str) -> ReconciliationResult:
    """Check that a run_state exists and has a corresponding canonical session."""
    result = ReconciliationResult(workspace_id="", run_id=run_id)
    state = _run_state.load(run_id)
    if state is None:
        result.ok = False
        result.issues.append(f"run_state for '{run_id}' is missing")
        return result

    unit_id = state.get("unitId", "")
    if not unit_id:
        result.ok = False
        result.issues.append(f"run_state for '{run_id}' has no unitId")
        return result

    result.unit_id = unit_id
    session = _sessions.get_or_create(unit_id)
    result.workspace_id = session.get("workingDirectory", "")

    if session.get("lastMissionId") != run_id:
        result.issues.append(
            f"session '{unit_id}' lastMissionId='{session.get('lastMissionId')}' "
            f"differs from run_id='{run_id}'"
        )

    return result


def check_session_consistency(unit_id: str) -> ReconciliationResult:
    """Check session integrity: canonical vs transcript."""
    result = ReconciliationResult(workspace_id="", unit_id=unit_id)
    session = _sessions.get_or_create(unit_id)

    result.workspace_id = session.get("workingDirectory", "")

    recent = _sessions.get_recent(unit_id, limit=1)
    msg_count = session.get("messageCount", 0)

    if msg_count > 0 and not recent:
        result.ok = False
        result.issues.append(
            f"session '{unit_id}' has messageCount={msg_count} but transcript is empty"
        )

    if msg_count == 0 and recent:
        result.ok = False
        result.issues.append(
            f"session '{unit_id}' has messageCount=0 but transcript has entries"
        )

    return result


def check_workspace_consistency(workspace_id: str) -> ReconciliationResult:
    """Check that workspace state matches active missions and sessions."""
    result = ReconciliationResult(workspace_id=workspace_id)
    ws_state = _ws.load(workspace_id)

    if ws_state is None:
        result.ok = False
        result.issues.append(f"workspace_state for '{workspace_id}' is missing")
        return result

    active = ws_state.get("activeMissions", [])
    for mission_id in active:
        run = _run_state.load(mission_id)
        if run is None:
            result.ok = False
            result.issues.append(
                f"workspace '{workspace_id}' has active mission '{mission_id}' "
                f"but its run_state is missing"
            )
        else:
            status = run.get("status", "")
            if status in ("completed", "failed", "cancelled"):
                result.ok = False
                result.issues.append(
                    f"workspace '{workspace_id}' active mission '{mission_id}' "
                    f"has terminal status '{status}' — should be in history"
                )

    return result


# ─── Rebuild operations ───────────────────────────────────────────────────────


def rebuild_run_state(run_id: str) -> ReconciliationResult:
    """Rebuild a run_state from the event_store and session data.

    Scans the events.jsonl for events matching this run_id and reconstructs
    a best-effort run state summary.
    """
    result = ReconciliationResult(workspace_id="", run_id=run_id)
    existing = _run_state.load(run_id)
    if existing is not None:
        result.issues.append(f"run_state for '{run_id}' already exists, skipping rebuild")
        return result

    # Find events for this run
    events = _es.read_events(since=0.0, limit=2000)
    run_events = [e for e in events if e.get("commandId") == run_id]

    if not run_events:
        result.ok = False
        result.issues.append(f"no events found for run '{run_id}' — cannot rebuild")
        return result

    # Extract what we can from events
    first_event = run_events[0]
    unit_id = first_event.get("data", {}).get("unitId", "")
    result.unit_id = unit_id

    created_at = first_event.get("timestamp", time.time())
    started_at = created_at
    finished_at = None
    status = "unknown"
    error_msg = ""
    output_chunks: list[str] = []
    harness_id = ""

    for evt in run_events:
        etype = evt.get("type", "")
        data = evt.get("data", {})
        if etype == "CommandCreated":
            harness_id = data.get("harness_id", data.get("harnessId", ""))
            unit_id = data.get("unitId", unit_id)
        elif etype == "CommandStarted":
            started_at = evt.get("timestamp", started_at)
            status = "running"
        elif etype == "AgentOutputChunk":
            text = data.get("text", "")
            if text:
                output_chunks.append(text)
        elif etype == "CommandCompleted":
            finished_at = evt.get("timestamp")
            status = "completed"
        elif etype == "CommandFailed":
            finished_at = evt.get("timestamp")
            status = "failed"
            error_msg = data.get("error", "")
        elif etype == "CommandRejected":
            finished_at = evt.get("timestamp")
            status = "rejected"

    if status == "unknown":
        # Best guess from last event
        last_type = run_events[-1].get("type", "")
        if last_type == "CommandQueued":
            status = "queued"

    # Build the state dict
    state = {
        "missionId": run_id,
        "unitId": unit_id,
        "harnessId": harness_id,
        "status": status,
        "createdAt": _format_ts(created_at),
        "startedAt": _format_ts(started_at),
        "finishedAt": _format_ts(finished_at) if finished_at else "",
        "error": error_msg[:500],
        "outputChunks": len(output_chunks),
        "outputPreview": "".join(output_chunks[-3:])[:500],
    }

    _run_state.save(run_id, state)
    result.rebuilt = True
    result.actions_taken.append(f"rebuilt run_state for '{run_id}' from {len(run_events)} events")
    return result


def rebuild_workspace_state(workspace_id: str) -> ReconciliationResult:
    """Rebuild workspace state from sessions and run_state data.

    Scans all sessions whose workingDirectory matches workspace_id and
    reconstructs the workspace state.
    """
    result = ReconciliationResult(workspace_id=workspace_id)
    existing = _ws.load(workspace_id)
    if existing is not None:
        result.issues.append(
            f"workspace_state for '{workspace_id}' already exists, skipping rebuild"
        )
        return result

    ws_state = _ws.get_or_create(workspace_id)

    # Find all sessions that belong to this workspace
    # We iterate through workspace_state directories to find sessions
    # This is best-effort since sessions don't have a direct workspace_id index
    missions_found: list[str] = []
    total_messages = 0
    total_input = 0
    total_output = 0

    # Scan session directories
    try:
        from pathlib import Path
        sessions_dir = _sessions._base_dir
        if sessions_dir and sessions_dir.exists():
            for unit_dir in sessions_dir.iterdir():
                if not unit_dir.is_dir():
                    continue
                canonical = unit_dir / "canonical.json"
                if not canonical.exists():
                    continue
                import json
                try:
                    data = json.loads(canonical.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if data.get("workingDirectory") == workspace_id:
                    missions_found.append(data.get("unitId", unit_dir.name))
                    total_messages += data.get("messageCount", 0)
                    total_input += data.get("inputChars", 0)
                    total_output += data.get("outputChars", 0)
    except Exception:
        pass

    # Update workspace state
    for m in missions_found:
        _ws.add_active_mission(workspace_id, m)

    _ws.update_resource_usage(
        workspace_id,
        messages=total_messages,
        input_chars=total_input,
        output_chars=total_output,
    )

    result.rebuilt = True
    result.actions_taken.append(
        f"rebuilt workspace_state for '{workspace_id}' — "
        f"found {len(missions_found)} sessions"
    )
    return result


# ─── Cross-layer queries ──────────────────────────────────────────────────────


def get_full_status(workspace_id: str, unit_id: str = "", run_id: str = "") -> dict[str, Any]:
    """Return a unified status view across all state layers.

    Provide at least one identifier (workspace_id, unit_id, or run_id) and
    this will cross-reference everything it can find.
    """
    result: dict[str, Any] = {
        "workspace": None,
        "session": None,
        "run": None,
        "events": [],
        "issues": [],
        "queriedAt": _format_ts(time.time()),
    }

    resolved_workspace = workspace_id
    resolved_unit = unit_id
    resolved_run = run_id

    # Resolve from run_id outward
    if resolved_run:
        run = _run_state.load(resolved_run)
        if run:
            result["run"] = run
            resolved_unit = run.get("unitId", resolved_unit)

    # If we have a workspace but no unit/run, try to resolve from active missions
    if resolved_workspace and not resolved_unit and not resolved_run:
        active = _ws.get_active_missions(resolved_workspace)
        if active:
            resolved_run = active[0]  # Pick the first active mission
            run = _run_state.load(resolved_run)
            if run:
                result["run"] = run
                resolved_unit = run.get("unitId", "")

    # Resolve from session/unit
    if resolved_unit:
        session = _sessions.get_or_create(resolved_unit)
        result["session"] = session
        resolved_workspace = session.get("workingDirectory", resolved_workspace)

    # Load workspace
    if resolved_workspace:
        ws = _ws.load(resolved_workspace)
        if ws:
            result["workspace"] = ws

    # Cross-check consistency
    check = check_workspace_consistency(resolved_workspace)
    result["issues"].extend(check.issues)

    if resolved_unit:
        check = check_session_consistency(resolved_unit)
        result["issues"].extend(check.issues)

    if resolved_run:
        check = check_run_consistency(resolved_run)
        result["issues"].extend(check.issues)

    # Recent events if we have a run_id
    if resolved_run:
        events = _es.read_events(since=0.0, limit=100)
        result["events"] = [e for e in events if e.get("commandId") == resolved_run][-20:]

    return result


def find_orphaned_runs() -> list[str]:
    """Find run_state entries that have no matching active workspace mission."""
    orphans: list[str] = []
    try:
        from pathlib import Path
        rs_dir = _run_state._base_dir
        if rs_dir and rs_dir.exists():
            for f in rs_dir.glob("*.json"):
                run_id = f.stem
                state = _run_state.load(run_id)
                if state is None:
                    continue
                unit_id = state.get("unitId", "")
                if unit_id:
                    session = _sessions.get_or_create(unit_id)
                    workspace_id = session.get("workingDirectory", "")
                    ws = _ws.load(workspace_id)
                    if ws:
                        active = ws.get("activeMissions", [])
                        history = ws.get("runHistory", [])
                        history_ids = [h.get("missionId") for h in history]
                        if run_id not in active and run_id not in history_ids:
                            orphans.append(run_id)
                    else:
                        orphans.append(run_id)
                else:
                    orphans.append(run_id)
    except Exception:
        pass
    return orphans


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _format_ts(ts: float | None) -> str:
    if ts is None:
        return ""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


# ─── Bulk reconciliation ──────────────────────────────────────────────────────


def full_reconcile(workspace_id: str) -> ReconciliationResult:
    """Run a full reconciliation pass for a workspace.

    Checks all layers, rebuilds what can be rebuilt, and reports issues.
    """
    result = ReconciliationResult(workspace_id=workspace_id)

    # 1. Check workspace
    ws_check = check_workspace_consistency(workspace_id)
    result.issues.extend(ws_check.issues)
    if not ws_check.ok:
        # Try to rebuild
        ws_rebuild = rebuild_workspace_state(workspace_id)
        result.actions_taken.extend(ws_rebuild.actions_taken)
        result.issues.extend(ws_rebuild.issues)

    # 2. Check active missions
    ws_state = _ws.load(workspace_id)
    if ws_state:
        for mission_id in ws_state.get("activeMissions", []):
            run_check = check_run_consistency(mission_id)
            result.issues.extend(run_check.issues)
            if not run_check.ok:
                run_rebuild = rebuild_run_state(mission_id)
                result.actions_taken.extend(run_rebuild.actions_taken)
                result.issues.extend(run_rebuild.issues)

            if run_check.unit_id:
                sess_check = check_session_consistency(run_check.unit_id)
                result.issues.extend(sess_check.issues)

    # 3. Find orphans
    orphans = find_orphaned_runs()
    for o in orphans:
        result.issues.append(f"orphaned run_state '{o}' — not tracked by any workspace")

    result.ok = len([i for i in result.issues if "ERROR" in i.upper() or "missing" in i.lower()]) == 0
    return result
