"""Track Cursor Task-tool subagent delegations and emit bridge events."""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from typing import Any, Callable

from server import event_store as _es
from server import subagent_risk as _risk

SendFn = Callable[[dict[str, Any]], None]
ApprovalFn = Callable[[dict[str, Any]], None]

_lock = threading.Lock()
_runs: dict[str, dict[str, Any]] = {}
_tool_use_map: dict[str, str] = {}  # tool_use_id -> subagent_id
_pending_spawn: dict[str, dict[str, Any]] = {}  # command_id -> spawn kwargs
_send: SendFn = lambda _evt: None
_add_approval: ApprovalFn = lambda _cmd: None


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
    # Absolute repo path segment
    m = re.search(r"/repos/([a-zA-Z0-9_.-]+)", label)
    if m:
        candidate = m.group(1)
        if candidate != parent_city:
            return candidate
    # Explicit cityId= or targetRepo=
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
) -> dict[str, Any]:
    """Register a subagent run and emit bridge + event-store events."""
    sid = subagent_id or _new_id()
    risk_level = risk or _risk.classify_subagent(kind, label)
    target = target_city_id or infer_target_city(label, parent_city)
    unit_type = map_kind_to_unit_type(kind)
    if target and target != parent_city:
        unit_type = "caravan"
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
    spawn_evt["status"] = status
    _send(spawn_evt)

    if status == "running":
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
    """Emit unit_move toward target; fog reveal on explore arrival."""
    uid = run["ephemeralUnitId"]
    dest_hex = [1, 0]  # placeholder — frontend resolves from targetCityId

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
    """Reveal placeholder hexes — frontend maps cityId to territory when possible."""
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

    _es.record_subagent_complete(subagent_id, run)
    _ledger_write(run)

    _send({
        "type": "subagent_progress",
        "subagentId": subagent_id,
        "phase": "complete",
        "text": (summary or "")[:256],
    })
    _send({
        "type": "subagent_complete",
        "subagentId": subagent_id,
        "success": success,
        "summary": run["summary"],
        "duration": duration,
        "ephemeralUnitId": run["ephemeralUnitId"],
    })
    _send({"type": "unit_despawn", "unit": run["ephemeralUnitId"]})
    return run


def register_progress(subagent_id: str, *, phase: str = "", text: str = "") -> None:
    _send({
        "type": "subagent_progress",
        "subagentId": subagent_id,
        "phase": phase,
        "text": (text or "")[:512],
    })


def on_task_spawn(
    *,
    mission_id: str,
    unit_id: str,
    subagent_type: str,
    description: str,
    model: str = "",
    city_id: str = "",
    tool_use_id: str | None = None,
) -> dict[str, Any]:
    """Handle Cursor Task tool_use with run_in_background=true."""
    kind = subagent_type or "generalPurpose"
    label = description or f"{kind} subagent"
    risk = _risk.classify_subagent(kind, label)

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
        }
        with _lock:
            _pending_spawn[cmd_id] = dict(run)

        from server.command_schema import Command  # noqa: PLC0415
        from server import policy as _policy  # noqa: PLC0415

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
    )


def approve_spawn(command_id: str) -> bool:
    """After approval gate — promote proposed subagent to running on map."""
    with _lock:
        run = _pending_spawn.pop(command_id, None)
        if not run:
            return False
        sid = run["id"]
        if sid in _runs:
            _runs[sid]["status"] = "running"
            run = dict(_runs[sid])

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


def request_cancel(subagent_id: str) -> dict[str, Any]:
    """Phase 6 stub — real cancel deferred."""
    return {"ok": False, "error": "not_implemented", "subagentId": subagent_id}


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


def process_cursor_ndjson_line(
    line: str,
    *,
    mission_id: str,
    unit_id: str,
    city_id: str = "",
) -> None:
    """Detect Task tool spawn/complete in cursor-agent NDJSON stream."""
    line = line.strip()
    if not line:
        return
    try:
        data = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        return

    event_type = data.get("type", "")
    if event_type == "tool_use" and data.get("name") == "Task":
        args = _parse_tool_input(data)
        if args.get("run_in_background"):
            on_task_spawn(
                mission_id=mission_id,
                unit_id=unit_id,
                subagent_type=str(args.get("subagent_type") or args.get("subagentType") or "generalPurpose"),
                description=str(args.get("description") or args.get("prompt") or ""),
                model=str(args.get("model") or ""),
                city_id=city_id,
                tool_use_id=str(data.get("id") or data.get("tool_use_id") or ""),
            )
        return

    if event_type == "tool_result":
        tool_use_id = str(data.get("tool_use_id") or data.get("id") or "")
        content = data.get("content") or data.get("output") or data.get("result") or ""
        if isinstance(content, list):
            text = " ".join(
                c.get("text", "") for c in content if isinstance(c, dict)
            )
        else:
            text = str(content)
        is_error = bool(data.get("is_error") or data.get("isError"))
        on_task_complete(tool_use_id=tool_use_id, success=not is_error, summary=text[:1024])
