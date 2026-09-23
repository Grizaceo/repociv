# Evidencia: Fase 5 — Investigación del canal local oficial de Claude Code

**Fecha**: 2026-09-21
**Rama**: `feat/external-agents-chat`
**HEAD**: `291c9f8`
**CLI verificada**: Claude Code 2.1.278 (`/home/gris96/.local/bin/claude`)
**Método**: lectura de documentación oficial (code.claude.com), `claude --help` completo,
probes empíricos en `/home/gris96/.hermes/cache/scratch/cc-bg-probe` (sesiones de prueba
detenidas y eliminadas tras los probes; `claude agents --json --all` = `[]` verificado).

## Veredicto

**NO existe canal local oficial para enviar a una sesión activa arbitraria.**
**SÍ existe un canal local oficial proceso-owned**: `--input-format stream-json`
sobre stdin/stdout de un proceso Claude que el controlador lanza desde su nacimiento
(verificado empíricamente, PROBE-L). Es exactamente la condición 2 que el plan §9.3
anticipó como "la realista con la CLI actual".

### Respuestas al cuestionario del plan

| Pregunta | Respuesta |
|---|---|
| ¿Existe un canal local oficial? | **Parcial**: NO para sesiones arbitrarias vivas; SÍ proceso-owned (stream-json/SDK) |
| ¿Proceso-owned o arbitrario? | **Proceso-owned**, exclusivamente |
| ¿Qué API/CLI/SDK lo expone? | `claude -p --input-format stream-json --output-format stream-json --verbose` (CLI); `ClaudeSDKClient` (Agent SDK Python/TS). Descubrimiento: `claude agents --json`. Solo lectura: `claude logs <id>`, `list_sessions()`, `get_session_messages()` |
| ¿Qué autenticación requiere? | Las mismas credenciales almacenadas que las sesiones interactivas (OAuth claude.ai o `ANTHROPIC_API_KEY`); sin auth adicional para canales locales |
| ¿Qué limitaciones tiene? | Ver §Limitaciones |

## Inventario completo de superficies verificadas

### 1. Documentación oficial (code.claude.com)

Páginas consultadas: `agent-view`, `headless`, `cli-reference`, `sessions`, `sdk/overview`,
`sdk/sdk-python`.

- **`--cloud <session-id> -p`** es el único "queue a message into that existing session"
  documentado — **solo sesiones cloud**, no locales.
- **`claude attach <id>`**: "Open the background session in this terminal" — interactivo,
  requiere TTY.
- **`--bg --resume`**: "With `--resume <session-id>`, continues that session in the
  background under the same ID, **or starts a copy and says so when the session is already
  running**" (cli-reference) — sobre una sesión viva crea una copia, no entrega a la viva.
- **`-c`/`--continue`**: "opens a background session that has finished, **but not one that
  is still running**. If your most recent conversation is one you moved to the background
  and it is still running there, Claude Code exits with `Your most recent conversation is
  running in the background`" (sessions).
- **Agent SDK**: `ClaudeSDKClient.query()` envía al proceso que el SDK **lanza**;
  `resume` en `ClaudeAgentOptions` carga la conversación **desde disco** (segundo
  escritor si la sesión está viva); `list_sessions()` y `get_session_messages()` son solo
  lectura. No existe API para adjuntarse a un proceso ajeno vivo.
- **Supervisor daemon**: documentado como servicio interno (`claude daemon status`,
  socket, `roster.json`); su protocolo de socket no es superficie pública.

### 2. CLI local (`claude --help` completo, 2.1.278)

Subcomandos relevantes: `agents`, `attach`, `logs`, `stop|kill`, `respawn`, `rm`,
`daemon status|stop`, `mcp`, `auth`, `doctor`, `project`, `setup-token`, `import`,
`install`, `update`, `gateway`, `auto-mode`, `ultrareview`, `plugin`.

**No existen** subcomandos `send`, `queue`, `message`, `prompt`, `inject`, `dm`
(verificado: todos caen al usage general del CLI).

### 3. Probes empíricos (todos en scratch, con auth claude.ai first-party verificada)

| Probe | Comando | Resultado |
|---|---|---|
| A | `claude attach nonexistent-id-123` | `No job matching 'nonexistent-id-123'. Run 'claude agents' to list running sessions.` |
| B | `claude --bg --name repociv-phase5-probe "…"` | Sesión background `319c0777` creada (haiku) |
| C | `claude agents --json` (en vivo) | `[{pid, id, cwd, kind: "background", startedAt, sessionId: "<uuid completo>", name, status: "idle", state: "done"}]` — superficie pública de descubrimiento/liveness |
| D | `claude logs 319c0777` | Output de terminal reciente, solo lectura |
| E | `claude daemon status` | Supervisor pid 36090, `control.sock: reachable`, `bg workers: 1 running` |
| F | `claude -p --resume 319c0777 "…"` (short id) | Error: `--resume requires a valid session ID or session title when used with --print` |
| **G** | `claude -p --resume <uuid-completo> "…"` sobre sesión **en ejecución** | **Rechazo explícito**: `Error: Session … is running as a background session (319c0777). Run 'claude attach 319c0777' to open it, or 'claude stop 319c0777' first to resume it here. Add --fork-session to branch off a copy instead.` |
| H | `claude attach 319c0777 < /dev/null` (sin TTY) | Cuelga en `Attaching…` — no scriptable |
| I | Inspección socket (read-only) | `/tmp/cc-daemon-1000/2520abc0/`: `control.sock`, `pty/319c0777.sock`, `rv/319c0777.sock` — protocolo interno no documentado |
| J | `ss -ltnp` | Ningún listener HTTP de claude — no existe API HTTP local |
| K | `claude --bg --resume <uuid> "…"` sobre sesión **en ejecución** | `note: session 319c0777 is already running in the background, so this started a copy as 1668229d` — **copia**, no entrega a la viva |
| **L** | `claude -p --input-format stream-json --output-format stream-json --verbose` (proceso propio, 2 turnos) | Turn 1: `{"subtype":"success","result":"TURN1-OK","session_id":"e1798d49-…"}`; Turn 2 mismo proceso: `{"subtype":"success","result":"The number is 42","session_id":"e1798d49-…"}` — **canal bidireccional oficial, mismo session_id, memoria retenida, exit 0** |

### 4. Hooks como canal de entrega (fuente 5 del cuestionario)

Los hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, …)
son *salidas* de eventos del proceso Claude hacia comandos externos. No existe un hook
de *entrada* que inyecte un prompt de usuario en una sesión viva. Descartado como canal.

## Interpretación contra el contrato del plan

- **Condición 1 de §9.3** ("una API/CLI local oficial permite enviar a un ID activo y
  confirma aceptación"): **NO se cumple**. No hay equivalente de `codex queue`. El propio
  CLI protege contra el segundo escritor: `-p --resume` rechaza sesiones background en
  ejecución (PROBE-G), y `--bg --resume` bifurca copia (PROBE-K).
- **Condición 2 de §9.3** ("RepoCiv es propietario del proceso Claude desde su arranque y
  conserva un canal bidireccional soportado hacia stdin/stdout, con lifecycle y permisos
  explícitos"): **SE CUMPLE y está verificada empíricamente** (PROBE-L). Es un canal
  oficial documentado (headless / Agent SDK), no un hack de TTY.

## Limitaciones del canal proceso-owned

1. Solo sesiones que RepoCiv lance desde su arranque; las sesiones nacidas en terminales
   de Cristóbal siguen siendo observables (`agents --json`) pero **no direccionables**.
2. El controlador debe mantener vivo el pipe stdin/stdout del proceso (o usar el SDK).
3. Sin primitiva de idempotencia; el plan §11 ya decide no reintentar automáticamente.
4. `-p` con `--permission-prompts host` requiere un host que responda prompts, o
   `--permission-prompts none` (niega todo lo que pregunte) — decisión de permisos
   explícita al lanzar.
5. `--max-turns` es print-mode only: aplica a este canal.
6. Para sesiones background del supervisor: `attach` no es scriptable (PROBE-H) y el
   socket `control.sock` es protocolo interno no documentado — fuera de contrato.

## Estado de las sesiones de prueba

Ambas sesiones de probe (`319c0777`, `1668229d`) fueron detenidas con `claude stop` y
eliminadas con `claude rm`. Verificación post-limpieza: `claude agents --json --all` → `[]`.
El supervisor daemon queda corriendo (transient, iniciado on-demand) sin sesiones.

## Conclusión y camino en el árbol de decisión (§7)

Paso 5.1 responde la pregunta abierta §16.9: **Claude Code NO expone canal local
soportado para sesiones activas arbitrarias; solo proceso-owned.** La Fase 5 NO queda
fail-closed por inexistencia — existe un canal oficial verificable para el caso
proceso-owned (condición 2 de §9.3, enlazada con la línea de sesiones propias de
RepoCiv ya iniciada: `9be47cd`, `fcd8a91`).

La decisión de implementar el adaptador con este canal corresponde al owner
(§5 Paso 5.2 punto 1). No se implementa nada sin aprobación explícita.

## Referencias

- Plan canónico: `docs/plans/2026-09-21-live-session-chat-multiharness.md` (§9, §14 Fase 5, §16.9)
- Docs oficiales: `code.claude.com/docs/en/{agent-view,headless,cli-reference,sessions,sdk/overview,sdk/sdk-python}`
- Adaptadores existentes: `server/live_session_chat.py` (patrón Codex a seguir)
- Evidencia Fase 4: `docs/evidence/2026-09-21-no-public-preventive-surface.md`
