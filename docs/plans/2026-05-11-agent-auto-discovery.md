# Plan: Agent Auto-Discovery (desde AionUi → RepoCiv)

> **Fuente:** Auditoría de AionUi (github.com/iOfficeAI/AionUi, Apache 2.0)
> - `src/process/agent/acp/AcpDetector.ts` — batch `command -v` + anti-injection filter
> - `src/process/agent/AgentRegistry.ts` — multi-source merge + mutation queue
>
> **Fecha:** 2026-05-11
> **Estado:** Plan listo para ejecución

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
1. Agregar un nuevo agente requiere: (a) nueva función `_has_xxx()`, (b) nueva función `_find_xxx()`, (c) modificar la cascade. Tres lugares, propenso a olvidos.
2. `_has_claude_code()`, `_has_openclaw()`, `_has_cursor()` son casi idénticas — solo varía el nombre del binario y los paths extra.
3. `provider_registry.py` importa estas funciones una por una (línea 15): `from .agent_runner import _has_claude_code, _has_openclaw, _has_cursor`.
4. El harness registry detecta disponibilidad chequeando cada CLI individualmente — no hay batching.

---

## 1. Lo que tomamos de AionUi

Tres patrones, implementables en ~150 líneas totales de Python:

### 1.1 Batch `command -v` (de `AcpDetector.ts:52`)

Una sola shell invocation para N comandos:

```python
AGENT_CLIS = {
    "claude-code": {"cmd": "claude", "args": ["--print", "--dangerously-skip-permissions"]},
    "openclaw":    {"cmd": "openclaw", "args": ["agent", "--agent", "main", "--message"]},
    "cursor":      {"cmd": "cursor", "args": ["--headless", "--message"]},
    "codex":       {"cmd": "codex", "args": ["--acp"]},
    "qwen":        {"cmd": "qwen", "args": ["--acp"]},
    "hermes":      {"cmd": "hermes", "args": ["--acp", "--stdio"]},
    "opencode":    {"cmd": "opencode", "args": ["--acp"]},
    "aider":       {"cmd": "aider", "args": ["--message"]},
}

def discover_agents() -> dict[str, AgentInfo]:
    """Una shell invocation. N resultados. Sin race conditions."""
    safe = [info["cmd"] for info in AGENT_CLIS.values()
            if re.fullmatch(r'[a-zA-Z0-9_.-]+', info["cmd"])]
    checks = [f"command -v '{cmd}' >/dev/null 2>&1 && echo '{cmd}'" for cmd in safe]
    script = "; ".join(checks) + "; true"

    result = subprocess.run(
        ["sh", "-c", script],
        capture_output=True, text=True, timeout=3
    )
    found = set(result.stdout.strip().split("\n")) & set(safe)

    return {agent_id: info for agent_id, info in AGENT_CLIS.items()
            if info["cmd"] in found}
```

### 1.2 Anti-injection via whitelist (de `AcpDetector.ts:56`)

No escapar comandos. Rechazar todo lo que no sea `[a-zA-Z0-9_.-]+`:

```python
SAFE_CLI_PATTERN = re.compile(r'^[a-zA-Z0-9_.-]+$')

def _is_safe_cli_name(name: str) -> bool:
    return bool(SAFE_CLI_PATTERN.fullmatch(name))
```

### 1.3 Mutation queue para refresh (de `AgentRegistry.ts:162`)

Evitar race conditions cuando dos refresh se disparan simultáneamente:

```python
class AgentDiscovery:
    _lock = asyncio.Lock()

    async def refresh(self):
        async with self._lock:
            self._cache = await self._scan()
```

---

## 2. Diseño del módulo

Archivo nuevo: `server/agent_discovery.py`

```python
"""RepoCiv — Agent Auto-Discovery.

Replaces the hardcoded _has_xxx() / _find_xxx() pattern with a single
batch command -v scan inspired by AionUi's AcpDetector.

Adding a new agent = one entry in KNOWN_AGENTS. No function to write.
"""

from __future__ import annotations

import asyncio
import logging
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ── Known agents ────────────────────────────────────────────────────────

@dataclass
class AgentInfo:
    agent_id: str           # "claude-code", "openclaw", "cursor"...
    cli_name: str           # "claude", "openclaw", "cursor"...
    display_name: str       # "Claude Code", "OpenClaw", "Cursor CLI"
    base_args: list[str]    # args base para subprocess
    transport: str          # "claude-code" | "openclaw" | "cursor" | "acp" | "hermes"
    extra_paths: list[str] = field(default_factory=list)  # paths adicionales

KNOWN_AGENTS: dict[str, AgentInfo] = {
    "claude-code": AgentInfo(
        agent_id="claude-code", cli_name="claude",
        display_name="Claude Code", transport="claude-code",
        base_args=["--print", "--dangerously-skip-permissions"],
        extra_paths=["~/.npm-global/bin/claude", "~/.local/bin/claude"],
    ),
    "openclaw": AgentInfo(
        agent_id="openclaw", cli_name="openclaw",
        display_name="OpenClaw", transport="openclaw",
        base_args=["agent", "--agent", "main", "--message"],
        extra_paths=["~/.npm-global/bin/openclaw"],
    ),
    "cursor": AgentInfo(
        agent_id="cursor", cli_name="cursor",
        display_name="Cursor CLI", transport="cursor",
        base_args=["--headless", "--message"],
        extra_paths=["~/.local/bin/cursor", "/usr/local/bin/cursor"],
    ),
    "hermes": AgentInfo(
        agent_id="hermes", cli_name="hermes",
        display_name="Hermes Agent", transport="hermes",
        base_args=["--acp", "--stdio"],
    ),
    "codex": AgentInfo(
        agent_id="codex", cli_name="codex",
        display_name="OpenAI Codex", transport="acp",
        base_args=["--acp"],
    ),
    "qwen": AgentInfo(
        agent_id="qwen", cli_name="qwen",
        display_name="Qwen CLI", transport="acp",
        base_args=["--acp"],
    ),
    "opencode": AgentInfo(
        agent_id="opencode", cli_name="opencode",
        display_name="OpenCode", transport="acp",
        base_args=["--acp"],
    ),
    "aider": AgentInfo(
        agent_id="aider", cli_name="aider",
        display_name="Aider", transport="stdio",
        base_args=["--message"],
    ),
}

SAFE_CLI_RE = re.compile(r'^[a-zA-Z0-9_.-]+$')

# ── Discovery engine ────────────────────────────────────────────────────

def _resolve_path(cli_name: str, extra_paths: list[str]) -> str | None:
    """Find a CLI binary: PATH first, then extra_paths expanded."""
    import shutil
    import os

    # 1. Standard PATH lookup
    found = shutil.which(cli_name)
    if found:
        return found

    # 2. Extra paths (expanded, existence + executable check)
    for raw in extra_paths:
        candidate = Path(os.path.expanduser(raw))
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)

    return None


def discover() -> dict[str, AgentInfo]:
    """Single-pass discovery of all known agent CLIs.

    One shell invocation, N results. ~3ms on typical systems.
    Safe against injection via regex whitelist.
    """
    # Filter safe CLI names
    safe = {agent_id: info for agent_id, info in KNOWN_AGENTS.items()
            if SAFE_CLI_RE.fullmatch(info.cli_name)}
    if not safe:
        return {}

    # Build batch check script
    checks = [
        f"command -v '{info.cli_name}' >/dev/null 2>&1 && echo '{info.cli_name}'"
        for info in safe.values()
    ]
    script = "; ".join(checks) + "; true"

    try:
        result = subprocess.run(
            ["sh", "-c", script],
            capture_output=True, text=True, timeout=3
        )
        found_clis = set(result.stdout.strip().split("\n")) & {
            info.cli_name for info in safe.values()
        }
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("[agent_discovery] Batch CLI check failed: %s", exc)
        return {}

    return {
        agent_id: info
        for agent_id, info in safe.items()
        if info.cli_name in found_clis
    }


def discover_with_paths() -> dict[str, dict[str, Any]]:
    """Discover agents with resolved paths (for execution).

    Returns dict agent_id → {info, path, available}.
    Unlike plain discover(), this also checks extra_paths.
    """
    available = set(discover().keys())
    result = {}

    for agent_id, info in KNOWN_AGENTS.items():
        path = _resolve_path(info.cli_name, info.extra_paths)
        result[agent_id] = {
            "info": info,
            "path": path,
            "available": agent_id in available or path is not None,
        }

    return result


# ── Async wrapper (for bridge integration) ──────────────────────────────

class AgentDiscovery:
    """Async-safe agent discovery with cached results and mutation lock."""

    def __init__(self):
        self._cache: dict[str, AgentInfo] | None = None
        self._lock = asyncio.Lock()

    async def get_agents(self, force_refresh: bool = False) -> dict[str, AgentInfo]:
        """Return discovered agents. Uses cache unless force_refresh=True."""
        if self._cache is not None and not force_refresh:
            return self._cache

        async with self._lock:
            if self._cache is not None and not force_refresh:
                return self._cache
            loop = asyncio.get_running_loop()
            self._cache = await loop.run_in_executor(None, discover)
            return self._cache

    async def is_available(self, agent_id: str) -> bool:
        agents = await self.get_agents()
        return agent_id in agents

    def invalidate(self) -> None:
        """Clear cache — next get_agents() will re-scan."""
        self._cache = None


# Singleton
_agent_discovery = AgentDiscovery()


def get_agent_discovery() -> AgentDiscovery:
    return _agent_discovery
```

---

## 3. Cambios en archivos existentes

### 3.1 `server/agent_runner.py`

**Eliminar:**
- `_has_claude_code()` (línea 371)
- `_find_claude_code()` (línea 375)
- `_has_openclaw()` (línea 356)
- `_find_openclaw()` (línea 360)
- `_has_cursor()` (línea 421)
- `_find_cursor()` (línea 425)

**Modificar** `_execute_streaming()` (línea 228):
- Reemplazar `_has_claude_code()`, `_has_openclaw()`, `_has_cursor()` con `discover()`

```python
# En _execute_streaming(), reemplazar:
from .agent_discovery import discover

def _get_available_agents() -> set[str]:
    return set(discover().keys())

# La cascade se vuelve:
available = _get_available_agents()
if harness == "claude-code" and "claude-code" in available: ...
if harness == "cursor" and "cursor" in available: ...
```

### 3.2 `server/provider_registry.py`

**Eliminar** import (línea 15):
```python
# ANTES:
from .agent_runner import _has_claude_code, _has_openclaw, _has_cursor
# DESPUÉS:
from .agent_discovery import discover
```

**Modificar** `_build_dynamic_providers()` (línea 86):
```python
# Reemplazar chequeos individuales:
available_agents = discover()
# ...
if transport == "claude-code":
    available = "claude-code" in available_agents
elif transport == "openclaw":
    available = "openclaw" in available_agents
elif transport == "cursor":
    available = "cursor" in available_agents
```

### 3.3 `server/bridge.py`

Agregar endpoint opcional para consultar agentes disponibles desde la UI:

```python
# GET /api/agents/discovered
# → { "agents": { "claude-code": {"display_name": "Claude Code", ...}, ... } }
```

---

## 4. Cómo agregar un agente nuevo después de esto

Antes (3 archivos, ~40 líneas):
1. `agent_runner.py`: función `_has_nuevoagente()`, `_find_nuevoagente()`
2. `agent_runner.py`: nuevo if en `_execute_streaming()`
3. `provider_registry.py`: nuevo import + nuevo chequeo

Después (1 archivo, 5 líneas):
```python
# Solo en agent_discovery.py, KNOWN_AGENTS:
"nuevo-agente": AgentInfo(
    agent_id="nuevo-agente", cli_name="nuevo-cli",
    display_name="Nuevo Agente", transport="acp",
    base_args=["--acp"],
)
```

---

## 5. Tests

Archivo nuevo: `server/test_agent_discovery.py`

Tests planeados:
- `test_discover_hermes_found` — mock `subprocess.run` con stdout que incluye "hermes"
- `test_discover_nothing_found` — mock con stdout vacío
- `test_injection_blocked` — `KNOWN_AGENTS` temporal con `cli_name="claude; rm -rf /"` → no aparece en safe
- `test_batch_single_shell_invocation` — verificar que `subprocess.run` se llama exactamente 1 vez
- `test_cache_hit` — dos llamadas seguidas, la segunda no llama a subprocess
- `test_mutation_lock` — dos refresh concurrentes no pisan
- `test_timeout_graceful` — timeout no crashea, devuelve dict vacío
- `test_extra_paths_resolution` — `_resolve_path` encuentra en `extra_paths`

---

## 6. Orden de ejecución

| Paso | Acción | Impacto |
|------|--------|---------|
| 1 | Crear `server/agent_discovery.py` | Módulo nuevo, sin tocar nada existente |
| 2 | Crear `server/test_agent_discovery.py` | Tests pasan en verde |
| 3 | Modificar `server/agent_runner.py` | Eliminar ~70 líneas, reemplazar con ~5 |
| 4 | Modificar `server/provider_registry.py` | Eliminar 1 import, simplificar detection |
| 5 | Correr `python3 -m pytest server/ -q` | Verificar que todo sigue verde |
| 6 | Correr `npm run check` | Verificar que frontend no se rompe |
| 7 | Dogfood: abrir RepoCiv, ver agentes disponibles | Validación real |

---

## 7. Pendientes para importar después (del mismo audit de AionUi)

Estos patrones también son valiosos pero se planifican aparte:

### 7.1 LRU Approval Cache
- **Fuente:** `PermissionResolver.ts` + `ApprovalCache.ts`
- **Qué es:** Cache LRU de decisiones "always allow" para herramientas. Solo cachea approves, nunca denies. Key = `hash(command + path + file_path)`.
- **Utilidad para RepoCiv:** Aplicable al `security_harness.py` actual. ~80 líneas de Python.
- **Prioridad:** Media — utilidad clara, pero el security harness actual ya funciona.

### 7.2 Extension Manifest System
- **Fuente:** `ExtensionRegistry.ts` + `aion-extension.json`
- **Qué es:** Extensiones con manifiesto JSON, engine compatibility check, multi-source scan (env var, user dir, app data), dependency resolution, lifecycle hooks.
- **Utilidad para RepoCiv:** Sistema de plugins liviano sin Electron. `repociv-extension.json` mínimo.
- **Prioridad:** Baja-media — depende de que haya comunidad de extensions. Para alpha single-user, overkill.

### 7.3 Provider/Harness 3-Layer Config
- **Fuente:** `McpConfig.ts` + `mcpSessionConfig.ts`
- **Qué es:** Configuración de 3 capas: provider registry → harness registry → model selector. Con defaults, overrides, y fallback chains.
- **Utilidad para RepoCiv:** RepoCiv ya tiene `provider_registry.py` que hace algo similar. AionUi agrega más granularidad (per-agent model override, tier-based selection).
- **Prioridad:** Baja — RepoCiv ya tiene buena abstracción de providers.

---

## 8. Notas de seguridad

- El batch `command -v` solo ejecuta nombres de comandos whitelisteados. No hay interpolación de strings no validadas.
- Los `extra_paths` se expanden con `os.path.expanduser()` y se verifican con `os.access(candidate, os.X_OK)` antes de usarse.
- La regex `^[a-zA-Z0-9_.-]+$` es estricta — no permite espacios, barras, ni caracteres de shell injection.
- El `; true` al final del script garantiza que el exit code siempre sea 0, incluso si ningún CLI está instalado.
- Timeout de 3 segundos en el subprocess — un PATH colgado no bloquea el bridge.
