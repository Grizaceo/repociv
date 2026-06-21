# Plan: Agent Auto-Discovery (desde AionUi → RepoCiv)

> **Fuente:** Auditoría de AionUi (github.com/iOfficeAI/AionUi, Apache 2.0)
> - `src/process/agent/acp/AcpDetector.ts` — batch `command -v` + anti-injection filter
> - `src/process/agent/AgentRegistry.ts` — multi-source merge + mutation queue
>
> **Fecha:** 2026-05-11
> **Estado:** v1 listo para ejecución (revisión 2026-05-11)
> **Plataforma:** POSIX only (Linux / WSL / macOS). Windows nativo no soportado.

---

## 0. Diagnóstico: estado actual en RepoCiv

Hoy la detección de agentes en `server/agent_runner.py` funciona así:

```python
# Cada agente tiene su propio par de funciones:
def _has_claude_code() -> bool:     # shutil.which("claude")
def _find_claude_code() -> str:     # busca en PATH + ~/.npm-global/bin + ~/.local/bin
def _has_openclaw() -> bool:        # shutil.which("openclaw")
def _find_openclaw() -> str:        # busca en PATH + ~/.npm-global/bin
def _has_cursor() -> bool:          # shutil.which("cursor")
def _find_cursor() -> str:          # busca en PATH + ~/.local/bin + /usr/local/bin
```

Y la cascade está hardcodeada en `_execute_streaming()`:

```python
# Línea 244-286 de agent_runner.py
if harness == "claude-code" and _has_claude_code(): ...
if harness == "cursor" and _has_cursor(): ...
# Default cascade: hermes → claude-code → openclaw
```

**Problemas:**
1. Agregar un agente nuevo requiere: (a) función `_has_xxx()`, (b) función `_find_xxx()`, (c) cambio en la cascade, (d) entry en `shared/provider-registry.json`. Cuatro lugares, propenso a olvidos.
2. `_has_claude_code()`, `_has_openclaw()`, `_has_cursor()` son casi idénticas — solo varía el binario y los paths extra.
3. `provider_registry.py:15` importa cada función a mano.
4. Sin batching: el harness registry chequea CLI por CLI.

**Lo que NO queremos romper:**
- `hermes` no es un CLI; es el gateway in-process (`provider_registry.py:125-127` lo marca siempre disponible).
- Hoy `_find_*()` encuentran binarios en `~/.npm-global/bin` / `~/.local/bin` aunque no estén en PATH — eso hay que preservarlo.

---

## 1. Lo que tomamos de AionUi

Tres patrones aplicables en ~120 líneas de Python.

### 1.1 Batch `command -v` (de `AcpDetector.ts:52-74`)

Una sola shell invocation para N comandos:

```python
checks = [f"command -v '{cli}' >/dev/null 2>&1 && echo '{cli}'" for cli in safe_clis]
script = "; ".join(checks) + "; true"   # exit 0 garantizado
subprocess.run(["sh", "-c", script], capture_output=True, text=True, timeout=3)
```

POSIX only. En Windows nativo `sh -c` no existe; AionUi tiene una rama `where` + PowerShell para win32, no la portamos a v1 porque RepoCiv corre en WSL/Linux.

### 1.2 Anti-injection via whitelist (de `AcpDetector.ts:56`)

No escapar comandos. Rechazar todo lo que no sea `[a-zA-Z0-9_.-]+`:

```python
SAFE_CLI_RE = re.compile(r'^[a-zA-Z0-9_.-]+$')
```

### 1.3 Cache simple (mutation queue diferida)

AionUi usa un `mutationQueue` (`AgentRegistry.ts:162`) porque tiene refresh disparados desde la UI, hot-reload de extensions, etc. RepoCiv hoy no tiene ninguno de esos triggers: la detección corre al levantar el bridge y se invalida solo si alguien llama `invalidate()`. Para v1 basta cache de proceso + función `invalidate()`. El mutation lock async se queda para v2 cuando exista un endpoint `/api/agents/discovered` u otro consumidor concurrente.

---

## 2. Diseño del módulo (v1)

Archivo nuevo: `server/agent_discovery.py` (~120 líneas)

```python
"""RepoCiv — Agent Auto-Discovery.

Replaces the hardcoded _has_xxx() / _find_xxx() pattern with a single
batch `command -v` scan inspired by AionUi's AcpDetector.

Adding a new agent = one entry in KNOWN_AGENTS + una entry en
shared/provider-registry.json. Sin funciones nuevas.

POSIX only (Linux / WSL / macOS). Windows nativo no soportado.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

SAFE_CLI_RE = re.compile(r'^[a-zA-Z0-9_.-]+$')


# ── Known agents ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AgentInfo:
    agent_id: str                    # "claude-code", "openclaw", "cursor"
    cli_name: str                    # binario en PATH
    display_name: str                # UI label
    transport: str                   # match con shared/provider-registry.json
    base_args: tuple[str, ...]       # args fijos para spawnear
    extra_paths: tuple[str, ...] = ()  # paths extra a probar si no está en PATH


@dataclass(frozen=True)
class DiscoveredAgent:
    info: AgentInfo
    path: str   # ruta absoluta resuelta al binario


# Nota: `hermes` NO va aquí. Es el gateway in-process y siempre está
# disponible; lo maneja provider_registry.py como caso especial.
KNOWN_AGENTS: dict[str, AgentInfo] = {
    "claude-code": AgentInfo(
        agent_id="claude-code", cli_name="claude",
        display_name="Claude Code", transport="claude-code",
        base_args=("--print", "--dangerously-skip-permissions"),
        extra_paths=("~/.npm-global/bin/claude", "~/.local/bin/claude"),
    ),
    "openclaw": AgentInfo(
        agent_id="openclaw", cli_name="openclaw",
        display_name="OpenClaw", transport="openclaw",
        base_args=("agent", "--agent", "main", "--message"),
        extra_paths=("~/.npm-global/bin/openclaw",),
    ),
    "cursor": AgentInfo(
        agent_id="cursor", cli_name="cursor",
        display_name="Cursor CLI", transport="cursor",
        base_args=("--headless", "--message"),
        extra_paths=("~/.local/bin/cursor", "/usr/local/bin/cursor"),
    ),
}


# ── Discovery engine ────────────────────────────────────────────────────

_cache: dict[str, DiscoveredAgent] | None = None


def _resolve_extra(info: AgentInfo) -> str | None:
    """Probar extra_paths cuando el CLI no está en PATH."""
    for raw in info.extra_paths:
        candidate = Path(os.path.expanduser(raw))
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def discover(force: bool = False) -> dict[str, DiscoveredAgent]:
    """Single-pass discovery. Una shell invocation, N resultados.

    Returns {agent_id: DiscoveredAgent} solo para los que están instalados.
    Combina batch `command -v` (rápido) + fallback a extra_paths.
    """
    global _cache
    if _cache is not None and not force:
        return _cache

    if sys.platform == "win32":
        logger.warning("[agent_discovery] Windows nativo no soportado; usa WSL.")
        _cache = {}
        return _cache

    safe = {aid: info for aid, info in KNOWN_AGENTS.items()
            if SAFE_CLI_RE.fullmatch(info.cli_name)}

    found_on_path: set[str] = set()
    if safe:
        checks = [
            f"command -v '{info.cli_name}' >/dev/null 2>&1 && echo '{info.cli_name}'"
            for info in safe.values()
        ]
        script = "; ".join(checks) + "; true"
        try:
            result = subprocess.run(
                ["sh", "-c", script],
                capture_output=True, text=True, timeout=3,
            )
            found_on_path = set(result.stdout.strip().split("\n")) & {
                info.cli_name for info in safe.values()
            }
        except (subprocess.TimeoutExpired, OSError) as exc:
            logger.warning("[agent_discovery] batch check failed: %s", exc)

    out: dict[str, DiscoveredAgent] = {}
    for agent_id, info in safe.items():
        path: str | None = None
        if info.cli_name in found_on_path:
            path = shutil.which(info.cli_name)
        if not path:
            path = _resolve_extra(info)
        if path:
            out[agent_id] = DiscoveredAgent(info=info, path=path)

    _cache = out
    return out


def invalidate() -> None:
    """Limpiar cache; próxima llamada a discover() re-scaneará."""
    global _cache
    _cache = None


def is_available(agent_id: str) -> bool:
    return agent_id in discover()


def get_path(agent_id: str) -> str | None:
    """Devuelve la ruta absoluta del binario, o None si no está instalado."""
    d = discover().get(agent_id)
    return d.path if d else None
```

**Diseño deliberado:**
- Una sola función pública `discover()`. Combina batch + extra_paths para evitar la regresión de "binario solo en `~/.npm-global/bin` se vuelve invisible".
- `DiscoveredAgent.path` ya viene resuelto — los runners no necesitan re-buscar.
- Sin `asyncio.Lock` / singleton: `_execute_streaming()` es sync; el lock se introduce en v2 si aparece un consumidor concurrente real.
- `tuple` en lugar de `list` para que `AgentInfo` sea hashable / inmutable.

---

## 3. Cambios en archivos existentes

### 3.1 `server/agent_runner.py`

**Eliminar:**
- `_has_openclaw` / `_find_openclaw` (líneas 356-368)
- `_has_claude_code` / `_find_claude_code` (líneas 371-384)
- `_has_cursor` / `_find_cursor` (líneas 421-434)

**Sustituir en `_execute_streaming()` (líneas 244-263):**

```python
from .agent_discovery import discover, get_path

agents = discover()

if harness and harness != "auto":
    send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id,
                     "text": f"[harness: {harness}]\n"})
    if harness == "openclaw" and "openclaw" in agents:
        return _run_openclaw_streaming(...)
    if harness == "claude-code" and "claude-code" in agents:
        return _run_claude_code_streaming(...)
    if harness == "cursor" and "cursor" in agents:
        return _run_cursor_streaming(...)
    if harness == "hermes":
        # Hermes es el gateway in-process — siempre disponible.
        return _run_hermes_streaming(...)
    # Unknown harness → fall through a la cascade
```

**Sustituir en los runners (líneas 387, 437, ~472):**

```python
# _run_claude_code_streaming:
claude_bin = get_path("claude-code")
if not claude_bin:
    text = "[claude-code error] binary not found in PATH, ~/.npm-global/bin or ~/.local/bin\n"
    ...

# _run_cursor_streaming:
cursor_bin = get_path("cursor")
if not cursor_bin:
    text = "[cursor error] binary not found in PATH, ~/.local/bin or /usr/local/bin\n"
    ...

# _run_openclaw_streaming:
openclaw_bin = get_path("openclaw")
if not openclaw_bin:
    text = "[openclaw error] binary not found in PATH or ~/.npm-global/bin\n"
    ...
```

### 3.2 `server/provider_registry.py`

**Cambiar import (línea 15):**

```python
# ANTES:
from .agent_runner import _has_claude_code, _has_openclaw, _has_cursor
# DESPUÉS:
from .agent_discovery import is_available
```

**Simplificar `_build_dynamic_providers()` (líneas 119-127):**

```python
if transport == "claude-code":
    available = is_available("claude-code")
elif transport == "openclaw":
    available = is_available("openclaw")
elif transport == "cursor":
    available = is_available("cursor")
elif transport == "hermes":
    available = True   # gateway in-process — no CLI
```

### 3.3 `server/bridge.py` — diferido a v2

Endpoint `GET /api/agents/discovered` para que el UI consulte sin reiniciar. No bloquea v1; cuando se haga, llama `discover()` directamente (sync, ~3 ms).

---

## 4. Cómo agregar un agente nuevo después de esto

Antes (4 archivos):
1. `agent_runner.py`: `_has_nuevo()` + `_find_nuevo()`
2. `agent_runner.py`: nuevo `if` en `_execute_streaming()`
3. `provider_registry.py`: import + chequeo
4. `shared/provider-registry.json`: entry de harness

Después (2 archivos):
1. `agent_discovery.py`: 1 entry en `KNOWN_AGENTS` (5 líneas)
2. `shared/provider-registry.json`: entry de harness

Sin entry en el JSON el agente se detecta pero no aparece en el UI. Sin entry en `KNOWN_AGENTS` aparece marcado como "no disponible". Ambos son requeridos.

---

## 5. Tests

Archivo nuevo: `server/test_agent_discovery.py`

- `test_discover_finds_installed_clis` — mock `subprocess.run` con stdout `"claude\nopenclaw"`, devuelve esos dos.
- `test_discover_nothing_found` — stdout vacío → dict vacío.
- `test_injection_blocked` — `KNOWN_AGENTS` parcheado con `cli_name="claude; rm -rf /"` → no entra al script.
- `test_batch_single_shell_invocation` — `subprocess.run` se llama exactamente 1 vez aunque haya 3 agentes.
- `test_cache_hit` — dos llamadas seguidas; la segunda no llama `subprocess.run`.
- `test_invalidate_forces_rescan` — `invalidate()` + `discover()` vuelve a llamar `subprocess.run`.
- `test_timeout_graceful` — `TimeoutExpired` → dict vacío, no crashea.
- `test_extra_paths_falls_back` — `command -v` no encuentra nada, pero `~/.npm-global/bin/openclaw` existe + ejecutable → entry aparece.
- `test_windows_short_circuit` — `sys.platform = "win32"` → dict vacío, sin llamar `subprocess.run`.
- `test_get_path_returns_resolved_path` — agente presente → `get_path("claude-code")` devuelve la ruta absoluta.

---

## 6. Orden de ejecución

| Paso | Acción | Impacto |
|------|--------|---------|
| 1 | Crear `server/agent_discovery.py` | Módulo nuevo, sin tocar nada existente |
| 2 | Crear `server/test_agent_discovery.py` | Todos los tests verde |
| 3 | Modificar `server/agent_runner.py`: eliminar 6 funciones + cablear `discover` / `get_path` | -~60 líneas net |
| 4 | Modificar `server/provider_registry.py`: cambiar import + simplificar 4 ramas | -1 línea net |
| 5 | `python3 -m pytest server/ -q` | Sin regressions |
| 6 | `npm run check` (si aplica) | Frontend OK |
| 7 | Dogfood: levantar bridge, ver dropdown de harness, lanzar mensaje real con `claude-code` | Validación end-to-end |
| 8 | Test negativo: renombrar `~/.npm-global/bin/openclaw` → restart bridge → `openclaw` ya no aparece. Restaurar. | Confirma que la invalidación funciona |

---

## 7. Pendientes (no en scope de v1)

### 7.1 Agregar agentes 3rd-party
`codex`, `qwen`, `opencode`, `aider` necesitan **dos** cambios simultáneos:
- entry en `KNOWN_AGENTS`
- entry en `shared/provider-registry.json`

Política: 5 propios primero (DAVI / LEXO / WORKER / SCOUT / OPENCLAW estables), luego 3rd-party. No mezclar en este refactor.

### 7.2 Async + bridge endpoint
Reintroducir `AgentDiscovery` con `asyncio.Lock` cuando exista:
- `GET /api/agents/discovered` para refresh desde UI, **o**
- detección disparada por hot-reload de algo (extensions, settings).

Hasta entonces, el cache sync + `invalidate()` es suficiente.

### 7.3 LRU Approval Cache (de AionUi `PermissionResolver.ts` + `ApprovalCache.ts`)
~80 líneas Python. Aplicable a `security_harness.py`. Independiente de este refactor; priorizar después.

### 7.4 Extension Manifest System
`ExtensionRegistry.ts` + `aion-extension.json`. Demasiado para alpha single-user. Diferir hasta que haya comunidad de extensions.

### 7.5 Provider/Harness 3-Layer Config
`McpConfig.ts` + `mcpSessionConfig.ts`. RepoCiv ya tiene `provider_registry.py` con buena abstracción; AionUi solo agrega granularidad incremental (model override por agente, tier-based selection). Baja prioridad.

---

## 8. Notas de seguridad

- Whitelist `^[a-zA-Z0-9_.-]+$` aplicada **antes** de interpolar en la shell.
- `extra_paths` expandidos con `os.path.expanduser()` + verificados con `os.access(X_OK)` antes de devolverse.
- `; true` al final del script garantiza exit 0 aunque ningún CLI esté presente.
- Timeout 3 s en `subprocess.run` — un PATH lento (NFS, FUSE) no cuelga el bridge.
- POSIX only. Windows nativo cortocircuita a dict vacío; sin shell evaluation, sin riesgo.

---

## 9. Referencias

- `audit-targets/AionUi/src/process/agent/acp/AcpDetector.ts` (líneas 52-108, 114-148)
- `audit-targets/AionUi/src/process/agent/AgentRegistry.ts` (líneas 162-199)
- `audit-targets/AionUi/src/common/types/acpTypes.ts:96` — `POTENTIAL_ACP_CLIS` (modelo del registry)
- `repos/orchestrator-audit/` — ~90 orquestadores adicionales revisados como contexto; ninguno aporta patrón superior al de AionUi para este caso.
