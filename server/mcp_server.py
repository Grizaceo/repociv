"""RepoCiv MCP Server — stdio transport.

Exposes the bridge HTTP API (~30 endpoints) as MCP tools para que agentes
externos (Claude Code, Cursor, Codex CLI) operen el dashboard sin curl-ear
el bridge directamente.

Uso:
    python -m server.mcp_server          # stdio (Claude Code / Cursor)
    python server/mcp_server.py          # directo

Registro en ~/.claude.json:
    {
      "mcpServers": {
        "repociv": {
          "command": "python",
          "args": ["/path/to/repociv/server/mcp_server.py"]
        }
      }
    }
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

# ─── Env loader (inline para evitar side-effects de importar bridge.py) ───────

def _load_dotenv() -> None:
    for p in [Path(__file__).parent.parent / ".env", Path.home() / ".hermes" / ".env"]:
        if not p.exists():
            continue
        try:
            for raw in p.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
        except Exception:
            pass


_load_dotenv()

BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "5274"))
BRIDGE_BASE = f"http://127.0.0.1:{BRIDGE_PORT}"
TOKEN = os.environ.get("REPOCIV_TOKEN", "")

# ─── HTTP helper ─────────────────────────────────────────────────────────────

_BRIDGE_DOWN = f"RepoCiv bridge no responde en :{BRIDGE_PORT} — ejecuta `npm start`"


def _headers(mutating: bool = False) -> dict[str, str]:
    h: dict[str, str] = {"Accept": "application/json"}
    if mutating:
        if not TOKEN:
            raise ValueError("REPOCIV_TOKEN no configurado — mutating tools requieren token")
        h["X-RepoCiv-Token"] = TOKEN
        h["Content-Type"] = "application/json"
    return h


def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    url = BRIDGE_BASE + path
    try:
        r = httpx.get(url, params=params, headers=_headers(False), timeout=10)
        r.raise_for_status()
        return r.json()
    except httpx.ConnectError:
        raise RuntimeError(_BRIDGE_DOWN)
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"Bridge error {e.response.status_code}: {e.response.text[:300]}")


def _post(path: str, body: dict[str, Any] | None = None) -> Any:
    url = BRIDGE_BASE + path
    try:
        r = httpx.post(url, content=json.dumps(body or {}), headers=_headers(True), timeout=10)
        r.raise_for_status()
        return r.json()
    except httpx.ConnectError:
        raise RuntimeError(_BRIDGE_DOWN)
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"Bridge error {e.response.status_code}: {e.response.text[:300]}")


# ─── MCP Server ───────────────────────────────────────────────────────────────

mcp = FastMCP(
    "repociv",
    instructions=(
        "RepoCiv — dashboard de agentes Civ V. "
        "Tools marcadas con [MUTATES] modifican estado y requieren REPOCIV_TOKEN configurado. "
        "Commands con risk=high caen en cola de approvals — usa approval_approve para liberar."
    ),
)

# ══════════════════════════════════════════════════════════════════════════════
# AGENTS
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description="Lista todos los agentes desplegados con su estado, heartbeat y profundidad de cola.")
def agents_list() -> Any:
    return _get("/agents")


@mcp.tool(description="Devuelve la matriz de capacidades por tipo de agente (MAIN, WORKER, SCOUT, CLAUDE, CODEX, OPENCLAW; CURSOR si está configurado).")
def agents_capabilities() -> Any:
    return _get("/agents/capabilities")


@mcp.tool(description="Health check del bridge: versión, agentes activos, GPU, comandos en cola.")
def agents_health() -> Any:
    return _get("/health")


@mcp.tool(description="Readiness probe: confirma que el event store y token están listos.")
def agents_ready() -> Any:
    return _get("/ready")


# ══════════════════════════════════════════════════════════════════════════════
# COMMANDS  [MUTATES]
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description=(
    "[MUTATES] Envía un Command al bus de RepoCiv. "
    "type: inspect_repo|read_file|run_tests|run_build|edit_file|create_branch|git_commit|delete_file|execute_agent|send_message. "
    "risk: low|medium|high|destructive. Commands con risk=high o destructive van a /approvals primero."
))
def command_submit(
    type: str,
    target: str,
    payload: dict[str, Any] | None = None,
    created_by: str = "mcp",
    risk: str | None = None,
) -> Any:
    body: dict[str, Any] = {"type": type, "target": target, "created_by": created_by}
    if payload:
        body["payload"] = payload
    if risk:
        body["risk"] = risk
    return _post("/commands", body)


@mcp.tool(description="[MUTATES] Cancela un comando en estado queued o waiting_approval.")
def command_cancel(id: str) -> Any:
    return _post(f"/commands/{id}/cancel")


# ══════════════════════════════════════════════════════════════════════════════
# MISSIONS
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description="Lista todas las misiones persistidas (historial de ejecuciones de agentes).")
def missions_list() -> Any:
    return _get("/missions")


@mcp.tool(description="Devuelve los últimos N eventos del event log. type filtra por tipo de evento.")
def missions_log(n: int = 50, type: str | None = None) -> Any:
    params: dict[str, Any] = {"n": n}
    if type:
        params["type"] = type
    return _get("/log", params)


# ══════════════════════════════════════════════════════════════════════════════
# APPROVALS  [MUTATES parcial]
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description="Lista comandos en espera de aprobación (risk=high o destructive).")
def approvals_list() -> Any:
    return _get("/approvals")


@mcp.tool(description="[MUTATES] Aprueba y despacha un comando en cola de aprobación.")
def approval_approve(id: str) -> Any:
    return _post(f"/approvals/{id}/approve")


@mcp.tool(description="[MUTATES] Rechaza un comando en cola de aprobación.")
def approval_reject(id: str) -> Any:
    return _post(f"/approvals/{id}/reject")


# ══════════════════════════════════════════════════════════════════════════════
# PENDING TASKS  [MUTATES parcial]
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description="Lista todas las tareas pendientes con id, título, prioridad y estado.")
def pending_list() -> Any:
    return _get("/pending")


@mcp.tool(description="[MUTATES] Crea una nueva tarea pendiente. priority: low|medium|high.")
def pending_add(title: str, priority: str = "medium") -> Any:
    return _post("/pending/add", {"title": title, "priority": priority})


@mcp.tool(description="[MUTATES] Marca una tarea pendiente como resuelta.")
def pending_resolve(id: str) -> Any:
    return _post("/pending/resolve", {"id": id})


@mcp.tool(description="[MUTATES] Edita campos de una tarea pendiente (title, priority, detail).")
def pending_edit(
    id: str,
    title: str | None = None,
    priority: str | None = None,
    detail: str | None = None,
) -> Any:
    body: dict[str, Any] = {"id": id}
    if title is not None:
        body["title"] = title
    if priority is not None:
        body["priority"] = priority
    if detail is not None:
        body["detail"] = detail
    return _post("/pending/edit", body)


@mcp.tool(description="[MUTATES] Cambia el estado de una tarea pendiente (e.g. 'in_progress', 'blocked').")
def pending_state(id: str, state: str) -> Any:
    return _post("/pending/state", {"id": id, "state": state})


@mcp.tool(description="[MUTATES] Elimina una tarea pendiente.")
def pending_delete(id: str) -> Any:
    return _post("/pending/delete", {"id": id})


# ══════════════════════════════════════════════════════════════════════════════
# CONTEXT / FATIGUE (XCOM)
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description="Estado de fatiga y áreas de descanso (sistema XCOM): por unidad → fatigue int, rest areas.")
def context_fatigue() -> Any:
    return _get("/context")


# ══════════════════════════════════════════════════════════════════════════════
# OBSERVABILITY
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description="Estado de GPU: VRAM usada/total, temperatura (via nvidia-smi). Null si no hay GPU.")
def gpu_status() -> Any:
    return _get("/gpu")


@mcp.tool(description="Snapshot de métricas de observabilidad: throughput, latencia, profundidad de cola, circuitos abiertos.")
def metrics_snapshot() -> Any:
    return _get("/metrics")


# ══════════════════════════════════════════════════════════════════════════════
# SELF-IMPROVEMENT / SICA
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description="SICA: patrones de comportamiento observados con confianza y evidencia.")
def improve_reflect() -> Any:
    return _get("/improve/reflect")


@mcp.tool(description="SICA: propuestas de mejora scopeadas y schema-valid pendientes de revisión.")
def improve_proposals() -> Any:
    return _get("/improve/proposals")


# ══════════════════════════════════════════════════════════════════════════════
# PROVIDERS & HARNESSES  [MUTATES parcial]
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description="Lista proveedores de modelos configurados y config de chat (Hermes fallback).")
def providers_list() -> Any:
    return _get("/providers")


@mcp.tool(description="Prueba alcanzabilidad en vivo de cada proveedor y sus modelos.")
def providers_live() -> Any:
    return _get("/providers/live")


@mcp.tool(description="Lista harnesses disponibles incluyendo claude-code-local y codex-local (7 total en alpha).")
def harnesses_list() -> Any:
    return _get("/harnesses")


@mcp.tool(description=(
    "[MUTATES] Genera un plan de recovery para un harness caído. "
    "harness_id: hermes-local|claude-code-local|codex-local|openclaw-local|docker-agent|lexo-local|hermes-remote. "
    "command_type: uno de los CommandType válidos."
))
def harness_recovery(
    harness_id: str,
    reason: str,
    command_type: str,
    target: str,
    details: str = "",
) -> Any:
    return _post(
        f"/harnesses/{harness_id}/recovery-command",
        {"reason": reason, "command_type": command_type, "target": target, "details": details},
    )


# ══════════════════════════════════════════════════════════════════════════════
# TASKS (P3 orchestration)  [MUTATES parcial]
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description="Lista todas las tareas de orquestación P3 activas.")
def tasks_list() -> Any:
    return _get("/tasks")


@mcp.tool(description="Estado detallado de una tarea P3 específica (repo + issue_id).")
def task_get(repo: str, issue_id: str) -> Any:
    return _get(f"/tasks/{repo}/{issue_id}")


@mcp.tool(description="[MUTATES] Cancela la ejecución de una tarea P3 activa.")
def task_cancel(repo: str, issue_id: str) -> Any:
    return _post(f"/tasks/{repo}/{issue_id}/cancel")


# ══════════════════════════════════════════════════════════════════════════════
# DIRECTIVES  [MUTATES parcial]
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description="Estadísticas de directivas aprendidas: conteos, confianza promedio, patrones dominantes.")
def directives_stats() -> Any:
    return _get("/directives/stats")


@mcp.tool(description="Sugerencias de directiva para un gesto/agente dado. repo_type es opcional.")
def directives_suggest(gesture: str, agent: str, repo_type: str = "") -> Any:
    params: dict[str, Any] = {"gesture": gesture, "agent": agent}
    if repo_type:
        params["repoType"] = repo_type
    return _get("/directives/suggest", params)


@mcp.tool(description="[MUTATES] Registra el resultado de un gesto para refinar el aprendizaje de directivas.")
def directive_record(
    command_id: str,
    gesture: str,
    agent_id: str,
    cmd_type: str,
    target: str,
    extra: dict[str, Any] | None = None,
) -> Any:
    body: dict[str, Any] = {
        "commandId": command_id,
        "gesture": gesture,
        "agentId": agent_id,
        "cmdType": cmd_type,
        "target": target,
    }
    if extra:
        body["extra"] = extra
    return _post("/directives/record", body)


# ══════════════════════════════════════════════════════════════════════════════
# EVENTS
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description=(
    "Replay del event store desde un timestamp Unix. "
    "since=0 devuelve todos los eventos. "
    "Para polling en vivo, llama repetidamente con el timestamp del último evento recibido."
))
def events_since(since_unix_ts: float = 0) -> Any:
    return _get("/events", {"since": since_unix_ts})


# ══════════════════════════════════════════════════════════════════════════════
# WEBSOCKET INFO
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description="Metadata del WebSocket del bridge (URL, puerto, protocolo). El cliente abre WS por su cuenta si necesita streaming.")
def ws_info() -> Any:
    return _get("/ws")


# ══════════════════════════════════════════════════════════════════════════════
# WONDERS
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description="Lista todas las Maravillas registradas con su estado y configuración.")
def wonders_list() -> Any:
    return _get("/api/wonders")


@mcp.tool(description="Devuelve el manifiesto completo de una Maravilla por ID (ej: 'bibliotheca', 'gaceta', 'institutum').")
def wonders_get(wonder_id: str) -> Any:
    return _get(f"/api/wonders/{wonder_id}")


@mcp.tool(description="Health check de una Maravilla: iframe accesible, puerto activo, latencia.")
def wonder_health(wonder_id: str) -> Any:
    return _get(f"/api/wonders/{wonder_id}/health")


# ══════════════════════════════════════════════════════════════════════════════
# GRAPH RELATIONS
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description=(
    "Devuelve relaciones candidatas para una ciudad/repo. "
    "repo_id: identificador del repo (slug del path). "
    "limit: máximo de candidatos (default 20). "
    "min_score: score mínimo de relevancia 0-1 (default 0.1)."
))
def graph_relations_list(repo_id: str, limit: int = 20, min_score: float = 0.1) -> Any:
    return _get("/api/graph-relations", {"repoId": repo_id, "limit": limit, "minScore": min_score})


@mcp.tool(description=(
    "Evidencia de relación entre dos repos: imports compartidos, deps comunes, "
    "entidades co-referenciadas. source_id y target_id son slugs del path."
))
def graph_relations_evidence(source_id: str, target_id: str) -> Any:
    return _get("/api/graph-relations/evidence", {"sourceId": source_id, "targetId": target_id})


@mcp.tool(description="Estadísticas del índice de relaciones: repos indexados, total de edges, última actualización.")
def graph_relations_stats() -> Any:
    return _get("/api/graph-relations/stats")


# ══════════════════════════════════════════════════════════════════════════════
# FOREIGN RELATIONS
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool(description=(
    "Perfil de un repo: stack detectado, tipo de proyecto, entidades clave, "
    "señales de actividad. repo_path: ruta absoluta al repo."
))
def foreign_repo_profile(repo_path: str) -> Any:
    return _get("/api/foreign/repo-profile", {"repoPath": repo_path})


@mcp.tool(description="Lista reportes de relaciones externas guardados (paginado). limit y offset opcionales.")
def foreign_reports_list(limit: int = 20, offset: int = 0) -> Any:
    return _get("/api/foreign/reports", {"limit": limit, "offset": offset})


@mcp.tool(description="Devuelve un reporte de relaciones externas por ID.")
def foreign_report_get(report_id: str) -> Any:
    return _get(f"/api/foreign/reports/{report_id}")


# ─── Entrypoint ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run(transport="stdio")
