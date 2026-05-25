"""RepoCiv — LabHub Status Adapter (Fase 5A).

Contract real de status vivo para Institutum/LabHub.
Probes http://localhost:5281/health (Institutum backend).
If online, returns actual lab status per city.
If offline, degrades to local inference (existing inference logic).

Design:
- City-level status fetched on-demand (not cached — liveness sensitive)
- Each probe is lightweight (HEAD + timeout 4s)
- Fallback source='inferred' is explicit and marked in the response
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

# ─── Helpers ──────────────────────────────────────────────────────────────────

INSTITUTUM_API_URL: str = os.environ.get(
    "VITE_WONDER_INSTITUTUM_API_URL",
    "http://localhost:5281",
).rstrip("/")

HEALTH_ENDPOINT = f"{INSTITUTUM_API_URL}/health"
DEFAULT_TIMEOUT_S = 4.0


def _build_labhub_health_url() -> str:
    return HEALTH_ENDPOINT


def _probe_institutum() -> dict[str, Any] | None:
    """Probe Institutum /health and return parsed response, or None if offline."""
    url = _build_labhub_health_url()
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT_S) as resp:
            if resp.status >= 400:
                return None
            raw = resp.read()
            body: dict[str, Any] = json.loads(raw.decode("utf-8"))
            return body
    except (urllib.error.URLError, urllib.error.HTTPError,
            TimeoutError, OSError, json.JSONDecodeError, ValueError):
        return None


def _extract_experiments_from_health(body: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Extract experiment list from Institutum health response.

    Institutum health shape expected:
      { "status": "ok", "labs": [{ "id", "cityId", "status", ... }] }
    or
      { "experiments": [{"cityId": "...", "status": "running", ...}] }
    Returns empty list if no lab data.
    """
    if not body or not isinstance(body, dict):
        return []

    # Try various response shapes
    labs = body.get("labs") or body.get("experiments") or body.get("activeLabs") or []
    if isinstance(labs, list):
        return labs

    # Single lab response
    if body.get("labId") or body.get("id"):
        return [body]

    return []


# ─── Public API ───────────────────────────────────────────────────────────────


def get_labhub_overall_status() -> dict[str, Any]:
    """Return overall Institutum health regardless of specific labs.

    Returns:
      { "online": bool, "source": "live"|"inferred",
        "health": {...}|None, "error": str|None }
    """
    body = _probe_institutum()
    if body is None:
        return {
            "online": False,
            "source": "inferred",
            "health": None,
            "error": "Institutum offline",
        }
    return {
        "online": True,
        "source": "live",
        "health": body,
        "error": None,
    }


def get_city_lab_status(
    city_id: str,
    repo_path: str | None = None,
    *,
    active_buildings: list[dict[str, Any]] | None = None,
    active_units: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return lab status for a single city.

    First tries Institutum real endpoint.
    Falls back to local inference if Institutum is offline
    or doesn't have data for this city.

    Args:
        city_id: The city/repo identifier.
        repo_path: Filesystem path for log link derivation.
        active_buildings: List of building dicts for inference fallback.
        active_units: List of unit dicts for inference fallback.

    Returns a CityLabStatus dict:
      {
        "cityId": str,
        "labId": str,
        "status": "idle"|"running",
        "risk": "low"|"medium"|"high",
        "writeLock": bool,
        "lastMetric": str,
        "startedAt": str|null,
        "links": {"labhub": str|null, "logs": str|null},
        "source": "live"|"inferred",
        "institutumOnline": bool,
      }
    """
    body = _probe_institutum()

    # Try real contract first
    if body is not None:
        experiments = _extract_experiments_from_health(body)
        # Find experiment for this city
        for exp in experiments:
            exp_city = (exp.get("cityId") or exp.get("city") or exp.get("repo") or "").lower()
            if exp_city == city_id.lower() or exp_city == repo_path or "":
                lab_id = exp.get("id") or exp.get("labId") or f"{city_id}-live"
                exp_status = exp.get("status", "running")
                risk_str = exp.get("risk", "medium")
                write_lock = bool(exp.get("writeLock", False))
                last_metric = exp.get("lastMetric") or exp.get("metric") or exp.get("description", "")
                started = exp.get("startedAt") or exp.get("startTime") or None
                return {
                    "cityId": city_id,
                    "labId": lab_id,
                    "status": "running" if exp_status in ("running", "active", "building") else "idle",
                    "risk": risk_str if risk_str in ("low", "medium", "high") else "medium",
                    "writeLock": write_lock,
                    "lastMetric": str(last_metric) if last_metric else "Sin métrica",
                    "startedAt": started,
                    "links": {
                        "labhub": INSTITUTUM_API_URL,
                        "logs": _logs_path_for_repo(repo_path),
                    },
                    "source": "live",
                    "institutumOnline": True,
                }

        # Institutum is online but has no data for this city
        return {
            "cityId": city_id,
            "labId": "",
            "status": "idle",
            "risk": "low",
            "writeLock": False,
            "lastMetric": "Institutum online, sin experimento para esta ciudad",
            "startedAt": None,
            "links": {
                "labhub": INSTITUTUM_API_URL,
                "logs": _logs_path_for_repo(repo_path),
            },
            "source": "live",
            "institutumOnline": True,
        }

    # Institutum offline → fallback to local inference
    inferred = _infer_local_status(city_id, active_buildings or [], active_units or [])
    inferred["institutumOnline"] = False
    inferred["links"] = {
        "labhub": INSTITUTUM_API_URL if _probe_institutum() else None,
        "logs": _logs_path_for_repo(repo_path),
    }
    return inferred


def get_all_cities_lab_status(
    cities: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Get lab status for all cities in one call.

    Probes Institutum once, then maps results to each city.
    """
    # Probe once
    body = _probe_institutum()
    experiments: list[dict[str, Any]] = []
    institutum_online = body is not None
    if body is not None:
        experiments = _extract_experiments_from_health(body)

    results: list[dict[str, Any]] = []
    for city in cities:
        city_id = city.get("id", "")
        repo_path = city.get("repoPath") or city.get("name", "")
        labhub_url = INSTITUTUM_API_URL if institutum_online else None

        if institutum_online:
            # Match experiment
            matched = None
            for exp in experiments:
                exp_city = (exp.get("cityId") or exp.get("city") or exp.get("repo") or "").lower()
                if exp_city == city_id.lower() or exp_city == repo_path.lower():
                    matched = exp
                    break
            if matched:
                lab_id = matched.get("id") or matched.get("labId") or f"{city_id}-live"
                exp_status = matched.get("status", "running")
                risk_str = matched.get("risk", "medium")
                write_lock = bool(matched.get("writeLock", False))
                last_metric = matched.get("lastMetric") or matched.get("metric") or matched.get("description", "")
                started = matched.get("startedAt") or matched.get("startTime") or None
                results.append({
                    "cityId": city_id,
                    "labId": lab_id,
                    "status": "running" if exp_status in ("running", "active", "building") else "idle",
                    "risk": risk_str if risk_str in ("low", "medium", "high") else "medium",
                    "writeLock": write_lock,
                    "lastMetric": str(last_metric) if last_metric else "Sin métrica",
                    "startedAt": started,
                    "links": {"labhub": labhub_url, "logs": _logs_path_for_repo(repo_path)},
                    "source": "live",
                    "institutumOnline": True,
                })
            else:
                results.append({
                    "cityId": city_id,
                    "labId": "",
                    "status": "idle",
                    "risk": "low",
                    "writeLock": False,
                    "lastMetric": "Sin experimento activo",
                    "startedAt": None,
                    "links": {"labhub": labhub_url, "logs": _logs_path_for_repo(repo_path)},
                    "source": "live",
                    "institutumOnline": True,
                })
        else:
            # Offline — infer for each city
            inferred = _infer_local_status(
                city_id,
                city.get("activeBuildings", []),
                city.get("activeUnits", []),
            )
            inferred["institutumOnline"] = False
            inferred["links"] = {"labhub": None, "logs": _logs_path_for_repo(repo_path)}
            results.append(inferred)

    return results


# ─── Local Inference Fallback ─────────────────────────────────────────────────


def _infer_local_status(
    city_id: str,
    active_buildings: list[dict[str, Any]],
    active_units: list[dict[str, Any]],
) -> dict[str, Any]:
    """Infer lab status from local game state (fallback when Institutum is offline).

    Mirrors the logic from labhubStatus.ts inferCityLabStatus.
    """
    if not active_buildings and not active_units:
        return {
            "cityId": city_id,
            "labId": "",
            "status": "idle",
            "risk": "low",
            "writeLock": False,
            "lastMetric": "Sin experimento activo (inferido local)",
            "startedAt": None,
            "links": {"labhub": None, "logs": None},
            "source": "inferred",
        }

    first_building = active_buildings[0] if active_buildings else None
    first_unit = active_units[0] if active_units else None
    lab_id = (first_building or first_unit or {}).get("id", f"{city_id}-active") or f"{city_id}-active"

    num_buildings = len(active_buildings)
    num_units = len(active_units)

    if num_buildings >= 2 or num_units >= 2:
        risk = "high"
    elif num_buildings >= 1 or num_units >= 1:
        risk = "medium"
    else:
        risk = "low"

    last_metric_parts = []
    if num_buildings > 0:
        last_metric_parts.append(f"{num_buildings} build(s) activas")
    if num_units > 0:
        last_metric_parts.append(f"{num_units} unidad(es) trabajando")
    if first_building:
        last_metric_parts.append(f"principal={first_building.get('name', '?')}")

    started_at = None
    if first_building:
        st = first_building.get("sourceProcess", {}).get("startTime") if isinstance(first_building.get("sourceProcess"), dict) else None
        if isinstance(st, (int, float)) and st > 0:
            started_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(st))

    return {
        "cityId": city_id,
        "labId": lab_id,
        "status": "running" if (num_buildings > 0 or num_units > 0) else "idle",
        "risk": risk,
        "writeLock": False,
        "lastMetric": " · ".join(last_metric_parts) if last_metric_parts else "Actividad detectada",
        "startedAt": started_at,
        "links": {"labhub": None, "logs": None},
        "source": "inferred",
    }


def _logs_path_for_repo(repo_path: str | None) -> str | None:
    """Derive logs path from repo path."""
    if not repo_path or not repo_path.strip():
        return None
    return f"{repo_path.strip()}/logs"
