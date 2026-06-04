"""Track Task-tool subagent delegations and emit bridge events."""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from typing import Any, Callable

from server import event_store as _es
from server import subagent_risk as _risk
from server.mission_harness import MissionHarnessContext, swarm_track_enabled

SendFn = Callable[[dict[str, Any]], None]
ApprovalFn = Callable[[dict[str, Any]], None]

_lock = threading.Lock()
_runs: dict[str, dict[str, Any]] = {}
_tool_use_map: dict[str, str] = {}  # tool_use_id -> subagent_id
_pending_spawn: dict[str, dict[str, Any]] = {}  # command_id -> spawn kwargs
_last_progress_at: dict[str, float] = {}
_send: SendFn = lambda _evt: None
_add_approval: ApprovalFn = lambda _cmd: None

_PROGRESS_THROTTLE_S = 1.0


def configure(*, send: SendFn | None = None, add_approval: ApprovalFn | None = None) -> None:
    global _send, _add_approval
    if send is not None:
        _send = send
    if add_approval is not None:
        _add_approval = add_approval


def map_kind_to_unit_type(kind: str) -> str:
    k = (kind or "").lower()
    if k in ("explore", "cursor-guide", "ci-investigator"):
        return "scout"
    if k in ("shell", "best-of-n-runner"):
        return "worker"
    if k == "generalpurpose":
        return "worker"
    return "scout"


def infer_target_city(label: str, parent_city: str) -> str | None:
    """Heuristic: repo/city name embedded in Task description."""
    if not label:
        return None
    m = re.search(r"/repos/([a-zA-Z0-9_.-]+)", label)
    if m:
        candidate = m.group(1)
        if candidate != parent_city:
            return candidate
    for pat in (r"cityId[=:\s]+['\"]?([a-zA-Z0-9_.-]+)", r"targetRepo[=:\s]+['\"]?([a-zA-Z0-9_.-]+)"):
        m2 = re.search(pat, label, re.I)
        if m2 and m2.group(1) != parent_city:
            return m2.group(1)
    return None


def _new_id() -> str:
    return f"sub-{uuid.uuid4().hex[:8]}"


def _unit_id_for(kind: str, subagent_id: str) -> str:
    prefix = map_kind_to_unit_type(kind).upper()
    return f"{prefix}-{subagent_id}"


def list_active(parent_unit_id: str | None = None) -> list[dict[str, Any]]:
    with _lock:
        runs = list(_runs.values())
    active = [r for r in runs if r.get("status") in ("proposed", "running")]
    if parent_unit_id:
        active = [r for r in active if r.get("parentUnitId") == parent_unit_id]
    return active


def get_run(subagent_id: str) -> dict[str, Any] | None:
    with _lock:
        return dict(_runs[subagent_id]) if subagent_id in _runs else None


def register_spawn(
    *,
    parent_mission_id: str,
    parent_unit: str,
    kind: str,
    label: str,
    parent_city: str = "",
    target_city_id: str | None = None,
    risk: str | None = None,
    hex_coord: list[int] | None = None,
    tool_use_id: str | None = None,
    status: str = "running",
    subagent_id: str | None = None,
    parent_harness: str = "",
    harness: str = "",
) -> dict[str, Any]:
    """Register a subagent run and emit bridge + event-store events."""
    sid = subagent_id or _new_id()
    risk_level = risk or _risk.classify_subagent(kind, label)
    target = target_city_id or infer_target_city(label, parent_city)
    unit_type = map_kind_to_unit_type(kind)
    if target and target != parent_city:
        unit_type = "caravan"
    effective_harness = harness or parent_harness
    ephemeral_id = _unit_id_for(kind, sid)
    now = time.time()
    run: dict[str, Any] = {
        "id": sid,
        "parentMissionId": parent_mission_id,
        "parentUnitId": parent_unit,
        "kind": kind,
        "label": label,
        "status": status,
        "risk": risk_level,
        "targetCityId": target,
        "targetRepo": target,
        "parentCityId": parent_city,
        "ephemeralUnitId": ephemeral_id,
        "unitType": unit_type,
        "startedAt": now,
        "completedAt": None,
        "summary": "",
        "hex": hex_coord or [0, 0],
        "parentHarness": parent_harness,
        "harness": effective_harness,
        "lastProgressAt": now,
    }
    with _lock:
        _runs[sid] = run
        if tool_use_id:
            _tool_use_map[tool_use_id] = sid

    _es.record_subagent_spawn(sid, run)
    _ledger_write(run)

    spawn_evt: dict[str, Any] = {
        "type": "subagent_spawn",
        "subagentId": sid,
        "parentMissionId": parent_mission_id,
        "parentUnit": parent_unit,
        "kind": kind,
        "label": label,
        "hex": run["hex"],
        "unitType": unit_type,
        "risk": risk_level,
        "ephemeralUnitId": ephemeral_id,
    }
    if target:
        spawn_evt["targetCityId"] = target
    if parent_harness:
        spawn_evt["parentHarness"] = parent_harness
    if effective_harness:
        spawn_evt["harness"] = effective_harness
    spawn_evt["status"] = status
    _send(spawn_evt)

    register_progress(sid, phase="started", text=label[:80], force=True)
    if status == "running":
        register_progress(sid, phase="working", text=label[:80], force=True)
        _emit_unit_spawn(run)
        if target and target != parent_city and unit_type == "caravan":
            _schedule_caravan(run, parent_city, target)

    return run


def _emit_unit_spawn(run: dict[str, Any]) -> None:
    _send({
        "type": "unit_spawn",
        "unit": run["ephemeralUnitId"],
        "civ": "capital",
        "hex": run["hex"],
        "unitType": run["unitType"],
        "mission": run["label"][:120],
        "cityId": run.get("targetCityId") or run.get("parentCityId"),
        "parentUnit": run["parentUnitId"],
        "ephemeral": True,
        "subagentRunId": run["id"],
    })


def _schedule_caravan(run: dict[str, Any], parent_city: str, target_city: str) -> None:
    uid = run["ephemeralUnitId"]
    dest_hex = [1, 0]

    def _move_out() -> None:
        _send({
            "type": "unit_move",
            "unit": uid,
            "from": run["hex"],
            "to": dest_hex,
            "mission": run["parentMissionId"],
        })
        _send({"type": "unit_state", "unit": uid, "state": "working"})

    def _move_back_and_complete() -> None:
        if run.get("kind", "").lower() in ("explore",):
            _emit_fog_for_city(target_city, run["id"])
        _send({
            "type": "unit_move",
            "unit": uid,
            "from": dest_hex,
            "to": run["hex"],
            "mission": run["parentMissionId"],
        })

    threading.Timer(0.5, _move_out).start()
    threading.Timer(4.0, _move_back_and_complete).start()


def _emit_fog_for_city(city_id: str, source_subagent_id: str) -> None:
    hexes = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]]
    _send({
        "type": "fog_reveal",
        "hexes": hexes,
        "sourceSubagentId": source_subagent_id,
        "cityId": city_id,
    })


def register_complete(
    subagent_id: str,
    *,
    success: bool = True,
    summary: str = "",
) -> dict[str, Any] | None:
    with _lock:
        run = _runs.get(subagent_id)
        if not run:
            return None
        run = dict(run)
    now = time.time()
    started = float(run.get("startedAt") or now)
    duration = max(0.0, now - started)
    outcome = "complete" if success else "failed"
    patch = {
        "status": outcome,
        "completedAt": now,
        "summary": (summary or "")[:1024],
        "duration": duration,
    }
    with _lock:
        _runs[subagent_id].update(patch)
        run = dict(_runs[subagent_id])
        _last_progress_at.pop(subagent_id, None)

    _es.record_subagent_complete(subagent_id, run)
    _ledger_write(run)

    _send({
        "type": "subagent_progress",
        "subagentId": subagent_id,
        "phase": "complete",
        "text": (summary or "")[:256],
    })
    complete_evt: dict[str, Any] = {
        "type": "subagent_complete",
        "subagentId": subagent_id,
        "success": success,
        "summary": run["summary"],
        "duration": duration,
        "ephemeralUnitId": run["ephemeralUnitId"],
    }
    if run.get("outputFilePath"):
        complete_evt["outputFilePath"] = run["outputFilePath"]
    _send(complete_evt)
    _send({"type": "unit_despawn", "unit": run["ephemeralUnitId"]})
    return run


def register_progress(
    subagent_id: str,
    *,
    phase: str = "",
    text: str = "",
    force: bool = False,
) -> None:
    now = time.time()
    if not force:
        last = _last_progress_at.get(subagent_id, 0.0)
        if now - last < _PROGRESS_THROTTLE_S:
            return
    _last_progress_at[subagent_id] = now
    with _lock:
        if subagent_id in _runs:
            _runs[subagent_id]["lastProgressAt"] = now
    _send({
        "type": "subagent_progress",
        "subagentId": subagent_id,
        "phase": phase,
        "text": (text or "")[:512],
    })


def on_subagent_detected(
    *,
    ctx: MissionHarnessContext,
    kind: str,
    label: str,
    tool_use_id: str | None = None,
    detection_source: str = "",
    run_in_background: bool = True,
) -> dict[str, Any]:
    """Unified entry for passive subagent detection from any harness parser."""
    _ = detection_source
    if not run_in_background:
        return {}
    return on_task_spawn(
        mission_id=ctx.mission_id,
        unit_id=ctx.unit_id,
        subagent_type=kind,
        description=label,
        model=ctx.model,
        city_id=ctx.city_id,
        tool_use_id=tool_use_id,
        parent_harness=ctx.resolved_harness,
        harness=ctx.resolved_harness,
    )


def on_task_spawn(
    *,
    mission_id: str,
    unit_id: str,
    subagent_type: str,
    description: str,
    model: str = "",
    city_id: str = "",
    tool_use_id: str | None = None,
    parent_harness: str = "",
    harness: str = "",
) -> dict[str, Any]:
    kind = subagent_type or "generalPurpose"
    label = description or f"{kind} subagent"
    risk = _risk.classify_subagent(kind, label)
    ph = parent_harness or harness
    eff = harness or parent_harness

    if _risk.requires_approval(risk):
        sid = _new_id()
        run = register_spawn(
            parent_mission_id=mission_id,
            parent_unit=unit_id,
            kind=kind,
            label=label,
            parent_city=city_id,
            risk=risk,
            tool_use_id=tool_use_id,
            status="proposed",
            subagent_id=sid,
            parent_harness=ph,
            harness=eff,
        )
        cmd_id = str(uuid.uuid4())[:12]
        payload = {
            "subagentId": sid,
            "parentMissionId": mission_id,
            "parentUnit": unit_id,
            "kind": kind,
            "label": label,
            "city": city_id,
            "model": model,
            "harness": eff,
            "parentHarness": ph,
        }
        with _lock:
            _pending_spawn[cmd_id] = dict(run)

        from server.command_schema import Command  # noqa: PLC0415

        cmd = Command(
            id=cmd_id,
            type="subagent_spawn",
            target=unit_id,
            payload=payload,
            created_by=unit_id,
            risk=risk,
            status="waiting_approval",
            requires_approval=True,
        )
        _es.record_created(cmd_id, unit_id, cmd.to_dict())
        _es.record_waiting_approval(cmd_id)
        _add_approval(cmd.to_dict())

        _send({
            "type": "subagent_proposed",
            "subagentId": sid,
            "parentMissionId": mission_id,
            "parentUnit": unit_id,
            "kind": kind,
            "label": label,
            "risk": risk,
            "approvalRequired": True,
            "commandId": cmd_id,
        })
        _send({
            "type": "waiting_approval",
            "commandId": cmd_id,
            "commandType": "subagent_spawn",
            "target": unit_id,
            "risk": risk,
        })
        return run

    return register_spawn(
        parent_mission_id=mission_id,
        parent_unit=unit_id,
        kind=kind,
        label=label,
        parent_city=city_id,
        tool_use_id=tool_use_id,
        parent_harness=ph,
        harness=eff,
    )


def approve_spawn(command_id: str) -> bool:
    with _lock:
        run = _pending_spawn.pop(command_id, None)
        if not run:
            return False
        sid = run["id"]
        if sid in _runs:
            _runs[sid]["status"] = "running"
            run = dict(_runs[sid])

    register_progress(sid, phase="working", text=run.get("label", "")[:80], force=True)
    _emit_unit_spawn(run)
    if run.get("targetCityId") and run["targetCityId"] != run.get("parentCityId"):
        _schedule_caravan(run, run.get("parentCityId", ""), run["targetCityId"])
    _ledger_write(run)
    return True


def on_task_complete(
    *,
    tool_use_id: str | None = None,
    subagent_id: str | None = None,
    success: bool = True,
    summary: str = "",
) -> None:
    sid = subagent_id
    if tool_use_id and not sid:
        with _lock:
            sid = _tool_use_map.get(tool_use_id)
    if not sid:
        return
    register_complete(sid, success=success, summary=summary)


def _try_terminate_child(run: dict[str, Any]) -> bool:
    """Best-effort kill of a tracked child PID (Hermes CLI only when wired)."""
    pid = run.get("childPid") or run.get("child_pid")
    if not pid:
        return False
    try:
        import os
        import signal

        os.kill(int(pid), signal.SIGTERM)
        return True
    except (OSError, ProcessLookupError, ValueError):
        return False


def request_cancel(subagent_id: str) -> dict[str, Any]:
    """Recall: mark cancelled, emit bridge events, despawn ephemeral unit.

    Cursor/Claude Task children are not owned by RepoCiv — we cannot SIGTERM them.
    UI state still updates so Orden de batalla reflects the recall.
    """
    with _lock:
        run = _runs.get(subagent_id)
        if not run:
            return {"ok": False, "error": "not_found", "subagentId": subagent_id}
        status = run.get("status")
        if status not in ("proposed", "running"):
            return {
                "ok": False,
                "error": "not_active",
                "subagentId": subagent_id,
                "status": status,
            }
        run = dict(run)

    terminated = _try_terminate_child(run)
    _send({
        "type": "subagent_cancel",
        "subagentId": subagent_id,
        "reason": "user_recall",
        "childTerminated": terminated,
    })
    register_complete(
        subagent_id,
        success=False,
        summary="cancelled by user (Recall)",
    )
    with _lock:
        if subagent_id in _runs:
            _runs[subagent_id]["status"] = "cancelled"
            _ledger_write(dict(_runs[subagent_id]))
    return {
        "ok": True,
        "subagentId": subagent_id,
        "childTerminated": terminated,
        "note": (
            "child process terminated"
            if terminated
            else "UI cancelled; Cursor/Hermes Task child not killable from bridge"
        ),
    }


def request_dispatch(
    *,
    parent_mission_id: str,
    parent_unit: str,
    kind: str,
    label: str,
    harness: str = "",
) -> dict[str, Any]:
    """Phase 2 explicit dispatch — not implemented yet."""
    _ = (parent_mission_id, parent_unit, kind, label, harness)
    return {"ok": False, "error": "not_implemented", "phase": "dispatch_stub"}


def _ledger_write(run: dict[str, Any]) -> None:
    try:
        from server import research_ledger as _rl  # noqa: PLC0415
        _rl.get_ledger().record_subagent_run(run)
    except Exception:
        pass


def _parse_tool_input(data: dict[str, Any]) -> dict[str, Any]:
    raw = data.get("input") or data.get("arguments") or {}
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}
    if isinstance(raw, dict):
        return raw
    return {}


def _maybe_progress_from_assistant(data: dict[str, Any], ctx: MissionHarnessContext) -> None:
    """Throttled progress from assistant chunks when a Task is in flight."""
    with _lock:
        active_ids = [
            sid for sid, r in _runs.items()
            if r.get("parentMissionId") == ctx.mission_id
            and r.get("status") == "running"
        ]
    if not active_ids:
        return
    text = ""
    if data.get("type") == "assistant":
        content = data.get("message", {}).get("content", "")
        if isinstance(content, list):
            text = "".join(
                c.get("text", "") for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )
        else:
            text = str(content) if content else ""
    elif data.get("type") == "text":
        text = str(data.get("text") or "")
    text = text.strip()
    if not text:
        return
    register_progress(active_ids[-1], phase="working", text=text[:120])


def _handle_task_tool_use(
    data: dict[str, Any],
    *,
    ctx: MissionHarnessContext,
) -> bool:
    if data.get("type") != "tool_use" or data.get("name") != "Task":
        return False
    args = _parse_tool_input(data)
    if not args.get("run_in_background"):
        return True
    on_task_spawn(
        mission_id=ctx.mission_id,
        unit_id=ctx.unit_id,
        subagent_type=str(args.get("subagent_type") or args.get("subagentType") or "generalPurpose"),
        description=str(args.get("description") or args.get("prompt") or ""),
        model=str(args.get("model") or ctx.model),
        city_id=ctx.city_id,
        tool_use_id=str(data.get("id") or data.get("tool_use_id") or ""),
        parent_harness=ctx.resolved_harness,
        harness=ctx.resolved_harness,
    )
    return True


def _handle_tool_result(data: dict[str, Any]) -> bool:
    if data.get("type") != "tool_result":
        return False
    tool_use_id = str(data.get("tool_use_id") or data.get("id") or "")
    content = data.get("content") or data.get("output") or data.get("result") or ""
    if isinstance(content, list):
        text = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
    else:
        text = str(content)
    is_error = bool(data.get("is_error") or data.get("isError"))
    output_path = _extract_output_file_path(text)
    if output_path and tool_use_id:
        with _lock:
            sid = _tool_use_map.get(tool_use_id)
            if sid and sid in _runs:
                _runs[sid]["outputFilePath"] = output_path
    on_task_complete(tool_use_id=tool_use_id, success=not is_error, summary=text[:1024])
    return True


def _extract_output_file_path(text: str) -> str:
    """Parse Task tool_result for background subagent output_file path."""
    if not text:
        return ""
    try:
        data = json.loads(text) if text.strip().startswith("{") else {}
        if isinstance(data, dict):
            for key in ("output_file", "outputFile", "output_file_path"):
                val = data.get(key)
                if isinstance(val, str) and val.strip():
                    return val.strip()
    except json.JSONDecodeError:
        pass
    m = re.search(r'output_file["\']?\s*[:=]\s*["\']?([^"\'\s]+)', text)
    return m.group(1).strip() if m else ""


def process_cursor_ndjson_line(
    line: str,
    *,
    mission_id: str = "",
    unit_id: str = "",
    city_id: str = "",
    ctx: MissionHarnessContext | None = None,
) -> None:
    """Detect Task tool spawn/complete in cursor-agent NDJSON stream."""
    if ctx is None:
        ctx = MissionHarnessContext(
            mission_id=mission_id,
            unit_id=unit_id,
            city_id=city_id,
            resolved_harness="cursor",
        )
    line = line.strip()
    if not line:
        return
    try:
        data = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        return

    if _handle_task_tool_use(data, ctx=ctx):
        return
    if _handle_tool_result(data):
        return
    _maybe_progress_from_assistant(data, ctx)


def process_claude_stream_line(
    line: str,
    *,
    ctx: MissionHarnessContext,
) -> None:
    """Detect Task tool spawn/complete in claude --output-format stream-json."""
    if not swarm_track_enabled():
        return
    line = line.strip()
    if not line:
        return
    try:
        data = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        return

    if _handle_task_tool_use(data, ctx=ctx):
        return
    if _handle_tool_result(data):
        return
    _maybe_progress_from_assistant(data, ctx)


def process_hermes_stream_line(
    line: str,
    *,
    ctx: MissionHarnessContext,
) -> None:
    """Best-effort Hermes CLI stdout subagent detection."""
    line = line.strip()
    if not line:
        return
    try:
        data = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        if "[subagent]" in line.lower() or "subagent_start" in line.lower():
            on_subagent_detected(
                ctx=ctx,
                kind="generalPurpose",
                label=line[:120],
                detection_source="hermes_line",
            )
        return

    evt = str(data.get("type") or data.get("event") or "").lower()
    if evt in ("subagent_start", "subagent_spawn", "task", "delegate"):
        on_subagent_detected(
            ctx=ctx,
            kind=str(data.get("kind") or data.get("subagent_type") or "generalPurpose"),
            label=str(data.get("label") or data.get("description") or data.get("text") or "")[:512],
            tool_use_id=str(data.get("id") or ""),
            detection_source="hermes_event",
        )
