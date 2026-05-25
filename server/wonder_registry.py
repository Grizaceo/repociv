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
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def _env(name: str, fallback: str) -> str:
    return os.environ.get(name, fallback)


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
    {
        "id": "bibliotheca",
        "title": "Bibliotheca Alexandrina",
        "kind": "iframe",
        "category": "knowledge",
        "version": "0.1.0",
        "defaultEnabled": True,
        "automationLevel": "passive",
        "passiveMode": True,
        "agenticMode": False,
        "canSuggest": True,
        "canAct": False,
        "requiresConfirmation": True,
        "health": {
            "url": _env("VITE_LGB_BACKEND_URL", "http://127.0.0.1:3001") + "/api/health",
            "timeoutMs": 4000,
            "degradedAllowed": True,
        },
        "ui": {
            "url": _env("VITE_WONDER_BIBLIOTHECA_URL", "http://127.0.0.1:5173"),
            "preferredWidth": "70vw",
            "preferredHeight": "75vh",
            "sandbox": ["allow-scripts", "allow-same-origin", "allow-forms"],
        },
        "permissions": {
            "readRepos": True,
            "writeRepos": False,
            "network": "loopback-only",
            "requiresApprovalForMutations": True,
        },
        "optionalFeatures": [
            {
                "id": "graphSuggestions",
                "label": "Sugerencias de relaciones",
                "description": "El agente Astrónomo sugiere conexiones entre nodos",
                "defaultEnabled": False,
                "requiresUserOptIn": True,
            },
            {
                "id": "aiRelationDiscovery",
                "label": "Descubrimiento AI de relaciones",
                "description": "Usa grafo offline para encontrar vínculos no obvios entre repos",
                "defaultEnabled": False,
                "requiresUserOptIn": True,
            },
        ],
        "actions": [
            {"id": "open", "label": "Entrar", "risk": "safe", "requiresUserOptIn": False},
            {"id": "ask_agent", "label": "Preguntar a agente", "risk": "safe", "requiresUserOptIn": True},
        ],
        "events": {
            "emits": ["wonder.ready", "wonder.selection", "wonder.report.created"],
            "accepts": ["repociv.focus_city", "repociv.open_local_view"],
        },
        "mcp": {"enabled": False, "server": None},
    },
    {
        "id": "institutum",
        "title": "Institutum Laboratorium / LabHub",
        "kind": "iframe",
        "category": "lab",
        "version": "0.1.0",
        "defaultEnabled": True,
        "automationLevel": "assist",
        "passiveMode": True,
        "agenticMode": True,
        "canSuggest": True,
        "canAct": False,
        "requiresConfirmation": True,
        "health": {
            "url": _env("VITE_WONDER_INSTITUTUM_API_URL", "http://localhost:5281") + "/health",
            "timeoutMs": 4000,
            "degradedAllowed": True,
        },
        "ui": {
            "url": _env("VITE_WONDER_INSTITUTUM_URL", "http://localhost:5280"),
            "preferredWidth": "70vw",
            "preferredHeight": "75vh",
            "sandbox": ["allow-scripts", "allow-same-origin", "allow-forms"],
        },
        "permissions": {
            "readRepos": False,
            "writeRepos": False,
            "network": "loopback-only",
            "requiresApprovalForMutations": True,
        },
        "optionalFeatures": [
            {
                "id": "hardLocks",
                "label": "Bloqueos duros",
                "description": "Impide completamente la edición de ciudades con experimentos críticos",
                "defaultEnabled": False,
                "requiresUserOptIn": True,
            }
        ],
        "actions": [
            {"id": "open", "label": "Abrir Institutum", "risk": "safe", "requiresUserOptIn": False},
            {
                "id": "kill_experiment",
                "label": "Detener experimento",
                "risk": "manual",
                "requiresUserOptIn": True,
            },
        ],
        "events": {
            "emits": ["wonder.ready", "labhub.experiment.started", "labhub.experiment.finished"],
            "accepts": ["repociv.focus_city"],
        },
        "mcp": {"enabled": False, "server": None},
    },
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
