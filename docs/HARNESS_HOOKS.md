# Hooks de posición por harness

> Guía consumer-facing: cómo hacer que tu CLI (Claude Code, Codex, Hermes,
> Devin CLI, MiniMax Code) aparezca como **unidad** en el mapa de RepoCiv.
> El estado de la máquina del mantenedor y la evidencia de pruebas viven en
> [`AGENT_POSITION_HOOKS.md`](AGENT_POSITION_HOOKS.md); esta guía describe el
> mecanismo y cómo instalarlo en tu máquina.

---

## Qué hace un hook

Un hook no es más que un comando que el CLI ejecuta en ciertos eventos de
sesión. El hook le pasa por stdin el JSON nativo del evento; el adaptador de
RepoCiv extrae solo la posición y la identidad nativa de la sesión y la
reenvía al bridge:

```
hook nativo del CLI ──stdin──▶ server/agent_hook_client.py
   └─ extrae posición + session id (fail-open: nunca rompe el CLI)
      └── POST http://127.0.0.1:5274/api/agent-events ──▶ PositionStore
           └─ overlay en memoria (TTL 600 s) ──▶ tracker ──▶ mapa
```

Cuando una sesión se ubica por primera vez, cambia de ciudad o termina, el
bridge agrega una fila `AgentPosition:<evento>` a `events.jsonl` (visible en el
panel de Actividad). Un hook **no crea una identidad**: si llega antes de que
una fuente existente (procesos, sesiones) detecte la sesión, se conserva la
ubicación y se aplica cuando aparece esa identidad verificada.

---

## Harnesses soportados

| Harness | Archivo de hooks | Eventos | Notas |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | 6: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SessionEnd` | Se instala solo si el archivo ya existe |
| Codex CLI | `~/.codex/hooks.json` | 5: los mismos sin `PostToolUseFailure` | Requiere aprobar el trust en su UI nativa |
| Hermes | `~/.hermes/config.yaml` | 4: `on_session_start`, `post_tool_call`, `on_session_end` (fin de **turno**), `on_session_finalize` | Solo perfil `default` |
| Devin CLI | `~/.config/devin/config.json` | 5: igual que Codex | Se instala solo si el archivo ya existe |
| MiniMax Code (`mcode`) | `~/.minimax/plugins/repociv-hooks/hooks/hooks.json` + manifest `.claude-plugin/plugin.json` | 5: igual que Codex | El plugin se crea si `~/.minimax/` existe |
| OpenClaw | — | — | Fuera de alcance |

Mapeo de eventos → RepoCiv: `SessionStart` → `session_start`,
`UserPromptSubmit` → `turn_start`, `PostToolUse` (y `PostToolUseFailure` en
Claude) → `tool_use`, `Stop` → `turn_end`, `SessionEnd` → `session_end`.

---

## Quick start (installer)

```bash
cd <tu-checkout-de-repociv>

# El endpoint de posiciones exige token: usá el mismo REPOCIV_TOKEN que corre
# el bridge. Evitalo en el historial de shell (leelo del .env o pegalo oculto).
set -a; source .env; set +a          # o: read -rs REPOCIV_TOKEN && export REPOCIV_TOKEN

.venv/bin/python -m server.agent_hook_install install
```

- **Requisito**: el bridge debe correr con `REPOCIV_TOKEN` configurado. El
  endpoint de posiciones **no admite auth-off**: sin token en el bridge
  responde 503 `position_auth_required`, y con token ausente/erróneo responde
  401 `unauthorized`.
- Corré el installer con el `.venv` del repo: usa `sys.executable`, y ese
  intérprete queda escrito en los comandos de los hooks.
- Salida: JSON `{"changed": [...], "backup": "..."}`. Es idempotente: preserva
  el primer comando existente (y su consentimiento) y no toca hooks ajenos.
- Para retirar únicamente los hooks de RepoCiv:

```bash
.venv/bin/python -m server.agent_hook_install remove
```

---

## Instalación manual

Si preferís no usar el installer, el comando a registrar en cada evento es
siempre el mismo formato:

```
<repo>/.venv/bin/python <repo>/server/agent_hook_client.py <cli> <evento>
```

Claude Code — `~/.claude/settings.json` (Codex, Devin y mcode usan la misma
forma JSON en sus archivos):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/ruta/a/repociv/.venv/bin/python /ruta/a/repociv/server/agent_hook_client.py claude session_start",
            "timeout": 2
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/ruta/a/repociv/.venv/bin/python /ruta/a/repociv/server/agent_hook_client.py claude tool_use",
            "timeout": 2
          }
        ]
      }
    ]
  }
}
```

Repetí el patrón para cada evento de la tabla (`UserPromptSubmit` →
`turn_start`, `PostToolUseFailure` → `tool_use`, `Stop` → `turn_end`,
`SessionEnd` → `session_end`). El `matcher` solo aplica a los eventos
`PostTool*`.

Hermes — `~/.hermes/config.yaml` (nodo `hooks`, se preserva el resto del YAML):

```yaml
hooks:
  on_session_start:
    - command: "/ruta/a/repociv/.venv/bin/python /ruta/a/repociv/server/agent_hook_client.py hermes session_start"
      timeout: 2
```

MiniMax Code — es un plugin local: creá
`~/.minimax/plugins/repociv-hooks/.claude-plugin/plugin.json` y
`~/.minimax/plugins/repociv-hooks/hooks/hooks.json` con la forma JSON de
arriba. El installer hace esto automáticamente.

---

## Consentimiento

- **Codex**: el installer no bypasea trust ni edita hashes. Tras instalar,
  aprobá los comandos en la UI nativa de consentimiento; hasta entonces Codex
  no los ejecuta.
- **Hermes**: los comandos deben quedar en su allowlist oficial; la remoción
  no revoca ese historial manualmente.
- **Claude / Devin / mcode**: sin paso extra.
- Las sesiones CLI ya abiertas pueden necesitar reinicio para releer su
  configuración.

---

## Verificación

1. Bridge sano: `curl -sf http://localhost:5274/health`.
2. Credencial privada en su lugar: `ls -l ~/.config/repociv/hooks/client.json`
   debe verse `-rw-------` (0600).
3. Abrí una sesión nueva del CLI en un repo mapeado: la unidad aparece en el
   mapa (id `ext-<cli>-<hash>`) y el panel de Actividad muestra una fila
   `AgentPosition:session_start`.
4. Diagnóstico del endpoint: un POST anónimo a `/api/agent-events` responde
   401 si el bridge tiene token, o 503 `position_auth_required` si corre sin
   token.

---

## Privacidad y reversión

- El helper envía exclusivamente `cli`, `event`, `session_id`, `profile`
  (solo Hermes), `cwd` y `authority`. **Nunca** prompts, respuestas,
  resultados ni el payload completo del CLI.
- Solo permite loopback (`127.0.0.1`/`::1`/`localhost`), sin proxies ni
  redirects, con timeout corto y fail-open: la telemetría jamás rompe al
  agente.
- El bridge no conserva el `cwd`: guarda la referencia al repo seleccionado
  que lo contiene (`cityId`). Las filas de `events.jsonl` llevan
  `cli`/`profile`/`sessionId`/`cityId`, sin rutas.
- La credencial vive en `~/.config/repociv/hooks/client.json` (modo 0600,
  directorio 0700). No la copies a Git ni a informes.
- Reversión: `remove` quita solo los comandos de RepoCiv, conserva hooks
  ajenos, no revoca el historial de confianza y deja el cliente y los backups
  privados en `~/.config/repociv/hooks/backups/` por si querés reinstalar.

---

## Caveats

- **Sin identidad propia**: la unidad aparece cuando una fuente verificada
  detecta la sesión; la primera aparición puede demorar hasta el próximo poll.
- **Overlay volátil**: TTL 600 s, máximo 1024 registros; no sobrevive a un
  reinicio del bridge. Las fuentes anteriores (procesos, sesiones) siguen
  operando si el hook o el bridge fallan.
- **Rate limit propio**: 600 POST/min/IP para posiciones, independiente del
  budget normal del bridge.
- **Hermes**: solo perfil `default` (no otros perfiles).
- **Codex Code Mode**: el workdir se correlaciona con el rollout nativo de esa
  misma sesión (IDs exactos de sesión/turno/herramienta); si falta o es
  ambiguo, vale el `cwd` recibido.
- **OpenClaw**: fuera de alcance.

---

Módulos de referencia: `server/agent_hook_install.py`,
`server/agent_hook_client.py`, `server/agent_positions.py`.
