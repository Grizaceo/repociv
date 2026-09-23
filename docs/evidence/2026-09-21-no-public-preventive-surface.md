# Evidencia: No existe superficie pública preventiva (§8.3)

**Fecha**: 2026-09-21
**Rama**: `feat/external-agents-chat`
**HEAD**: `291c9f8`

## Veredicto

**NO existe superficie pública (HTTP ni CLI) que permita a RepoCiv determinar
antes de enviar, de forma atómica, que:**

1. **La sesión pertenece a la línea del Bot Chat canónico**, y
2. **Existe un dueño vivo para ese Bot Chat.**

Por lo tanto, según el árbol de decisión §7 del plan
`docs/plans/2026-09-21-live-session-chat-multiharness.md`, la Fase 4 queda
**fail-closed** (camino D):

> "No existe superficie pública preventiva → detente, conserva
> `hermes_not_live_bot_chat`, documenta evidencia y no envíes ningún mensaje
> de prueba."

## Inventario completo de superficies verificadas

### 1. Rutas HTTP del gateway (líneas 1583–1624 de `api_server.py`)

El route table completo del gateway (`_http_route_table()` en
`gateway/platforms/api_server.py`) fue enumerado íntegramente. Las rutas
existentes son:

| Ruta | Método | Descripción |
|------|--------|-------------|
| `/api/sessions` | GET, POST | List / create |
| `/api/sessions/{id}` | GET, PATCH, DELETE | Get, patch, delete |
| `/api/sessions/{id}/messages` | GET | Messages |
| `/api/sessions/{id}/fork` | POST | Fork |
| `/api/sessions/{id}/chat` | POST | Chat |
| `/api/sessions/{id}/chat/stream` | POST | Chat stream |
| `/api/sessions/{id}/model` | GET, PATCH | Model |
| `/api/sessions/{id}/leave` | POST | Leave |
| `/api/sessions/{id}/end` | POST | End |
| `/api/sessions/{id}/hidden` | PATCH | Hidden flag |
| `/api/sessions/{id}/title` | PATCH | Title |
| `/api/sessions/{id}/attach` | POST | Attach |
| `/api/sessions/{id}/peer` | GET, POST | Peer |
| `/api/sessions/{id}/peer/dm` | POST | Peer DM |
| `/api/sessions/{id}/peer/add` | POST | Peer add |
| `/api/sessions/{id}/peer/run` | POST | Peer run |
| `/api/sessions/{id}/peer/close` | POST | Peer close |
| `/api/sessions/{id}/peer/list` | GET | Peer list |
| `/api/sessions/{id}/peer/capabilities` | GET | Peer capabilities |
| `/api/sessions/{id}/peer/reply` | POST | Peer reply |
| `/api/sessions/{id}/external-agents` | GET, POST | External agents |
| `/api/sessions/{id}/external-agents/{agent_id}/chat` | POST | External agent chat |
| `/api/sessions/{id}/external-agents/{agent_id}/reply` | POST | External agent reply |
| `/api/sessions/{id}/external-agents/{agent_id}/capabilities` | GET | External agent capabilities |
| `/api/sessions/{id}/external-agents/{agent_id}/close` | POST | External agent close |
| `/api/sessions/{id}/live-session` | GET, POST | Live session |
| `/api/sessions/{id}/live-session/resolve` | POST | Live session resolve |
| `/api/sessions/{id}/live-session/close` | POST | Live session close |
| `/api/sessions/{id}/live-session/heartbeat` | POST | Live session heartbeat |
| `/api/sessions/{id}/live-session/pending` | GET | Live session pending |
| `/api/sessions/{id}/live-session/deliver` | POST | Live session deliver |
| `/api/sessions/{id}/live-session/ack` | POST | Live session ack |
| `/api/sessions/{id}/live-session/warn` | POST | Live session warn |
| `/api/sessions/{id}/live-session/failure` | POST | Live session failure |
| `/api/sessions/{id}/live-session/replay` | POST | Live session replay |
| `/api/sessions/{id}/live-session/transcript` | GET | Live session transcript |
| `/api/sessions/{id}/live-session/context` | GET | Live session context |
| `/api/sessions/{id}/live-session/model` | GET, PATCH | Live session model |
| `/api/sessions/{id}/live-session/hidden` | PATCH | Live session hidden |
| `/api/sessions/{id}/live-session/title` | PATCH | Live session title |
| `/api/sessions/{id}/live-session/leave` | POST | Live session leave |
| `/api/sessions/{id}/live-session/end` | POST | Live session end |
| `/api/sessions/{id}/live-session/attach` | POST | Live session attach |
| `/api/sessions/{id}/live-session/peer` | GET, POST | Live session peer |
| `/api/sessions/{id}/live-session/peer/dm` | POST | Live session peer DM |
| `/api/sessions/{id}/live-session/peer/add` | POST | Live session peer add |
| `/api/sessions/{id}/live-session/peer/run` | POST | Live session peer run |
| `/api/sessions/{id}/live-session/peer/close` | POST | Live session peer close |
| `/api/sessions/{id}/live-session/peer/list` | GET | Live session peer list |
| `/api/sessions/{id}/live-session/peer/capabilities` | GET | Live session peer capabilities |
| `/api/sessions/{id}/live-session/peer/reply` | POST | Live session peer reply |
| `/api/sessions/{id}/live-session/external-agents` | GET, POST | Live session external agents |
| `/api/sessions/{id}/live-session/external-agents/{agent_id}/chat` | POST | Live session external agent chat |
| `/api/sessions/{id}/live-session/external-agents/{agent_id}/reply` | POST | Live session external agent reply |
| `/api/sessions/{id}/live-session/external-agents/{agent_id}/capabilities` | GET | Live session external agent capabilities |
| `/api/sessions/{id}/live-session/external-agents/{agent_id}/close` | POST | Live session external agent close |

**Ninguna ruta HTTP expone lease/dueño/liveness.** El route table completo
fue verificado con búsqueda regex `"/(api|v1)/[^"]*(lease|owner|attach|live)[^"]*"`
en `gateway/platforms` (39 coincidencias, todas corresponden a rutas
`/live-session/...` que son del módulo live-session de Hermes, no del Bot Chat
canónico de RepoCiv).

### 2. CLI `hermes peer` (`hermes_cli/subcommands/peer.py`)

El subcomando `peer` (12.013 chars) tiene `_find_bot_chat` que usa
`GET /api/sessions?title=Bot Chat&include_hidden=true` para encontrar el Bot
Chat canónico. **No tiene ningún comando para verificar si tiene dueño vivo.**
Búsqueda de `session_owner_details|find_canonical_live_owner|bot_live_delivery|registry_snapshot`
en `hermes_cli/subcommands` → **0 coincidencias**.

### 3. Funciones Python internas (`hermes_cli/active_sessions.py`)

- `active_session_registry_snapshot()` (línea 711): devuelve los leases vivos
  con `pid`, `bot_live_delivery_consumer`, `live_session_id`, `session_id`.
  Es una **función Python interna**, no una superficie pública HTTP ni CLI.
- `session_owner_details(session_id, owner)`: genera un string para mostrar
  quién tiene el lease. También es interna.
- `try_acquire_active_session()`: adquiere un lease. Interna.

**Ninguna de estas funciones es expuesta como subcomando CLI.** No existe
`hermes active-sessions` o similar.

### 4. `find_canonical_live_owner()` (`tools/bot_live_delivery.py`)

Es la función que implementa el predicado completo: busca en el registry un
lease con `bot_live_delivery_consumer=True` Y verifica que el pid esté vivo
(probe de liveness por pid) Y cruza con el tip del Bot Chat canónico.
**Es Python interno, no HTTP ni CLI.** 134 coincidencias en el propio archivo,
36 usos en `hermes-agent`, 0 en `hermes_cli`.

### 5. `runtime/active_sessions.json` (registry de leases)

Archivo JSON en disco que RepoCiv puede leer directamente. Contiene:
`lease_id`, `pid`, `bot_live_delivery_consumer`, `live_session_id`,
`session_id`, `process_start_time`, `started_at`, `updated_at`.

**Es un archivo interno de Hermes, no una API oficial.** EXTERNAL_AGENTS.md
(documento de RepoCiv) lo menciona como fuente de liveness, pero eso no lo
convierte en una "superficie pública" en el sentido del plan §8.3.

Además, el registry **no tiene el título de la sesión**. Tiene `session_id`
(id interno de Hermes), no el título "Bot Chat". Para determinar que una
sesión es el Bot Chat canónico, RepoCiv necesitaría cruzar con `state.db` o
usar `GET /api/sessions?title=Bot Chat&include_hidden=true`.

### 6. `hermes_sessions.py` (adaptador RepoCiv)

Búsqueda de `active_sessions\.json|active_session_registry|lease|liveness`
en `hermes_sessions.py` → **0 coincidencias**. RepoCiv NO lee el registry
de leases directamente. No tiene forma de verificar el dueño vivo.

## Por qué la combinación HTTP + archivo JSON NO cuenta como "superficie pública preventiva"

El plan §8.3 requiere que RepoCiv determine **antes de enviar**, **mediante
una superficie pública**, ambas condiciones de forma **atómica**. La
combinación de:

1. `GET /api/sessions?title=Bot Chat&include_hidden=true` (HTTP) → determina
   el session_id del Bot Chat canónico
2. Lectura de `runtime/active_sessions.json` (archivo interno) → verifica
   que hay un lease con `bot_live_delivery_consumer=True` para ese session_id
   y que el pid está vivo

**No es una superficie pública preventiva** porque:

- **No es atómica**: hay una ventana de tiempo entre la consulta HTTP y la
  lectura del archivo donde el estado podría cambiar (el lease podría
  expirar, el pid podría morir, etc.).
- **El archivo JSON es un archivo interno de Hermes**, no una API oficial.
  EXTERNAL_AGENTS.md lo documenta como fuente de liveness, pero eso no lo
  convierte en una "superficie pública" en el sentido del plan §8.3.
- **El plan §8.3 contrasta "superficie pública" con "función Python interna"**.
  El archivo JSON es un mecanismo interno de Hermes que RepoCiv lee
  directamente. No es una superficie que Hermes expone públicamente como
  una API HTTP o un CLI oficial.
- **El plan §8.3 dice "No se puede 'enviar y ver qué pasa'**: si la condición
  no se cumple, el gateway ya habrá corrido `_run_agent` como segundo
  escritor." Esto implica que la verificación debe ser atómica y previa al
  envío. Dos pasos separados no son atómicos.

## Estado actual del Bot Chat canónico

- **Título**: `Bot Chat`
- **Session ID**: `20260826_195710_4bb9d5`
- **Hidden**: sí
- **Hijos**: none
- **Lease**: none → **sin dueño vivo hoy**
- **`runtime/active_sessions.json`**: 1 lease (PID 11995, sesión
  `20260921_220543_5e59c4`, `bot_live_delivery_consumer=true`). Ninguno
  corresponde al Bot Chat canónico.
- **Buzón `bot_live_delivery`**: no existe (nunca se admitió nada).

## Conclusión

**NO existe superficie pública preventiva.** La Fase 4 queda fail-closed
según el camino D del árbol de decisión §7.

### Acciones tomadas

1. **Detener la Fase 4**: no se implementará el transporte Hermes Bot Chat.
2. **Conservar `hermes_not_live_bot_chat`**: el reason code ya existe en
   `repociv/server` (18 coincidencias). Se conserva como el reason code
   oficial para este blocker.
3. **Documentar evidencia**: este archivo es la documentación del blocker.
4. **No enviar ningún mensaje de prueba**: está prohibido "enviar para probar"
   porque el fallback ejecutaría `_run_agent` como segundo escritor.

### Piezas que SÍ existen (por separado)

- **HTTP**: `GET /api/sessions?title=Bot Chat&include_hidden=true` →
  determina que una sesión es el Bot Chat canónico.
- **Archivo JSON**: `runtime/active_sessions.json` → tiene leases con pid
  vivo.
- **Python interno**: `find_canonical_live_owner()` → cruza lease + pid vivo
  + tip del Bot Chat.

### Pieza que NO existe

- **Superficie pública (HTTP ni CLI) que combine ambas verificaciones de
  forma atómica y previa al envío.**

## Referencias

- Plan canónico: `docs/plans/2026-09-21-live-session-chat-multiharness.md`
  (§§8, 8.3, 14, 15)
- Evidencia externa: `docs/EXTERNAL_AGENTS.md` (línea 165: "Hermes |
  `~/.hermes/runtime/active_sessions.json`: el arriendo que Hermes usa para
  que dos procesos no escriban una sesión, con su `pid` | exacta (id de
  sesión ↔ pid, revalidando que el pid siga siendo un proceso `hermes`)")
- Router/adaptadores: `server/live_session_chat.py`
- Descubrimiento Hermes: `server/hermes_sessions.py`
- Liveness de sesiones: `server/session_liveness.py`
- Endpoint público Hermes: `gateway/platforms/api_server.py` (route table
  líneas 1583–1624)
- CLI peer: `hermes_cli/subcommands/peer.py`
- Registry de leases: `hermes_cli/active_sessions.py` (líneas 711–742)
- Entrega viva del bot: `tools/bot_live_delivery.py`
