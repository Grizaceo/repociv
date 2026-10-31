"""RepoCiv HTTP route handlers split by domain (Phase 4)."""
from __future__ import annotations

import json as _json_lib
import os
import time
from pathlib import Path
from typing import Any

from server.routes import health as _health_routes
from server.routes import profile_registry as _profile_routes
from server.routes.external_agents import (
    get_external_agents as get_external_agents,
    get_external_agent_sessions as get_external_agent_sessions,
    get_herdr_agents as get_herdr_agents,
    get_herdr_launch as get_herdr_launch,
    get_own_sessions as get_own_sessions,
    post_own_session_close as post_own_session_close,
    get_external_agent_chat as get_external_agent_chat,
    post_external_agent_chat as post_external_agent_chat,
    get_external_agent_resume as get_external_agent_resume,
    post_external_agent_reply as post_external_agent_reply,
)
from server.routes.pending import (
    get_pending as get_pending,
    post_pending_add as post_pending_add,
    post_pending_resolve as post_pending_resolve,
    post_pending_edit as post_pending_edit,
    post_pending_delete as post_pending_delete,
    post_pending_state as post_pending_state,
)
from server.routes.providers import (
    _error as _error,
    _auth_headers as _auth_headers,
    _probe_url as _probe_url,
    _extract_model_ids as _extract_model_ids,
    get_providers_live as get_providers_live,
)

RouteContext = dict[str, Any]

# Module-level indirection (R05) so tests can stub the diagnostic source.
_build_identity = None


def get_health(ctx: "RouteContext") -> tuple[int, Any]:
    return _health_routes.get_health(
        ctx, identity_source=lambda: _build_identity, now=lambda: time.time(),
    )

def get_ready(ctx: "RouteContext") -> tuple[int, Any]:
    return _health_routes.get_ready(ctx)

def get_missions(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import load_missions
    return 200, load_missions()


def get_telemetry_usage(_ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/telemetry/usage — audit-ready usage summary (counts only)."""
    from server import ui_telemetry as _ut

    return 200, _ut.get_usage_summary()


def post_telemetry_ui(body: Any, _ctx: "RouteContext") -> tuple[int, Any]:
    """POST /api/telemetry/ui — record panel/hotkey integer counts on the bridge."""
    from server import ui_telemetry as _ut

    if not isinstance(body, dict):
        return 400, {"error": "invalid_payload"}
    kind = str(body.get("kind") or "")
    name = str(body.get("name") or "")
    count = body.get("count", 1)
    if not _ut.record_ui_event(kind, name, count if isinstance(count, int) else 1):
        return 400, {"error": "invalid_telemetry_event"}
    return 200, _ut.get_usage_summary()

def post_subagent_cancel(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /subagents/cancel — Recall a running subagent by id."""
    from server import subagent_tracker as _st

    subagent_id = str(body.get("subagentId") or body.get("subagent_id") or "").strip()
    if not subagent_id:
        return 400, {"ok": False, "error": "subagentId required"}
    return 200, _st.request_cancel(subagent_id)

def get_subagents(ctx: "RouteContext") -> tuple[int, Any]:
    from server import research_ledger as _rl
    from server import subagent_tracker as _st
    params = ctx.get("params", {})
    parent_unit = str(params.get("parentUnit") or params.get("parent_unit") or "")
    parent_mission = str(params.get("parentMission") or params.get("parent_mission") or "")
    active = str(params.get("active", "")).lower() in ("1", "true", "yes")
    ledger_rows = _rl.get_ledger().list_subagent_runs(
        parent_unit=parent_unit,
        parent_mission=parent_mission,
        active_only=active,
    )
    if ledger_rows:
        return 200, {"subagents": ledger_rows, "source": "duckdb"}
    memory = _st.list_active(parent_unit or None)
    if parent_mission:
        memory = [r for r in memory if r.get("parentMissionId") == parent_mission]
    return 200, {"subagents": memory, "source": "memory"}

def get_mission_tree(ctx: "RouteContext") -> tuple[int, Any]:
    from server import research_ledger as _rl
    from server import run_state as _run_state
    mission_id = str(ctx.get("mission_id") or "")
    if not mission_id:
        return 400, {"error": "mission_id required"}
    tree = _rl.get_ledger().get_mission_tree(mission_id)
    run_snap = _run_state.load(mission_id)
    if run_snap:
        tree["runState"] = run_snap
    return 200, tree

def get_gpu(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import get_gpu_info
    return 200, get_gpu_info()

def get_context(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _fatigue_state, _rest_areas
    return 200, {"ok": True, "fatigue": _fatigue_state, "restAreas": _rest_areas}

def get_approvals(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _get_approvals
    approvals = _get_approvals()
    for cmd in approvals:
        if cmd.get("type") == "herdr_launch" and isinstance(cmd.get("payload"), dict):
            cmd["payload"] = {k: v for k, v in cmd["payload"].items() if k not in {"repoPath", "cwd", "_context"}}
    return 200, approvals

def get_agents(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _sched
    return 200, {
        "agents": _sched.get_agent_status(),
        "queueDepth": len(_sched.queue_snapshot()),
        "queue": _sched.queue_snapshot()[:20],
    }

def get_agents_capabilities(ctx: "RouteContext") -> tuple[int, Any]:
    from server.capabilities import capabilities_snapshot
    return 200, capabilities_snapshot()

def get_chat_config(ctx: "RouteContext") -> tuple[int, Any]:
    from server.provider_registry import _get_chat_config
    params = ctx.get("params", {})
    harness = (params.get("harness") or "").strip()
    return 200, _get_chat_config(harness=harness if harness else None)

def get_metrics(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _es, _sched, get_gpu_info, _to
    from server.metrics import compute_metrics
    from server import endpoint_usage as _endpoint_usage
    events = _es.read_events(since=0, limit=500)
    agent_status = _sched.get_agent_status()
    queue_depth = len(_sched.queue_snapshot())
    gpu = get_gpu_info()
    payload = compute_metrics(events, agent_status, queue_depth, gpu)
    payload["circuitOpenCount"] = _to.count_circuit_open()
    payload["endpointUsage"] = _endpoint_usage.get_stats(limit=25)
    return 200, payload

def get_directives_stats(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _ds, _dl
    records = _ds.read_records()
    return 200, _dl.stats_snapshot(records)

def get_directives_suggest(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _ds, _dl
    params = ctx.get("params", {})
    gesture = params.get("gesture", "")
    agent_id = params.get("agent", "MAIN")
    records = _ds.read_records()
    extra_ctx: dict[str, Any] | None = None
    ctx_keys = ("repoType", "testStatus", "lastCmdType")
    if any(params.get(k) for k in ctx_keys):
        extra_ctx = {k: params[k] for k in ctx_keys if params.get(k)}
    return 200, _dl.suggest(gesture, agent_id, records, current_context=extra_ctx)

def get_harnesses(ctx: "RouteContext") -> tuple[int, Any]:
    from server import harness_registry as _hr
    return 200, _hr.list_harnesses()


def get_harness_by_id(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /harnesses/{id} — return a single harness descriptor by id.

    The bridge fills ``ctx['harness_id']`` from the path segment. Returns the
    bare descriptor (mirroring ``get_harnesses``' unwrapped list shape, which
    ``recoveryClient.getHarness`` consumes directly) on 200, or a structured
    404 envelope when no harness matches — never an unhandled 500.
    """
    from server import harness_registry as _hr
    harness_id = ctx.get("harness_id", "")
    harness = _hr.get_harness(harness_id)
    if harness is None:
        return _error(
            404,
            f"harness '{harness_id}' not found",
            "no registered harness has this id",
            "GET /harnesses to list the valid harness ids",
        )
    return 200, harness


def get_default_harness(_ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/config/default-harness — return the user's chosen default harness.

    Onboarding writes this in step 2 of the panel; until then it is None
    and MAIN's capabilities stay empty (the bridge does not crash on missing
    config — it just refuses capability-gated commands).
    """
    from server import config_store as _cs
    return 200, {"harness": _cs.get_default_harness()}


def post_default_harness(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/config/default-harness — persist the user's harness choice.

    Body: { "harness": "hermes" | "claude" | "codex" | "cursor" | "openclaw" | "opencode" }
    Response 200: { "harness": "<normalized>" }
    Response 400: { "error": "<reason>" }
    """
    from server import config_store as _cs
    harness = body.get("harness")
    if not isinstance(harness, str) or not harness.strip():
        return 400, {"error": "harness is required and must be a non-empty string"}
    try:
        normalized = _cs.set_default_harness(harness)
    except ValueError as exc:
        return 400, {"error": str(exc)}
    return 200, {"harness": normalized}


def get_profiles(_ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/profiles — return the user's profile registry.

    The registry is a dict of name -> {"harness": ..., ...optional fields}.
    The shipped default is one profile per built-in harness, but the user
    can rename, add, or remove profiles at any time.
    """
    return _profile_routes.get_profiles(_ctx)


def post_profiles(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/profiles — create or update a profile.

    Body: { "name": "<name>", "harness": "<harness>", ...optional }
    Response 200: { "profile": {...normalized entry...} }
    Response 400: { "error": "<reason>" }
    """
    return _profile_routes.post_profiles(body, _ctx)


def post_profiles_delete(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/profiles/delete — remove a profile by name.

    Body: { "name": "<name>" }
    Response 200: { "ok": True }
    Response 404: { "error": "profile '<name>' not found" }
    Response 400: { "error": "<reason>" }
    """
    return _profile_routes.post_profiles_delete(body, _ctx)


def get_profile_identity(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/profiles/{name}/identity — read identity (Alma) for a profile.

    URL param: name (profile name)
    Response 200: { "content": str, "path": str, "exists": bool }
    Response 404: { "error": "profile not found" }
    """
    from server import config_store as _cs
    from server import profile_identity as _pi
    params = ctx.get("params", {})
    name = str(params.get("name") or "").strip()
    if not name:
        return 400, {"error": "profile name is required"}
    profile = _cs.get_profile(name)
    if profile is None:
        return 404, {"error": f"profile {name!r} not found"}
    harness = profile.get("harness", "")
    harness_ref = profile.get("harness_ref", "default")
    identity_mode = profile.get("identity_mode", "managed")
    return 200, _pi.read_identity(name, harness, harness_ref, identity_mode)


def post_profile_identity(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/profiles/{name}/identity — write identity (Alma) for a profile.

    URL param: name (profile name)
    Body: { "content": "<markdown text>" }
    Response 200: { "ok": bool, "path": str }
    """
    from server import config_store as _cs
    from server import profile_identity as _pi
    params = ctx.get("params", {})
    name = str(params.get("name") or "").strip()
    if not name:
        return 400, {"error": "profile name is required"}
    profile = _cs.get_profile(name)
    if profile is None:
        return 404, {"error": f"profile {name!r} not found"}
    content = body.get("content")
    if not isinstance(content, str):
        return 400, {"error": "content must be a string"}
    harness = profile.get("harness", "")
    harness_ref = profile.get("harness_ref", "default")
    identity_mode = profile.get("identity_mode", "managed")
    result = _pi.write_identity(name, harness, content, harness_ref, identity_mode)
    if not result.get("ok"):
        return 500, result
    return 200, result


def get_profile_harness_options(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/profiles/{name}/harness-options — list available harness_ref values.

    URL param: name (profile name)
    Response 200: { "options": [str, ...], "harness": str }
    """
    from server import config_store as _cs
    from server import profile_identity as _pi
    params = ctx.get("params", {})
    name = str(params.get("name") or "").strip()
    if not name:
        return 400, {"error": "profile name is required"}
    profile = _cs.get_profile(name)
    if profile is None:
        return 404, {"error": f"profile {name!r} not found"}
    harness = profile.get("harness", "")
    options = _pi.list_harness_options(harness)
    return 200, {"options": options, "harness": harness}


def get_harness_profiles(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/harness-profiles?harness=hermes — list native profiles for a harness.

    For hermes: subdirs of ~/.hermes/profiles/ (main, lexo-alpha, ...) — the
    same profiles the Hermes app shows in its own profile selector. For
    codex/openclaw: best-effort via list_harness_options. Claude, Cursor and
    OpenCode have no native profile list (empty).

    Response 200:
        {"profiles": [str, ...], "harness": str}
    With ?with_identity=1 (hermes only) each entry is enriched with the
    real identity already computed by get_roster (avatar_kind / avatar_url /
    pet / face_url) — single source of truth, no catalogue duplication, no
    profile.yaml read. Read-only; names come from list_harness_options
    (profile dir names, valid slugs — never concatenated into a path).
    """
    from server import profile_identity as _pi

    params = ctx.get("params", {})
    harness = str(params.get("harness") or "").strip().lower()
    if not harness:
        return 400, {"error": "harness query param is required"}
    options = _pi.list_harness_options(harness)

    want_identity = str(params.get("with_identity") or "").lower() in ("1", "true", "yes")
    if want_identity and harness == "hermes":
        # Reuse get_roster's computed identity (single source, read-only).
        _, body = get_roster({"params": {"harness": "hermes"}})
        by_name = {b["name"]: b for b in body.get("bots", [])}
        profiles = [
            {
                "name": name,
                "avatar_kind": by_name.get(name, {}).get("avatar_kind"),
                "avatar_url": by_name.get(name, {}).get("avatar_url"),
                "pet": by_name.get(name, {}).get("pet"),
                "face_url": by_name.get(name, {}).get("face_url"),
            }
            for name in options
        ]
        return 200, {"profiles": profiles, "harness": harness}

    return 200, {"profiles": options, "harness": harness}


# ─── Bot Mode roster (read-only) ─────────────────────────────────────────────
# GET /api/roster and /api/roster/asset/<file> expose each Hermes profile's
# installed identity (a pet spritesheet and/or its assets/avatar.png) for the
# "➕ Bot" spawner and the unit avatars on the grid. Design constraints
# (red-team, @cobalt / @user):
#   * The bridge NEVER reads or writes profile.yaml / memberships / routines.
#   * Only a coarse signal (avatar_kind) and allowlisted asset files are
#     served; never arbitrary profile-internal files (path-traversal /
#     metadata-leak risk).


def _slug_ok(s: str) -> bool:
    """Allow only alnum / dash / underscore — blocks any path separator."""
    return bool(s) and all(ch.isalnum() or ch in "-_" for ch in s)


def get_roster(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/roster?harness=hermes — Bot Mode roster (read-only).

    Response 200: {
      "harness": str,
      "bots": [ {
        "name": str, "is_bot": true,
        "avatar_kind": "pet" | "face" | "asset" | null,
        "avatar_url":  str | null,            # asset allowlist URL
        "pet":  {"id","displayName","description"} | null,
        "face_url": str | null                # /api/roster/asset/<name>/avatar.png
      } ]
    }

    Identity is REAL and consistent across views: each bot exposes its Hermes
    identity (a pet spritesheet and/or its face avatar.png), read read-only
    from profiles/<name>/{pets/<pet>,assets/avatar.png}.
      - shadow-davi keeps the curated DAVI render asset (avatar_kind "asset").
      - a bot with a pet gets avatar_kind "pet" (eidos) — richest identity.
      - every other bot with assets/avatar.png gets avatar_kind "face".
      - only bots with NEITHER fall back to null (frontend glyph). Today all
        25 profiles have assets/avatar.png, so everyone has a real identity.

    Read-only: never writes profile.yaml / memberships. Paths confined to the
    profiles dir and slug-validated (no traversal possible).
    """
    from server import profile_identity as _pi
    from server.bridge import HERMES_ROOT  # type: ignore

    params = ctx.get("params", {})
    harness = str(params.get("harness") or "hermes").strip().lower()
    names = _pi.list_harness_options(harness)
    profiles_dir = HERMES_ROOT / "profiles"
    # Canonical pet preference per profile (first match wins); else first by name.
    # shadow-davi has its real pet "shadow" (hedgehog), so it gets avatar_kind
    # "pet" like any other pet-bearing bot — consistent identity everywhere.
    preferred_pet = {"eidos": "squirrel-girl-marvel", "shadow-davi": "shadow"}
    bots = []
    for name in names:
        pet_detail = None
        pet_url = None
        pet_dir = profiles_dir / name / "pets"
        if pet_dir.is_dir():
            pet_ids = sorted(p.parent.name for p in pet_dir.glob("*/pet.json"))
            canon = next((p for p in pet_ids if p == preferred_pet.get(name)), None)
            if canon is None and pet_ids:
                canon = pet_ids[0]
            if canon:
                pj = pet_dir / canon / "pet.json"
                try:
                    meta = _json_lib.loads(pj.read_text())
                except Exception:
                    meta = {}
                pet_detail = {
                    "id": meta.get("id") or canon,
                    "displayName": meta.get("displayName", canon),
                    "description": meta.get("description", ""),
                }
                pet_url = f"/api/roster/asset/{name}/pet/{canon}.webp"
        face_url = None
        if (profiles_dir / name / "assets" / "avatar.png").is_file():
            face_url = f"/api/roster/asset/{name}/avatar.png"
        if pet_detail:
            bots.append(
                {
                    "name": name,
                    "is_bot": True,
                    "avatar_kind": "pet",
                    "avatar_url": pet_url,
                    "pet": pet_detail,
                    "face_url": face_url,
                }
            )
        elif face_url:
            bots.append(
                {
                    "name": name,
                    "is_bot": True,
                    "avatar_kind": "face",
                    "avatar_url": face_url,
                    "face_url": face_url,
                }
            )
        else:
            bots.append(
                {"name": name, "is_bot": True, "avatar_kind": None, "avatar_url": None}
            )
    return 200, {"harness": harness, "bots": bots}


def get_roster_asset(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/roster/asset/<file> — serve opt-in identity assets.

    Allowlist (no traversal, slug-validated, files confined to the profiles
    dir):
      - "davi_avatar_render.png"   (legacy curated DAVI render)
      - "<name>/avatar.png"        (a bot's face, kind "face")
      - "<name>/pet/<petid>.webp"  (a bot's pet spritesheet, kind "pet")

    Returns (200, bytes) on success. Read-only; never writes profile.yaml.
    """
    from server.bridge import HERMES_ROOT  # type: ignore

    asset = str(ctx.get("asset", "")).strip().lstrip("/")
    profiles_dir = HERMES_ROOT / "profiles"

    # Legacy single-file allowlist (DAVI render)
    if asset == "davi_avatar_render.png":
        candidates = [
            "/mnt/c/Users/usuario/Desktop/davi_avatar_render.png",
            str(HERMES_ROOT / "profiles" / "davi" / "davi_avatar_render.png"),
        ]
        for c in candidates:
            p = Path(c)
            if p.is_file():
                return 200, p.read_bytes()
        return 404, {"error": "asset not found"}

    parts = asset.split("/")
    if len(parts) == 2 and parts[1] == "avatar.png":
        name = parts[0]
        if not _slug_ok(name):
            return 400, {"error": "invalid name"}
        p = profiles_dir / name / "assets" / "avatar.png"
        if p.is_file():
            return 200, p.read_bytes()
        return 404, {"error": "asset not found"}

    if len(parts) == 3 and parts[1] == "pet" and parts[2].endswith(".webp"):
        name = parts[0]
        petid = parts[2].removesuffix(".webp")  # drop the extension exactly
        if not _slug_ok(name) or not _slug_ok(petid):
            return 400, {"error": "invalid name"}
        # Force the basename to spritesheet.webp so no other file can be served.
        p = profiles_dir / name / "pets" / petid / "spritesheet.webp"
        if p.is_file():
            return 200, p.read_bytes()
        return 404, {"error": "asset not found"}

    return 404, {"error": "unknown asset"}


def get_log(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _es
    params = ctx.get("params", {})
    try:
        n = min(max(1, int(params.get("n", "100"))), 500)
        event_type_filter = params.get("type", "")
    except Exception:
        n, event_type_filter = 100, ""
    if params.get("metadata") == "1":
        # Read the canonical JSONL, not a second history store. Never send prompts,
        # command payloads, output, errors, credentials or arbitrary actor text.
        # ExecutionIdentityRecorded fields (harness, profileName, agentName,
        # unitId, provider, model, commandType) are safe identity metadata only.
        safe_fields = {
            "repo", "taskKey", "runId", "commandId", "agentId", "pid",
            "processIdentity", "phase",
            "harness", "profileName", "agentName", "unitId", "provider",
            "model", "commandType", "unitName",
        }
        rows = []
        cursor = 0
        path = _es._store_path
        if path is not None and path.exists():
            try:
                with path.open("rb") as stream:
                    stream.seek(0, 2)
                    size = stream.tell()
                    before = params.get("before")
                    end = min(size, max(0, int(before))) if before is not None else size
                    start = max(0, end - 262144)  # Bound disk work and response memory per page.
                    stream.seek(start)
                    chunk = stream.read(end - start)
                if start > 0:
                    boundary = chunk.find(b"\n")
                    if boundary < 0:
                        chunk = b""
                    else:
                        start += boundary + 1
                        chunk = chunk[boundary + 1:]
                offsets = []
                position = start
                for line in chunk.splitlines(keepends=True):
                    offsets.append((position, line))
                    position += len(line)
                cursor = start if offsets else max(0, end - 262144)
                for offset, raw in reversed(offsets):
                    try:
                        event = _json_lib.loads(raw)
                    except (ValueError, UnicodeError):
                        continue
                    if not isinstance(event, dict) or event.get("type") == "AgentOutputChunk":
                        continue
                    data = event.get("data") or {}
                    if not isinstance(data, dict):
                        data = {}
                    safe = {k: v for k, v in data.items() if k in safe_fields and isinstance(v, (str, int))}
                    if event.get("type") == "CommandCreated" and isinstance(data.get("type"), str):
                        safe["commandType"] = data["type"]
                    rows.append({"id": event.get("id"), "commandId": event.get("commandId", ""),
                                 "type": event.get("type", ""), "timestamp": event.get("timestamp", 0),
                                 "data": safe, "sourceOffset": offset})
                    if len(rows) >= n:
                        cursor = offset
                        break
            except ValueError:
                return 400, {"error": "invalid_history_cursor"}
            except OSError:
                return 503, {"error": "activity_unavailable"}
        result = list(reversed(rows))
        if params.get("paged") == "1":
            return 200, {"events": result, "before": cursor, "more": cursor > 0}
        # Compatibility: metadata arrays are also bounded, never full-history scans.
        return 200, result
    events = _es.read_events(since=0, limit=500)
    if event_type_filter:
        events = [e for e in events if e.get("type") == event_type_filter]
    return 200, events[-n:]

def get_ws_info(ctx: "RouteContext") -> tuple[int, Any]:
    """Return WebSocket connection info for the frontend."""
    from server.bridge import BRIDGE_WS_PORT
    return 200, {
        "wsUrl": f"ws://localhost:{BRIDGE_WS_PORT}",
        "wsPort": BRIDGE_WS_PORT,
        "protocol": "websocket",
        "authRequired": bool(os.environ.get("REPOCIV_TOKEN", "")),
    }

def post_directives_record(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _ds
    command_id = str(body.get("commandId", ""))
    gesture = str(body.get("gesture", ""))
    agent_id = str(body.get("agentId", "MAIN"))
    cmd_type = str(body.get("cmdType", ""))
    target = str(body.get("target", ""))
    extra_ctx: dict[str, Any] = {}
    for k in ("repoType", "testStatus", "lastCmdType"):
        if body.get(k):
            extra_ctx[k] = str(body[k])
    if body.get("gameTick") is not None:
        extra_ctx["gameTick"] = int(body["gameTick"])
    if command_id and gesture and cmd_type:
        _ds.record_gesture(command_id, gesture, agent_id, cmd_type, target,
                           extra_ctx if extra_ctx else None)
    return 200, {"ok": True}


def _validate_command_target(cmd: Any) -> str | None:
    if cmd.type == "herdr_launch":
        from server import herdr_runtime as _herdr
        from server import repo_roots_state as _rrs

        payload = cmd.payload
        if "repoPath" in payload or "cwd" in payload:
            return "herdr_launch does not accept paths"
        city = payload.get("city")
        if not isinstance(city, str) or not city.strip() or city != cmd.target or "/" in city or "\\" in city:
            return "city must reference a selected RepoCiv repository"
        kind = payload.get("kind")
        if not isinstance(kind, str) or kind not in _herdr.LAUNCH_KINDS:
            return "invalid herdr kind"
        mission = payload.get("mission", "")
        if not isinstance(mission, str) or len(mission) > _herdr.MAX_SUBMIT_CHARS:
            return "invalid mission"
        selected = _rrs.resolve_selected_repo(city)
        if selected is None:
            return "city must reference a selected RepoCiv repository"
        payload["repoPath"] = selected
        payload["unit"] = "HERDR"
        return None
    if cmd.type != "execute_agent":
        return None
    from server import agent_runner as _runner
    from server import repo_roots_state as _rrs

    payload = cmd.payload
    harness = str(payload.get("harness") or "").strip().lower()
    city = str(payload.get("city") or cmd.target).strip()
    has_requested_city = bool(str(payload.get("city") or "").strip())
    raw_repo = str(payload.get("repoPath") or "").strip()
    if not raw_repo:
        selected = _rrs.resolve_selected_repo(city)
        if selected is not None:
            # The browser supplies only a city id. Keep the canonical filesystem
            # path server-side after validating it against the selected roots.
            payload["repoPath"] = selected
        elif has_requested_city:
            return "city must reference a selected RepoCiv repository"
        # Chat/hermes path: legacy callers without a requested city may talk
        # without a registered repoPath. CLI harnesses still require one.
        elif harness in {"", "auto", "hermes"}:
            return None
        else:
            return "execute_agent requires repoPath for non-MAIN or CLI harnesses"
    else:
        selected = _rrs.resolve_selected_repo(city, raw_repo)
        if selected is None:
            return "repoPath must reference a selected RepoCiv repository"
        payload["repoPath"] = selected
    file_path = str(payload.get("filePath") or "").strip()
    if file_path:
        try:
            _runner.resolve_absolute_file_path(selected, file_path)
        except ValueError as exc:
            return str(exc)
    return None


def post_commands(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _handle_command, _agent_rate_limiter, _endpoint_rate_limiter
    from server.command_schema import validate_command, CommandValidationError
    try:
        cmd = validate_command(body)
    except CommandValidationError as e:
        return 400, {"error": str(e)}
    target_error = _validate_command_target(cmd)
    if target_error:
        return 403, {"error": target_error}
    # Fase 1 / audit 1.2: per-endpoint cap (10/min). Defense in depth on
    # top of the per-IP limit in do_POST — stops bursts of agent spawns
    # from any number of callers.
    if not _endpoint_rate_limiter.check_and_consume("post_commands"):
        return 429, {"error": "rate_limit", "endpoint": "post_commands"}
    agent_type = str(cmd.payload.get("unit") or body.get("agentType") or "MAIN")
    if not _agent_rate_limiter.check_and_consume(agent_type):
        return 429, {"error": "rate_limit", "agent": agent_type}
    result = _handle_command(cmd)
    return 200, result

def _validate_unit_id(raw: Any) -> str | None:
    """Return sanitized unit_id (uppercase, alphanumeric + dash/underscore, 1–32 chars)
    or None if the value is invalid. Guards against path-traversal attacks.

    When the input is empty, defaults to "MAIN" — the user's first unit slot,
    which is configured during onboarding (harness selection).
    """
    import re
    uid = str(raw or "").strip().upper()
    if not uid:
        return "MAIN"
    if re.fullmatch(r"[A-Z0-9_-]{1,32}", uid):
        return uid
    return None

def post_session_reset(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /session/reset — delete session files and return a new session nonce.

    Body: { "unit": "<unit_id>" }
    Response: { "ok": True, "newSessionId": "repociv-<unit_id>-<timestamp>" }
    """
    from server import sessions as _sessions
    unit_id = _validate_unit_id(body.get("unit", "MAIN"))
    if unit_id is None:
        return 400, {"error": "Invalid unit_id — must be alphanumeric/dash/underscore, max 32 chars"}
    new_sid = _sessions.reset(unit_id)
    return 200, {"ok": True, "newSessionId": new_sid, "unit": unit_id}

def post_model_override(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /model/override — set per-unit provider/model override (in-memory).

    Body: { "unit": "<unit_id>", "provider": "<provider_id>", "model": "<model_id>" }
    Persists until bridge restart or another /model/override call for the same unit.
    Note: override applies to the Hermes harness only; other harnesses use their
    own model-selection logic.
    """
    from server import agent_runner as _ar
    unit_id = _validate_unit_id(body.get("unit", "MAIN"))
    if unit_id is None:
        return 400, {"error": "Invalid unit_id — must be alphanumeric/dash/underscore, max 32 chars"}
    provider = str(body.get("provider", "")).strip()
    model = str(body.get("model", "")).strip()
    if not provider or not model:
        return 400, {"error": "Both 'provider' and 'model' are required"}
    _ar.set_model_override(unit_id, provider, model)
    return 200, {"ok": True, "unit": unit_id, "provider": provider, "model": model}


# ─── Hermes status (Fase 1 / audit 1.1) ──────────────────────────────────────
# Endpoint that the frontend's "degraded mode" banner consults. Returns
# a structured reachability object (always 200, even when Hermes is down,
# so the UI can read the body and decide what to render). See
# server/hermes_status.py for the probe + cache details.
def get_hermes_status_route(_ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/hermes/status — Hermes reachability + cache metadata.

    Always returns 200 with a structured body. The UI reads ``available``
    to decide whether to show the "Hermes ausente" banner and
    ``error`` / ``latencyMs`` to populate the degraded-mode details.
    """
    from server.hermes_status import probe_hermes
    status = probe_hermes()
    return 200, status


def get_kanban(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/kanban — Hermes kanban board (read-only).

    Query params:
        board (str, optional): board slug; omitted → the active board.
    """
    from server import kanban_reader as _kb

    params = ctx.get("params") or {}
    slug = str(params.get("board", "") or "").strip()
    return 200, _kb.get_board(slug)


def get_kanban_boards(_ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/kanban/boards — every board on disk with status counts."""
    from server import kanban_reader as _kb

    return 200, {"boards": _kb.list_boards()}
