"""RepoCiv HTTP route handlers split by domain (Phase 4)."""
from __future__ import annotations

import json as _json_lib
import logging
import os
import shutil
import subprocess
import threading as _threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

RouteContext = dict[str, Any]

# Hermes CLI used by the Bot Mode room relay (post_room_message). Resolved at
# call time via PATH; the hermes-agent venv bin is on PATH in this environment.
HERMES_CLI = shutil.which("hermes") or "hermes"

# ─── providers-live cache (avoids blocking the HTTP thread for up to 40s) ─────
_providers_live_cache: dict | None = None
_providers_live_ts: float = 0.0
_PROVIDERS_CACHE_TTL = 30.0

def _error(status: int, error: str, cause: str, hint: str) -> tuple[int, dict]:
    """Return a structured error envelope: {error, cause, hint}."""
    return status, {"error": error, "cause": cause, "hint": hint}

def _auth_headers(provider: str) -> dict[str, str]:
    """Return Authorization header for a given provider, if API key is set.

    Slugs are the canonical Hermes names; legacy aliases (``openai``,
    ``nvidia-nim``) are kept as fallbacks for persisted selections from
    pre-v2.1 RepoCiv state. See execplan/provider-model-parity-with-hermes-tui.md §A.6.
    """
    env_keys = {
        "ollama-cloud": "OLLAMA_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
        # Canonical Hermes slugs:
        "openai-api": "OPENAI_API_KEY",
        "nvidia": "NVIDIA_API_KEY",
        # Legacy aliases (RepoCiv static registry used these pre-v2.1):
        "openai": "OPENAI_API_KEY",
        "nvidia-nim": "NVIDIA_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "deepseek": "DEEPSEEK_API_KEY",
        "xai": "XAI_API_KEY",
    }
    key = env_keys.get(provider)
    if key:
        token = os.environ.get(key, "")
        if token:
            # OpenRouter and xAI use Bearer; OpenAI/Anthropic use Bearer; Ollama uses header
            if provider == "ollama-cloud":
                return {"Authorization": f"Bearer {token}"}
            return {"Authorization": f"Bearer {token}"}
    return {}

def _probe_url(url: str, method: str = "GET", headers: dict | None = None, timeout: int = 5) -> list[str]:
    """Attempt HTTP request; return list of model IDs or empty on failure."""
    try:
        h: dict[str, str] = headers or {}
        req = urllib.request.Request(url, headers=h, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = _json_lib.loads(resp.read())
            # Normalise various provider response shapes into a flat list of model ID strings
            return _extract_model_ids(data, url)
    except Exception:
        return []

def _extract_model_ids(data: Any, url: str) -> list[str]:
    """Extract model ID strings from various API response shapes."""
    ids: list[str] = []

    # OpenAI / Anthropic / DeepSeek / xAI / NVIDIA — { "data": [{ "id": "..." }] }
    if isinstance(data, dict):
        raw = data.get("data")
        if isinstance(raw, list):
            for m in raw:
                mid = m.get("id") if isinstance(m, dict) else None
                if mid:
                    ids.append(str(mid))
            if ids:
                return ids

        # OpenRouter — { "data": [{ "id": "..." }] }  (same shape, already handled)
        # Ollama tags — { "models": [{ "name": "..." }] }
        if "models" in data and isinstance(data["models"], list):
            for m in data["models"]:
                name = m.get("name") if isinstance(m, dict) else None
                if name:
                    ids.append(str(name))
            if ids:
                return ids

        # NVIDIA NIM — { "models": [{"model_id": "..." }] }
        if "models" in data and isinstance(data["models"], list):
            for m in data["models"]:
                mid = m.get("model_id") if isinstance(m, dict) else None
                if mid:
                    ids.append(str(mid))
            if ids:
                return ids

    # Fallback: if data itself is a list
    if isinstance(data, list):
        for m in data:
            mid = m.get("id") if isinstance(m, dict) else None
            if mid:
                ids.append(str(mid))

    return ids

def get_health(ctx: "RouteContext") -> tuple[int, Any]:
    from server.agent_runner import _has_claude_code, _has_openclaw, _has_cursor, _has_codex
    from server.bridge import _sched, get_gpu_info, _es, mcp_status
    agent_status = _sched.get_agent_status()
    queue_depth = len(_sched.queue_snapshot())
    gpu = get_gpu_info()
    return 200, {
        "ok": True,
        "version": "0.1.0",
        "timestamp": time.time(),
        "openclaw": _has_openclaw(),
        "claudeCode": _has_claude_code(),
        "cursor": _has_cursor(),
        "codex": _has_codex(),
        "mcp": mcp_status(),
        "defaultTransport": "hermes",
        "agents": {
            "active": sum(1 for a in agent_status if a.get("status") == "active"),
            "total": len(agent_status),
            "queueDepth": queue_depth,
        },
        "gpu": gpu,
        "eventStore": str(_es._store_path) if hasattr(_es, "_store_path") else None,
    }

def get_ready(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _es, REPOCIV_TOKEN
    return 200, {"ok": True, "eventStore": str(_es._store_path), "token": bool(REPOCIV_TOKEN)}

def get_missions(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import load_missions
    return 200, load_missions()

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

def get_pending(ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_tracker import load_pending_tasks
    from server.pending_local import load_local_tasks
    hermes_items = []
    try:
        hermes_items = load_pending_tasks()
        for it in hermes_items:
            it["source"] = "hermes"
    except Exception:
        pass
    local_items = load_local_tasks()
    return 200, hermes_items + local_items

def get_context(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _fatigue_state, _rest_areas
    return 200, {"ok": True, "fatigue": _fatigue_state, "restAreas": _rest_areas}

def get_approvals(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _get_approvals
    return 200, _get_approvals()

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

    Body: { "harness": "hermes" | "claude" | "codex" | "cursor" | "openclaw" }
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
    from server import config_store as _cs
    return 200, {"profiles": _cs.list_profiles()}


def post_profiles(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/profiles — create or update a profile.

    Body: { "name": "<name>", "harness": "<harness>", ...optional }
    Response 200: { "profile": {...normalized entry...} }
    Response 400: { "error": "<reason>" }
    """
    from server import config_store as _cs
    name = body.get("name")
    harness = body.get("harness")
    if not isinstance(name, str) or not isinstance(harness, str):
        return 400, {"error": "name and harness are required strings"}
    try:
        entry = _cs.upsert_profile(
            name,
            harness,
            personality=body.get("personality"),
            system_prompt=body.get("system_prompt"),
            profile_path=body.get("profile_path"),
            model=body.get("model"),
            provider=body.get("provider"),
            harness_ref=body.get("harness_ref"),
            display_name=body.get("display_name"),
            identity_mode=body.get("identity_mode"),
            slot_order=body.get("slot_order"),
        )
    except ValueError as exc:
        return 400, {"error": str(exc)}
    return 200, {"profile": entry}


def post_profiles_delete(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/profiles/delete — remove a profile by name.

    Body: { "name": "<name>" }
    Response 200: { "ok": True }
    Response 404: { "error": "profile '<name>' not found" }
    Response 400: { "error": "<reason>" }
    """
    from server import config_store as _cs
    name = body.get("name")
    if not isinstance(name, str):
        return 400, {"error": "name is required and must be a string"}
    try:
        deleted = _cs.delete_profile(name)
    except ValueError as exc:
        return 400, {"error": str(exc)}
    if not deleted:
        return 404, {"error": f"profile {name!r} not found"}
    return 200, {"ok": True}


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
    codex/openclaw: best-effort via list_harness_options.

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


# ─── Bot Mode assembly integration ───────────────────────────────────────────
# Three read-only-ish endpoints that let the RepoCiv "assembly" view consume
# the Hermes Bot Mode roster as the single source of truth (no catalogue
# duplication). Design constraints (red-team, @cobalt / @user):
#   * The bridge NEVER writes profile.yaml / memberships / routines.
#   * Avatars live in Bot Mode plugin storage, NOT in profile.yaml, so the
#     bridge cannot synthesise an avatarUrl from ~/.hermes/profiles/<name>/*.
#     We therefore expose only a coarse, safe signal (avatar_kind) plus an
#     opt-in static asset for a known identity (DAVI), and let the frontend
#     fall back to its own AGENT_ICONS sprite. We never serve arbitrary
#     profile-internal files (path-traversal / metadata leak risk).
#   * Presence is best-effort and DERIVED from the bridge's own send log — we
#     do NOT proxy gateway RPCs (profiles.status is an MCP tool, not an HTTP
#     endpoint) and `hermes process list` does not exist.
# DAVI's known static render asset on the Windows host (verified present by
# red-team). Served by the bridge as a same-origin static file so the frontend
# never reaches into ~/.hermes/profiles or the Windows filesystem directly.
_DAVI_AVATAR = "/api/roster/asset/davi_avatar_render.png"

_roster_lock = _threading.Lock()
# name -> unix ts of last room message we relayed (best-effort presence)
_presence_last_send: dict[str, float] = {}
_PRESENCE_WINDOW = 90.0  # seconds; matches Bot Mode "active now" window

# room_name -> list of message dicts (best-effort relay log). Bounded so a
# chatty room can't grow this without bound. The bridge never reads the bot's
# own session store; it only keeps what it relayed itself (the authored
# message + the captured stdout response). No profile.yaml, no external state.
_room_messages: dict[str, list[dict]] = {}
_room_messages_lock = _threading.Lock()
_ROOM_HISTORY_MAX = 100
_ROOM_HISTORY_TTL = 3600.0  # seconds; drop messages older than this on read


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


def _record_presence(name: str) -> None:
    with _roster_lock:
        _presence_last_send[name] = time.time()


def get_presence(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/presence — best-effort "active now" derived from THIS bridge's
    own relay log (not gateway RPC). A bot is 'active' if this bridge relayed
    a room message for it within the last _PRESENCE_WINDOW seconds.

    Response 200: {
      "active": [name, ...],
      "since": {name: unix_ts, ...},
      "window_seconds": float,
      "derived": true
    }
    """
    now = time.time()
    with _roster_lock:
        active = [
            n for n, ts in _presence_last_send.items() if now - ts < _PRESENCE_WINDOW
        ]
        since = dict(_presence_last_send)
    return 200, {
        "active": active,
        "since": since,
        "window_seconds": _PRESENCE_WINDOW,
        "derived": True,
    }


def post_room_message(body: dict, ctx: "RouteContext") -> tuple[int, Any]:
    """POST /api/rooms/<name>/message — participate in a Bot Mode group chat.

    This is PARTICIPATION, not configuration: it shells out to the Hermes CLI
    bot chat (per-message handoff), isolated in its own route. It never writes
    profile.yaml, memberships, or routines. Mirrors the Bot Mode group-chat
    send described in hermes-bot-mode/SKILL.md.

    Body: {"message": str, "from_bot": str}
      message   — text to send into the room
      from_bot  — REQUIRED sender bot profile name (must be a real profile,
                  e.g. "davi", "lexo-alpha"). We deliberately do NOT default to
                  a fabricated profile ("user"/"hermes" are not real profiles,
                  see hermes profile list) — a missing from_bot is a 400, so the
                  caller (the assembly composer) must send a valid bot identity.
    Returns 200 {"ok": true, "relayed": true} or 4xx/5xx on failure.
    """
    name = str(ctx.get("room", "")).strip()
    if not name:
        return 400, {"ok": False, "error": "room name required"}
    message = str(body.get("message", "")).strip()
    if not message:
        return 400, {"ok": False, "error": "message required"}
    from_bot = str(body.get("from_bot") or "").strip()
    if not from_bot:
        # No fabricated default: a dead profile ("user"/"hermes") would make
        # the shell-out fail with a 502. Reject and let the caller supply a
        # real bot profile (the assembly composer always sends from_bot).
        return 400, {"ok": False, "error": "from_bot is required (a real bot profile)"}

    # Isolate the shell-out. We only ever invoke the hermes CLI bot-chat path;
    # never touch profile files. Validate the room name to a safe slug.
    if not all(ch.isalnum() or ch in "-_" for ch in name):
        return 400, {"ok": False, "error": "invalid room name"}
    if not all(ch.isalnum() or ch in "-_" for ch in from_bot):
        return 400, {"ok": False, "error": "invalid from_bot"}

    cli = [
        str(HERMES_CLI),
        "-p",
        from_bot,
        "chat",
        "--in",
        "~",
        "-c",
        name,
        "--create-if-missing",
        "-Q",
        "-q",
        f"Message from 🤖 {from_bot}: {message}",
    ]
    try:
        _record_presence(from_bot)
        # A real `hermes chat` agent turn (group chat send) can take well over
        # 30s to spin up and respond, so we give it a generous budget. This is
        # a best-effort relay, not a tight request/response.
        result = subprocess.run(cli, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return 504, {"ok": False, "error": "relay timed out (bot did not respond in 120s)"}
    except Exception as exc:  # noqa: BLE001
        return 500, {"ok": False, "error": f"relay failed: {exc}"}
    if result.returncode != 0:
        return 502, {"ok": False, "error": result.stderr.strip() or "relay failed"}

    # Capture the bot's authored message + its response text (from -Q stdout)
    # into the per-room relay log. The frontend reads this via
    # GET /api/rooms/{name}/messages to float bubbles over each pet. We never
    # read the bot's own session file; we only keep what we relayed ourselves.
    _append_room_message(
        name,
        from_bot,
        message,
        (result.stdout or "").strip(),
    )
    return 200, {"ok": True, "relayed": True}


def _append_room_message(room: str, sender: str, text: str, response: str) -> None:
    """Append a relayed exchange to the (bounded) per-room log."""
    msg = {
        "ts": time.time(),
        "room": room,
        "from": sender,
        "text": text,
        "response": response,
    }
    with _room_messages_lock:
        log = _room_messages.setdefault(room, [])
        log.append(msg)
        if len(log) > _ROOM_HISTORY_MAX:
            del log[: len(log) - _ROOM_HISTORY_MAX]


def get_room_messages(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/rooms/<name>/messages — best-effort relay log for a room.

    Read-only. Returns the exchanges this bridge relayed (authored message +
    captured bot response). Does NOT read the bot's session store, profile.yaml,
    or any file under ~/.hermes/profiles. Bounded by _ROOM_HISTORY_MAX and
    pruned by _ROOM_HISTORY_TTL on read. Auth-gated by the bridge (401 without
    token), same as the other assembly routes.
    """
    name = str(ctx.get("room", "")).strip()
    if not name:
        return 400, {"ok": False, "error": "room name required"}
    if not all(ch.isalnum() or ch in "-_" for ch in name):
        return 400, {"ok": False, "error": "invalid room name"}
    now = time.time()
    with _room_messages_lock:
        raw = _room_messages.get(name, [])
        msgs = [m for m in raw if now - float(m.get("ts", 0)) <= _ROOM_HISTORY_TTL]
        if len(msgs) != len(raw):
            _room_messages[name] = msgs
    return 200, {"room": name, "messages": msgs}


def get_providers_live(ctx: "RouteContext") -> tuple[int, Any]:
    """Fetch live model reachability from each provider's own API.

    Probes are run in parallel (ThreadPoolExecutor) and the result is cached
    for 30 s to avoid blocking the HTTP handler on every call.
    """
    global _providers_live_cache, _providers_live_ts

    now = time.time()
    if _providers_live_cache and now - _providers_live_ts < _PROVIDERS_CACHE_TTL:
        return 200, _providers_live_cache

    # ── 1. Resolve Hermes base URL ──
    hermes_url_raw = os.environ.get("HERMES_URL", "http://localhost:8642/v1")
    for suffix in ("/v1/chat/completions", "/v1/completions", "/v1", ""):
        if hermes_url_raw.endswith(suffix):
            hermes_url = hermes_url_raw[: -len(suffix)] if suffix else hermes_url_raw
            break
    else:
        hermes_url = hermes_url_raw

    hermes_headers: dict[str, str] = {}
    hermes_key = os.environ.get("HERMES_KEY", "")
    if hermes_key:
        hermes_headers["Authorization"] = f"Bearer {hermes_key}"

    # ── 2. Build probe map: all providers + hermes in one pass ──
    # Canonical Hermes slugs (post-v2.1); legacy aliases removed from the
    # probe set so a probe result for a slug is keyed by the canonical name
    # the new builder emits. Legacy aliases still resolve to env keys via
    # `_auth_headers` (above) for backward compat with persisted state.
    _PROVIDER_MODEL_ENDPOINTS = {
        "ollama-cloud": "https://api.ollama.com/v1/models",
        "openrouter":   "https://openrouter.ai/api/v1/models",
        "openai-api":   "https://api.openai.com/v1/models",
        "anthropic":    "https://api.anthropic.com/v1/models",
        "deepseek":     "https://api.deepseek.com/v1/models",
        "xai":          "https://api.x.ai/v1/models",
        "nvidia":       "https://integrate.api.nvidia.com/v1/models",
    }
    # Auto-extend from any provider declared in ~/.hermes/config.yaml with
    # a base_url ending in /v1 — that gives live probe for user-added
    # custom endpoints (and any future plugin provider). No-op if the
    # YAML doesn't expose a base_url for that provider.
    try:
        from server.provider_registry import _read_hermes_yaml
        _yaml_providers = (_read_hermes_yaml() or {}).get("providers", {}) or {}
        for _pid, _pcfg in _yaml_providers.items():
            if _pid in _PROVIDER_MODEL_ENDPOINTS:
                continue
            base = str((_pcfg or {}).get("base_url", "")).rstrip("/")
            if base.endswith("/v1"):
                _PROVIDER_MODEL_ENDPOINTS[_pid] = base + "/models"
    except Exception:
        logging.exception("[/providers/live] failed to extend endpoints from YAML")

    to_probe: dict[str, tuple[str, dict[str, str]]] = {
        "__hermes__": (f"{hermes_url}/v1/models", hermes_headers),
    }
    for pid, ep_url in _PROVIDER_MODEL_ENDPOINTS.items():
        to_probe[pid] = (ep_url, _auth_headers(pid))

    # ── 3. Run all probes in parallel — max wall-clock ≈ 6 s ──
    probe_results: dict[str, list[str]] = {}
    with ThreadPoolExecutor(max_workers=len(to_probe)) as pool:
        futures = {
            pool.submit(_probe_url, url, "GET", headers): pid
            for pid, (url, headers) in to_probe.items()
        }
        for future in as_completed(futures, timeout=6):
            pid = futures[future]
            try:
                probe_results[pid] = future.result()
            except Exception:
                probe_results[pid] = []

    hermes_models: set[str] = set(probe_results.pop("__hermes__", []))
    hermes_reachable = len(hermes_models) > 0
    provider_live = probe_results

    # ── 4. Merge with static provider registry ──
    from server.provider_registry import _get_chat_config, _hermes_models_payload
    chat_cfg = _get_chat_config()
    static_providers = {p["id"]: p for p in chat_cfg["providers"]}

    # Use Hermes' own model inventory as the source of truth for reachability.
    # The gateway /v1/models endpoint only returns the *active* model (usually
    # one), so the previous `hermes_models` fallback marked everything else as
    # unreachable even when Hermes can route to it. `build_models_payload` is
    # the same data Hermes' GUI pickers consume, so any model that appears
    # there is reachable by definition (Hermes is the actual inference path).
    #
    # Layered reachability:
    #   1. The provider's own live probe (if we have a URL for it)
    #   2. The active model list from the Hermes gateway
    #   3. The full Hermes model inventory (parity layer — covers all 44
    #      providers in build_models_payload, including ones without a probe)
    hermes_inventory: set[str] = set()
    try:
        payload = _hermes_models_payload() or {}
        for row in payload.get("providers", []) or []:
            for mid in row.get("models") or []:
                if mid:
                    hermes_inventory.add(mid)
    except Exception:
        logging.exception("[/providers/live] _hermes_models_payload failed")

    providers_out = []
    for pid, p in static_providers.items():
        live_ids = provider_live.get(pid, [])
        reachable_set = set(live_ids) | hermes_models | hermes_inventory

        models = []
        for m in p.get("models", []):
            mid = m.get("id", "")
            models.append({**m, "reachable": mid in reachable_set})

        known_ids = {m["id"] for m in models}
        for mid in live_ids:
            if mid not in known_ids:
                models.append({"id": mid, "name": mid, "harnesses": ["hermes", "openclaw"], "reachable": True})

        providers_out.append({
            "id": pid,
            "name": p["name"],
            "available": p["available"],
            "configured": p.get("configured", False),
            "defaultModel": p["defaultModel"],
            "models": models,
            "env": p.get("env", ""),
            "hermesReachable": hermes_reachable,
            "liveModelCount": len(live_ids),
        })

    response: dict = {
        "defaultProvider": chat_cfg["defaultProvider"],
        "hermesReachable": hermes_reachable,
        "hermesBaseUrl": hermes_url,
        "providers": providers_out,
    }
    _providers_live_cache = response
    _providers_live_ts = time.time()
    return 200, response

def get_log(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _es
    params = ctx.get("params", {})
    try:
        n = min(max(1, int(params.get("n", "100"))), 500)
        event_type_filter = params.get("type", "")
    except Exception:
        n, event_type_filter = 100, ""
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
    if cmd.type != "execute_agent":
        return None
    from server import agent_runner as _runner
    from server import repo_roots_state as _rrs

    payload = cmd.payload
    harness = str(payload.get("harness") or "").strip().lower()
    raw_repo = str(payload.get("repoPath") or "").strip()
    if not raw_repo:
        # Chat/hermes path: any unit may talk without a registered repoPath.
        # CLI harnesses (claude/cursor/codex/…) still require a selected repo.
        if harness in {"", "auto", "hermes"}:
            return None
        return "execute_agent requires repoPath for non-MAIN or CLI harnesses"
    selected = _rrs.resolve_selected_repo(str(payload.get("city") or cmd.target), raw_repo)
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

def post_pending_add(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_local import add_local_task
    title = str(body.get("title", "")).strip()
    priority = str(body.get("priority", "MEDIA")).upper()
    detail = str(body.get("detail", "")).strip()
    if priority not in ("ALTA", "MEDIA", "BAJA"):
        priority = "MEDIA"
    if not title:
        return 400, {"error": "title is required"}
    new_id = add_local_task(title, priority, detail)
    if new_id is None:
        return 409, {"error": "write error"}
    return 200, {"ok": True, "id": new_id, "title": title, "priority": priority, "source": "local"}

def post_pending_resolve(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_local import is_local_id, resolve_local_task
    from server.pending_tracker import resolve_pending_task
    item_id = str(body.get("id", "")).strip()
    if not item_id:
        return 400, {"error": "id is required"}
    ok = resolve_local_task(item_id) if is_local_id(item_id) else resolve_pending_task(item_id)
    if not ok:
        return 404, {"error": "item not found"}
    return 200, {"ok": True, "id": item_id}

def post_pending_edit(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_local import is_local_id, edit_local_task
    from server.pending_tracker import edit_pending_task
    item_id = str(body.get("id", "")).strip()
    title = body.get("title")
    priority = body.get("priority")
    detail = body.get("detail")
    if not item_id:
        return 400, {"error": "id is required"}
    if is_local_id(item_id):
        ok = edit_local_task(
            item_id,
            title=str(title).strip() if title else None,
            priority=str(priority).upper().strip() if priority else None,
            detail=str(detail) if detail else None,
        )
    else:
        ok = edit_pending_task(
            item_id,
            title=str(title).strip() if title else None,
            priority=str(priority).upper().strip() if priority else None,
            detail=str(detail) if detail else None,
        )
    if not ok:
        return 404, {"error": "item not found"}
    return 200, {"ok": True, "id": item_id}

def post_pending_delete(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_local import is_local_id, delete_local_task
    from server.pending_tracker import delete_pending_task
    item_id = str(body.get("id", "")).strip()
    if not item_id:
        return 400, {"error": "id is required"}
    ok = delete_local_task(item_id) if is_local_id(item_id) else delete_pending_task(item_id)
    if not ok:
        return 404, {"error": "item not found"}
    return 200, {"ok": True, "id": item_id}

def post_pending_state(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_local import is_local_id, change_local_state
    from server.pending_tracker import change_pending_state
    item_id = str(body.get("id", "")).strip()
    new_state = str(body.get("state", "")).strip()
    if not item_id or not new_state:
        return 400, {"error": "id and state are required"}
    ok = change_local_state(item_id, new_state) if is_local_id(item_id) else change_pending_state(item_id, new_state)
    if not ok:
        return 404, {"error": "item not found or invalid state"}
    return 200, {"ok": True, "id": item_id, "state": new_state}

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
