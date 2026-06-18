#!/usr/bin/env python3
"""RepoCiv — Wonder Registry (Python backend).

Static registry of Wonder manifests, served via the bridge.
Future: read ~/.repociv/wonders/*.json for user-defined Wonders.

Endpoints (wired in bridge.py):
    GET /wonders              — list all manifests
    GET /wonders/{id}/health  — health check for a specific Wonder
"""

from __future__ import annotations

import copy
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


_STATIC_WONDER_MANIFESTS: list[dict[str, Any]] = [
    {
        "id": "gaceta",
        "title": "La Gaceta Imperial",
        "kind": "native",
        "category": "news",
        "version": "0.1.0",
        "defaultEnabled": True,
        "automationLevel": "passive",
        "passiveMode": True,
        "agenticMode": False,
        "canSuggest": False,
        "canAct": False,
        "requiresConfirmation": False,
        "health": None,
        "ui": {},
        "permissions": {
            "readRepos": False,
            "writeRepos": False,
            "network": "none",
            "requiresApprovalForMutations": False,
        },
        "optionalFeatures": [
            {
                "id": "foreignRelationsReport",
                "label": "Informe de Relaciones Exteriores",
                "description": "Analiza cómo una noticia afecta una ciudad/repo usando agente",
                "defaultEnabled": False,
                "requiresUserOptIn": True,
            },
            {
                "id": "autoSummaries",
                "label": "Resúmenes automáticos",
                "description": "Resume noticias relevantes sin pedirlo explícitamente",
                "defaultEnabled": False,
                "requiresUserOptIn": True,
            },
        ],
        "actions": [
            {"id": "open", "label": "Abrir Gaceta", "risk": "safe", "requiresUserOptIn": False},
            {
                "id": "foreign_relations_report",
                "label": "Informe de Relaciones Exteriores",
                "risk": "safe",
                "requiresUserOptIn": True,
            },
        ],
        "events": {"emits": ["wonder.ready", "wonder.report.created"], "accepts": ["repociv.focus_city"]},
        "mcp": {"enabled": False, "server": None},
    },
    # NOTE: Bibliotheca and Institutum/LabHub are no longer built-in. They are
    # connectable EXAMPLES (see src/wonders/exampleTemplates.ts). Out-of-the-box
    # only La Gaceta (native) is registered; the user connects iframe wonders via
    # POST /api/wonders/connect, which writes ~/.repociv/wonders/<id>.json picked
    # up by _load_custom_manifests() below.
]


_REQUIRED_TOP_LEVEL_KEYS = {
    "id",
    "title",
    "kind",
    "category",
    "version",
    "defaultEnabled",
    "ui",
    "permissions",
    "automationLevel",
    "optionalFeatures",
    "actions",
    "events",
    "mcp",
}


def _is_valid_manifest(manifest: Any) -> bool:
    if not isinstance(manifest, dict):
        return False
    if not _REQUIRED_TOP_LEVEL_KEYS.issubset(manifest.keys()):
        return False
    return bool(manifest.get("id")) and bool(manifest.get("title"))


def _custom_manifest_dir() -> Path:
    env_dir = os.environ.get("REPOCIV_WONDERS_DIR", "").strip()
    if env_dir:
        return Path(env_dir).expanduser()
    return Path.home() / ".repociv" / "wonders"


def _load_custom_manifests() -> list[dict[str, Any]]:
    base = _custom_manifest_dir()
    if not base.exists() or not base.is_dir():
        return []

    loaded: list[dict[str, Any]] = []
    for path in sorted(base.glob("*.json")):
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if _is_valid_manifest(manifest):
            loaded.append(manifest)
    return loaded


def _build_registry() -> dict[str, dict[str, Any]]:
    registry: dict[str, dict[str, Any]] = {
        m["id"]: copy.deepcopy(m)
        for m in _STATIC_WONDER_MANIFESTS
        if _is_valid_manifest(m)
    }
    for custom in _load_custom_manifests():
        registry[custom["id"]] = copy.deepcopy(custom)
    return registry


def list_wonders() -> list[dict[str, Any]]:
    """Return all registered Wonder manifests (copy for safety)."""
    return list(_build_registry().values())


def get_wonder(wonder_id: str) -> dict[str, Any] | None:
    """Return a single Wonder manifest by id, or None."""
    return _build_registry().get(wonder_id)


# ─── Connect / disconnect (user-defined wonders) ──────────────────────────────

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def _sanitize_id(raw: Any) -> str | None:
    """Lowercase, allowlist-checked id. Blocks path traversal / weird chars."""
    if not isinstance(raw, str):
        return None
    rid = raw.strip().lower()
    return rid if _ID_RE.match(rid) else None


def _expand_launch_paths(manifest: dict[str, Any]) -> None:
    """Expand ~ and $ENV in launch.repo_dir + procs[].cwd in-place.

    The launcher uses these paths verbatim (``Path(repo_dir)``), so we resolve
    them server-side where $HOME is known. No-op when there is no launch block.
    """
    launch = manifest.get("launch")
    if not isinstance(launch, dict):
        return
    rd = launch.get("repo_dir")
    if isinstance(rd, str) and rd:
        launch["repo_dir"] = os.path.expanduser(os.path.expandvars(rd))
    procs = launch.get("procs")
    if isinstance(procs, list):
        for p in procs:
            if isinstance(p, dict) and isinstance(p.get("cwd"), str) and p["cwd"]:
                p["cwd"] = os.path.expanduser(os.path.expandvars(p["cwd"]))


def save_custom_manifest(manifest: Any) -> tuple[dict[str, Any] | None, str | None]:
    """Validate + persist a connected wonder to ~/.repociv/wonders/<id>.json.

    Returns ``(manifest, None)`` on success or ``(None, reason)`` on validation
    failure. Never raises on bad input — the route maps the reason to a 4xx.
    """
    if not isinstance(manifest, dict):
        return None, "manifest must be a JSON object"
    rid = _sanitize_id(manifest.get("id"))
    if not rid:
        return None, "invalid id (use [a-z0-9_-], max 64 chars, leading alnum)"
    manifest = copy.deepcopy(manifest)
    manifest["id"] = rid
    if not _is_valid_manifest(manifest):
        missing = sorted(_REQUIRED_TOP_LEVEL_KEYS - set(manifest.keys()))
        return None, f"manifest missing required fields: {missing}"
    _expand_launch_paths(manifest)
    base = _custom_manifest_dir()
    base.mkdir(parents=True, exist_ok=True)
    path = base / f"{rid}.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    return manifest, None


def delete_custom_manifest(wonder_id: Any) -> tuple[bool, str | None]:
    """Remove ~/.repociv/wonders/<id>.json. Only touches the custom dir —
    built-in manifests (gaceta) live in code and cannot be deleted here."""
    rid = _sanitize_id(wonder_id)
    if not rid:
        return False, "invalid id"
    path = _custom_manifest_dir() / f"{rid}.json"
    if not path.exists():
        return False, "not connected"
    try:
        path.unlink()
    except OSError as e:
        return False, str(e)
    return True, None


def check_wonder_health(wonder_id: str) -> dict[str, Any]:
    """Probe the health endpoint of a Wonder and return detailed status."""
    manifest = get_wonder(wonder_id)
    if not manifest:
        return {"id": wonder_id, "status": "unknown", "error": "not_found"}

    health_config = manifest.get("health")
    if not health_config:
        return {"id": wonder_id, "status": "native", "note": "no_health_endpoint"}

    url = str(health_config.get("url", "")).strip()
    timeout_ms = int(health_config.get("timeoutMs", 4000) or 4000)
    degraded_allowed = bool(health_config.get("degradedAllowed", False))
    timeout_s = timeout_ms / 1000.0

    if not url:
        return {"id": wonder_id, "status": "native", "note": "no_health_url"}

    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            if resp.status >= 500:
                return {
                    "id": wonder_id,
                    "status": "degraded" if degraded_allowed else "offline",
                    "httpStatus": resp.status,
                    "url": url,
                    "degradedAllowed": degraded_allowed,
                }
            return {"id": wonder_id, "status": "ok", "httpStatus": resp.status, "url": url}
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return {"id": wonder_id, "status": "no-permissions", "httpStatus": exc.code, "url": url}
        if exc.code >= 500:
            return {
                "id": wonder_id,
                "status": "degraded" if degraded_allowed else "offline",
                "httpStatus": exc.code,
                "url": url,
                "degradedAllowed": degraded_allowed,
            }
        return {"id": wonder_id, "status": "offline", "httpStatus": exc.code, "url": url}
    except TimeoutError:
        return {"id": wonder_id, "status": "timeout", "url": url, "timeoutMs": timeout_ms}
    except Exception as exc:
        return {"id": wonder_id, "status": "unreachable", "error": str(exc), "url": url}
