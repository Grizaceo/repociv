# Live-session chat multiharness

**Fecha:** 2026-09-21  
**Estado:** diseño aprobado; revisado 2026-09-21 con reorden de rollout aprobado; Fases 1–5 implementadas (Fase 5: canal proceso-owned `server/claude_live.py`, 2026-09-23); Fase 6 (SSE) no iniciada  
**Rama de trabajo:** `feat/external-agents-chat`  
**Alcance:** RepoCiv bridge + frontend; sin cambios al core de Hermes  
**Gates de evidencia:** cada adaptador permanece fail-closed hasta pasar su probe (§13.7). El probe del gateway Hermes está descrito en §8.3 de este documento; `docs/EXTERNAL_AGENTS.md` solo registra los caminos explorados el 2026-09-19.

## 0. Revisión 2026-09-21

Tras verificar el source de Hermes (`~/.hermes/hermes-agent`) y las CLIs instaladas:

1. **Rollout reordenado: Codex → Hermes (solo Bot Chat) → Claude Code.** Codex es el único harness con una primitiva oficial para enviar a una sesión existente: `codex queue`, verificada en codex-cli 0.155.1.
2. **La pregunta Hermes "¿el gateway escribe a la sesión viva?" está respondida por el source: no, salvo el Bot Chat.** `_admit_to_live_bot_chat` (`gateway/platforms/api_server.py`) solo entrega al dueño vivo del Bot Chat canónico; para el resto, *"a peer turn into any other session runs here"*, es decir, `_run_agent` dentro del gateway. El docstring de `_answer_through_live_bot_chat` (`:3222`) lo llama *"a second writer beside the lease holder"*.
3. **El Bot Chat canónico es una sesión `hidden`, y RepoCiv descarta las sesiones `hidden`** (`server/hermes_sessions.py:391`). Hoy ninguna sesión Hermes visible en RepoCiv es direccionable por el gateway.
4. **Body Hermes corregido:** el campo es `message` (o `input`), no `content` (`_session_chat_user_message`, `api_server.py:646`).
5. **`Idempotency-Key` no aplica a `/api/sessions/{id}/chat`:** `_handle_session_chat` (`:3311`) no lo lee. Ningún transporte de V1 es idempotente.
6. **Respuestas Hermes añadidas al mapeo:** `202 hermes.session.chat.queued` (handoff al Bot Chat) y `429` (cap de concurrencia del gateway).
7. **Exposición de red:** `~/.hermes/config.yaml` declara `platforms.api_server.host: 0.0.0.0`. Crear `API_SERVER_KEY` convierte el gateway en una API de agentes autenticada alcanzable desde la red local. Decisión del owner pendiente (§8.6).
8. **SCOPE:** `docs/SCOPE.md` (F1) dice que una sesión externa abre F8 "en modo solo lectura". Habilitar el primer transporte exige actualizar `SCOPE.md` y `SCOPE.en.md`.

Consecuencia: con los transportes verificables hoy, la mayoría de las sesiones nacidas en una terminal seguirán `unavailable`. El camino realista para Claude Code —y para Hermes fuera del Bot Chat— es que RepoCiv sea dueño del proceso desde su arranque, la línea de sesiones propias ya iniciada (`9be47cd`, `fcd8a91`).

## 1. Problema

RepoCiv puede leer sesiones externas y reanudar sesiones quietas, pero no tiene un canal seguro para escribir a una sesión cuyo proceso sigue vivo. El endpoint actual `POST /api/external-agents/{id}/reply` rechaza ese caso con `session_is_live` para evitar abrir un segundo proceso sobre el mismo historial.

La solución no puede ser exclusiva de un harness. El objetivo del producto es un compositor multiharness para sesiones vivas de:

1. Codex;
2. Hermes;
3. Claude Code.

Los transportes pueden habilitarse por etapas, pero el contrato, el modelo de capacidades y la separación por adaptadores deben existir desde V1. Una sesión observada no es necesariamente una sesión direccionable: RepoCiv debe decir la verdad sobre esa diferencia.

## 2. Decisiones aprobadas

1. **Contrato multiharness desde V1; transportes por etapas.**
2. **V1 síncrona sobre `POST /chat`; SSE después.** Síncrona significa que la solicitud espera la decisión del transporte —aceptada, completada o rechazada—, no que todos los harnesses deban terminar el turno antes de responder.
3. **`/reply` permanece intacto.** Sigue siendo el camino para reanudar una sesión quieta mediante un nuevo proceso controlado.
4. **`/chat` es solo para sesiones vivas.** No se usa como alias oportunista de `/reply`.
5. **RepoCiv transporta el contrato de concurrencia del harness; no inventa otro.** Un `busy`, una cola o un rechazo solo existen si el transporte real los declara.
6. **El compositor solo se habilita cuando la capacidad es `available`.** No hay envíos optimistas hacia transportes desconocidos.
7. **Orden de rollout:** Codex → Hermes (solo Bot Chat con dueño vivo) → Claude Code. Reordenado el 2026-09-21; el orden original era Hermes → Claude Code → Codex (ver §0).
8. **No se modifica `~/.hermes/hermes-agent`.** La integración se implementa en RepoCiv contra superficies públicas o CLIs soportadas.

## 3. No objetivos

- No unificar ni reemplazar el almacenamiento de transcript de cada harness.
- No abrir un segundo proceso para simular escritura sobre una sesión viva.
- No controlar sesiones de Claude Code mediante `tmux send-keys` como contrato general.
- No exponer `API_SERVER_KEY` al navegador.
- No crear un job store paralelo en RepoCiv para V1.
- No implementar SSE, cancelación remota ni streaming token a token en V1.
- No modificar recovery, wonders, Prettier R1, HMAC R2 ni otras deudas cerradas.
- No introducir Docker o Docker Compose.

## 4. Contrato HTTP de RepoCiv

### 4.1 Transcript existente

```http
GET /api/external-agents/{repociv_session_id}/chat
```

Continúa devolviendo el transcript normalizado por el tracker.

### 4.2 Nuevo envío

```http
POST /api/external-agents/{repociv_session_id}/chat
Content-Type: application/json
Authorization: <contrato actual del bridge>

{"text":"mensaje"}
```

El método HTTP distingue lectura y escritura sobre la misma ruta.

### 4.3 Flujo del request

1. Autenticar mediante el mecanismo existente del bridge.
2. Parsear JSON con el límite global del bridge.
3. Validar `text`: string, no vacío tras `strip()`, y bajo el límite de longitud definido.
4. Resolver `repociv_session_id` contra el snapshot del tracker.
5. Leer del `Observation` real: `agent`, `native_id`, `profile`, `live` y `source`.
6. Rechazar si la sesión no existe o no está viva.
7. Resolver un adaptador por harness.
8. Consultar su capacidad para esa sesión concreta.
9. Crear un `request_id` opaco para trazabilidad.
10. Delegar la entrega sin reimplementar el estado interno del harness.
11. Devolver la decisión del transporte.

El cliente nunca proporciona `native_id`, `profile`, transportes, comandos, URLs ni rutas de secretos. Todos se derivan del snapshot server-side.

### 4.4 Respuesta exitosa común

```json
{
  "state": "accepted",
  "transport": "codex-queue",
  "requestId": "opaque-id"
}
```

Estados:

- `accepted`: el harness confirmó que recibió o encoló el mensaje; el turno puede seguir ejecutándose.
- `completed`: el transporte terminó el turno antes de responder.

El frontend no presupone cuál corresponde a cada harness. Después de ambos, vuelve a consultar el transcript existente.

### 4.5 Errores propios del bridge

| HTTP | Código | Significado |
|---|---|---|
| 400 | `invalid_json` | Body no parseable. |
| 404 | `unknown_session` | La fila ya no está en el snapshot. |
| 409 | `session_not_live` | `/chat` no abre ni reanuda sesiones quietas. |
| 413 | `message_too_large` | Mensaje sobre el límite. |
| 422 | `empty_message` | Mensaje vacío. |
| 501 | `transport_unavailable` | El harness existe, pero esta sesión no tiene canal seguro habilitado. |
| 502 | `transport_failed` | Fallo local al invocar el transporte. |
| 504 | `transport_timeout` | El transporte no decidió dentro del timeout. |

Un error upstream conserva su status y body, sujeto únicamente a la redacción de secretos. RepoCiv no transforma un rechazo del gateway en `session_is_live`, ni convierte una aceptación en “completado”.

## 5. Modelo de capacidad

Cada fila de sesión debe exponer capacidad concreta, no una inferencia global por nombre del agente:

```json
{
  "liveChat": {
    "state": "available",
    "transport": "codex-queue",
    "reason": null
  }
}
```

Estados:

- `available`: existe un canal verificado para esa sesión.
- `probe_required`: existe un transporte candidato, pero aún no se demostró que escriba a la sesión viva correcta.
- `unavailable`: no existe un canal seguro para esa sesión o faltan prerrequisitos observables.

`reason` es un código estable y no contiene excepciones, comandos completos, rutas sensibles ni valores de credenciales.

Ejemplos de razones:

- `codex_probe_pending`
- `codex_queue_unavailable`
- `hermes_not_live_bot_chat`
- `hermes_probe_pending`
- `profile_key_unavailable`
- `claude_control_channel_unavailable`
- `unsupported_session_source`

## 6. Arquitectura

```text
Browser
  │ POST /api/external-agents/{repociv_id}/chat
  ▼
RepoCiv bridge
  │ auth + validation + snapshot lookup
  ▼
LiveSessionChatRouter
  ├── CodexLiveChatAdapter   ── argv subprocess ─ codex queue
  ├── HermesLiveChatAdapter  ── HTTP loopback ── Hermes API server (solo Bot Chat)
  └── ClaudeLiveChatAdapter  ── control channel ─ Claude Code session
```

### 6.1 Router

Responsabilidades:

- elegir el adaptador por el `agent` normalizado del `Observation`;
- consultar y publicar capacidad;
- entregar `Observation`, texto y `request_id` al adaptador;
- aplicar límites comunes de mensaje y tiempo;
- no conocer detalles de comandos Codex, HTTP Hermes o procesos Claude.

Interfaz conceptual:

```python
class LiveChatAdapter(Protocol):
    def capability(self, session: Observation) -> ChatCapability: ...
    def send(
        self,
        session: Observation,
        text: str,
        request_id: str,
    ) -> ChatResult: ...
```

Los tipos concretos pueden vivir en un módulo nuevo, por ejemplo `server/live_session_chat.py`, para no profundizar `bridge.py` ni `suvadu_tracker.py` con lógica de transporte.

### 6.2 Tracker

El tracker sigue siendo la fuente server-side para resolver:

- ID de RepoCiv;
- harness;
- ID nativo;
- perfil;
- fuente;
- liveness.

Debe ofrecer una lectura segura del `Observation` correspondiente, no entregar su referencia mutable interna. El router no debe reconstruir el ID nativo desde strings cuando ya existe `Observation.native_id`.

## 7. Adaptador Codex

### 7.1 Transporte disponible

codex-cli 0.155.1 ofrece:

```text
codex queue --thread <THREAD> --message <TEXT>
```

`--thread` acepta *"Session UUID or exact session name"*. El tracker deriva `native_id` del ID Suvadu `codex-<uuid>` (`_native_of`, `server/suvadu_tracker.py:274`), y el transcript vive en `rollout-<ts>-<native_id>.jsonl`, así que el `native_id` debería ser el UUID que espera `--thread`. Se confirma en el probe (§13.7).

El adaptador debe invocarla mediante una lista argv, nunca mediante una cadena shell. Los valores van en la forma `--opt=valor` para que un mensaje que empiece con `-` no se interprete como flag:

```python
[
    codex_bin,
    "queue",
    f"--thread={session.native_id}",
    f"--message={text}",
]
```

El límite de longitud del mensaje debe quedar bajo el máximo de un argumento de proceso en Linux (`MAX_ARG_STRLEN`, 128 KiB).

Se espera que una salida exitosa confirme aceptación en cola; el resultado común será normalmente `state=accepted`. El transcript existente permite observar la respuesta posterior. El formato real de esa confirmación se verifica en el probe.

### 7.2 Incógnita: daemon app-server

`codex queue` acepta `--remote <ADDR>`, y `codex agents` lista sesiones *"on the shared local app-server daemon"*. Falta demostrar:

- si `queue` alcanza una sesión TUI abierta en una terminal común o solo sesiones alojadas en ese daemon;
- si invocarlo arranca el daemon como efecto lateral;
- qué hace ante un thread inexistente o no vivo.

La capacidad refleja la respuesta. Por ejemplo, `available` solo para sesiones alojadas en el daemon, si esa es la condición real.

### 7.3 Capacidad

`available` requiere:

- binario Codex detectable;
- `native_id` no vacío;
- sesión viva según el tracker;
- fuente e ID compatibles con `codex queue`;
- la condición de alcance de §7.2, una vez conocida;
- probe local exitoso contra una sesión controlada.

Una salida no cero se traduce en `transport_failed` sin incluir stdout/stderr crudos si pudieran contener datos sensibles. Los códigos funcionales estables deben derivarse de evidencia conocida, no de regex optimista sobre texto humano.

## 8. Adaptador Hermes (solo Bot Chat)

### 8.1 Evidencia del source

`POST /api/sessions/{id}/chat` (`_handle_session_chat`, `gateway/platforms/api_server.py:3311`) tiene dos caminos:

1. `_answer_through_live_bot_chat` → `_admit_to_live_bot_chat`: si la sesión es la línea del Bot Chat canónico y un Desktop la tiene viva, el mensaje va al mailbox del dueño (`tools/bot_live_delivery.py`, entrega at-most-once).
2. En cualquier otro caso, el gateway corre `_run_agent` con el historial de la sesión: un segundo escritor junto al proceso vivo, justo lo que prohíbe §3.

Además, el Bot Chat canónico es `hidden` (`hermes_state_sessions.py`, `CANONICAL_BOT_CHAT_TITLE`), y `server/hermes_sessions.py:391` descarta las sesiones `hidden`. Hoy RepoCiv no muestra ninguna sesión Hermes direccionable por esta vía.

### 8.2 Transporte candidato

Para el perfil default:

```text
POST http://127.0.0.1:8742/api/sessions/{native_id}/chat
```

Para un perfil nombrado, el listener multiplexado registra `/p/{profile}/...`; se usa solo si el probe lo verifica:

```text
POST http://127.0.0.1:8742/p/{profile}/api/sessions/{native_id}/chat
```

El host correcto es `127.0.0.1`; se corrige el typo `127.0.0.0.1` del handoff original.

Body mínimo:

```json
{"message":"mensaje"}
```

Headers del bridge al gateway:

- `Authorization: Bearer <profile-scoped API_SERVER_KEY>`
- `Content-Type: application/json`

Esta ruta no lee `Idempotency-Key`. Enviarlo es inocuo, pero no aporta garantía y no debe tratarse como tal.

### 8.3 Gate de seguridad obligatorio

La capacidad solo puede ser `available` si RepoCiv determina **antes de enviar**, mediante una superficie pública, que:

1. la sesión pertenece a la línea del Bot Chat canónico; y
2. existe un dueño vivo para ese Bot Chat.

No se puede “enviar y ver qué pasa”: si la condición no se cumple, el gateway ya habrá corrido `_run_agent` como segundo escritor. Mientras no exista esa superficie de detección, todas las sesiones Hermes quedan `unavailable` con `hermes_not_live_bot_chat`.

Con la detección resuelta, el probe E2E debe demostrar que el mensaje llegó a la sesión activa observada y que no abrió un segundo escritor sobre el mismo historial. Debe registrar:

- ID de RepoCiv y `native_id` comparados sin publicarlos fuera del entorno local;
- proceso vivo antes y después;
- comportamiento durante un turno en curso: rechazo, cola o entrega;
- nuevo mensaje en el transcript esperado;
- ausencia de una sesión duplicada inesperada.

Para sesiones Hermes que no son Bot Chat, el adaptador sigue deshabilitado hasta encontrar una superficie oficial que controle el proceso vivo.

### 8.4 Mapeo de respuestas

| Upstream | Resultado RepoCiv |
|---|---|
| `200` `hermes.session.chat.completion` | `completed` |
| `202` `hermes.session.chat.queued` | `accepted` |
| `429` (cap de concurrencia) | passthrough |
| `4xx`/`5xx` restantes | passthrough |

Los status y bodies del gateway se devuelven sin reinterpretar su semántica. El bridge puede agregar metadata no sensible fuera del body upstream solo si no rompe el passthrough acordado; la primera implementación debe preferir el body exacto.

### 8.5 Secretos y perfiles

- Nunca cargar `~/.hermes/.env` mediante un `load_dotenv()` global que pueda sobrescribir el entorno del bridge.
- Usar un lector dedicado que extraiga únicamente `API_SERVER_KEY` del archivo esperado para el perfil.
- No retornar, registrar, interpolar en excepciones ni conservar el valor.
- No aceptar una ruta de `.env` desde el cliente.
- No reutilizar la key del perfil default para un perfil nombrado.
- La ausencia de key produce `profile_key_unavailable`, sin revelar rutas o valores.

### 8.6 Decisiones del owner antes de la Fase 4

1. **Exposición de red.** El gateway escucha en `0.0.0.0:8742` (`~/.hermes/config.yaml`, `platforms.api_server.host`). Hoy responde `401` a todo porque falta la key. Crear `API_SERVER_KEY` lo deja como API autenticada alcanzable desde la red local. RepoCiv solo necesita loopback (bridge → gateway). Cambiar a `127.0.0.1` es una edición de dotfile y la decide el owner.
2. **Visibilidad del Bot Chat.** Hoy queda oculto por `server/hermes_sessions.py:391`. Mostrarlo en el panel cambia qué datos presenta RepoCiv y lo decide el owner.

## 9. Adaptador Claude Code

### 9.1 Estado actual

Claude Code 2.1.278 expone:

- `claude agents --json`, que lista sesiones activas interactivas y background;
- `claude attach <id>`, interactivo y solo para sesiones background;
- `claude --bg`, más `logs`, `stop`, `respawn` y `rm` para background agents;
- `--input-format stream-json`, solo con `--print`, para procesos controlados por su host.

No existe un subcomando equivalente a `codex queue` para inyectar un mensaje de forma no interactiva en una sesión viva existente.

### 9.2 Restricciones

- No usar `claude --resume <id> -p` sobre una sesión viva: puede iniciar otro proceso o copia y viola el objetivo.
- No usar `tmux send-keys` como transporte general: solo cubre sesiones dentro de tmux conocido, mezcla control de terminal con protocolo de sesión y carece de confirmación robusta.
- No depender de Claude Remote Control cloud sin una decisión separada sobre terceros y exposición de datos.

### 9.3 Camino de habilitación

El adaptador nace registrado pero en `probe_required` o `unavailable`.

Se habilita solo cuando una de estas condiciones tenga evidencia ejecutable:

1. una API/CLI local oficial permite enviar a un ID activo y confirma aceptación; o
2. RepoCiv es propietario del proceso Claude desde su arranque y conserva un canal bidireccional soportado hacia stdin/stdout, con lifecycle y permisos explícitos.

La condición 2 es la realista con la CLI actual y enlaza con las sesiones propias de RepoCiv.

La capacidad debe poder ser `available` para algunas sesiones Claude y `unavailable` para otras. El contrato multiharness no implica fingir direccionabilidad universal.

## 10. Frontend

1. `ExternalSessionRow` incorpora `liveChat`.
2. El compositor de una sesión viva se habilita solo con `liveChat.state === "available"`.
3. El envío usa `POST /api/external-agents/{id}/chat`.
4. Durante la solicitud, se bloquea el doble click local.
5. Ante `accepted` o `completed`, se refresca el transcript mediante el polling actual.
6. Un error upstream se muestra sin cambiar su significado.
7. `probe_required` y `unavailable` muestran una explicación corta; no habilitan el input.
8. SSE y streaming quedan fuera de V1.

El frontend no selecciona adaptadores ni construye IDs nativos. El primer transporte `available` esperado es Codex.

## 11. Idempotencia y concurrencia

- El bridge genera un `request_id` por intento de usuario, para trazabilidad.
- Ningún transporte de V1 ofrece deduplicación: `codex queue` no declara una primitiva idempotente, `/api/sessions/{id}/chat` de Hermes no lee `Idempotency-Key`, y Claude aún no tiene transporte.
- Un transporte solo se marca como idempotente si ofrece una primitiva equivalente o el bridge puede demostrar la deduplicación sin crear un job store ambiguo.
- En ausencia de esa garantía, ni el bridge ni la UI reintentan automáticamente.
- RepoCiv no mantiene un `busy` paralelo para decidir si el harness acepta el mensaje. Puede bloquear duplicación de clicks en el cliente, pero el estado real pertenece al transporte.

## 12. Timeout y desconexión

- Cada adaptador declara un timeout explícito.
- Hermes: el camino Bot Chat espera el recibo del dueño durante `_LIVE_WAIT_SECONDS` (300 s hoy, `tools/bot_mode_dm.py`) y luego responde `202 queued`; el timeout del adaptador debe superar esa espera.
- El bridge usa `ThreadingHTTPServer`: una solicitud larga ocupa un hilo sin bloquear las demás.
- Un timeout significa “RepoCiv no obtuvo una decisión”; no significa que el harness no haya recibido el mensaje.
- La respuesta debe advertir esa ambigüedad sin reintento automático.
- La desconexión del navegador no cancela por defecto el turno upstream en V1.
- La cancelación será una decisión separada cuando existan transportes oficiales por harness.

## 13. Plan de pruebas

### 13.1 Unitarias

- Router selecciona Codex, Hermes o Claude por harness normalizado.
- Harness desconocido responde `transport_unavailable`.
- Sesión ausente, quieta o sin `native_id` se rechaza antes del transporte.
- Mensaje vacío o demasiado grande no se envía.
- Capability se calcula por sesión, no solo por tipo de agente.
- El request no puede sobrescribir `native_id`, perfil, transporte o URL.
- Timeout no produce reintento.
- Ningún error contiene una key centinela.

### 13.2 Adaptador Codex

- argv exacto para `codex queue`, con `--thread=` y `--message=`;
- texto se pasa como argumento, no por shell;
- un mensaje que empieza con `-` o `--` llega intacto como valor;
- mensaje sobre el límite de argv se rechaza antes de invocar;
- aceptación, salida no cero y timeout;
- ausencia del binario produce capability no disponible.

### 13.3 Adaptador Hermes

Con servidor HTTP falso:

- forma correcta de URL default y perfil nombrado;
- body `message` correcto;
- Bearer presente en la llamada falsa;
- `200 completion` → `completed`, `202 queued` → `accepted`, `429` y demás errores preservados;
- sesión que no es Bot Chat con dueño vivo → `unavailable`, sin ninguna llamada HTTP;
- key ausente falla sin filtrarla;
- destino no puede salir de loopback.

No usar claves reales en tests.

### 13.4 Adaptador Claude

- capability no disponible sin canal verificado;
- nunca ejecuta `--resume -p` para una sesión viva;
- una implementación futura prueba el canal con un fake owner/control plane.

### 13.5 Integración bridge

Agregar casos al patrón de `server/test_bridge_integration.py`:

- auth requerida;
- `GET /chat` sigue intacto;
- `POST /chat` resuelve el snapshot correcto;
- success `accepted` y `completed`;
- errores propios y passthrough upstream;
- tracker ausente;
- adaptador no disponible;
- dos sesiones con IDs parecidos no se cruzan.

### 13.6 Frontend

- input habilitado solo con capability disponible;
- submit único mientras el request está pendiente;
- polling posterior a `accepted` y `completed`;
- error mostrado sin reinterpretación;
- estados `probe_required` y `unavailable` visibles.

### 13.7 Probes manuales

Los probes reales son gates separados de la suite hermética:

1. `codex queue` contra una sesión Codex controlada: TUI común y, si aplica, sesión alojada en el daemon.
2. Hermes gateway contra un Bot Chat controlado con dueño vivo, una vez resuelta la detección de §8.3.
3. Claude cuando exista canal candidato oficial/controlado.

Cada probe debe tener una condición de éxito y una de aborto; nunca usar una sesión con trabajo irrepetible.

## 14. Secuencia de implementación propuesta

### Fase 0 — Evidencia Codex

- Ejecutar el probe de `codex queue` sin modificar código.
- Responder las incógnitas de §7.2 y las preguntas Codex de §16.
- Documentar el resultado real en `docs/EXTERNAL_AGENTS.md`.
- Decisión booleana: `codex_queue_targets_live_session == true`. Si es falsa, Codex queda `unavailable` y V1 sale solo con el contrato fail-closed.

### Fase 1 — Contrato multiharness

- Añadir tipos de capability y resultado.
- Añadir router y registro de los tres adaptadores.
- Publicar capability en las filas.
- Mantener todos los transportes fail-closed salvo los ya probados.

### Fase 2 — Codex

- Implementar adaptador argv.
- Integrar `POST /chat` con su estado `accepted`.
- Añadir tests unitarios e integración.

### Fase 3 — Frontend V1

- Añadir tipos y cliente POST.
- Habilitar compositor por capability.
- Refrescar transcript por polling.
- Añadir tests.
- Actualizar `docs/SCOPE.md` y `docs/SCOPE.en.md`: una sesión externa viva deja de ser solo lectura cuando su capability es `available`.

### Fase 4 — Hermes (solo Bot Chat)

- Obtener las decisiones del owner de §8.6.
- Encontrar una superficie pública que detecte, antes de enviar, la línea del Bot Chat y su dueño vivo (§8.3). Si no existe, detener la fase.
- Ejecutar el probe del Bot Chat.
- Implementar cargador de key por perfil, cliente loopback y mapeo de respuestas.
- Añadir tests unitarios e integración.

### Fase 5 — Claude Code

- Investigar y probar canal local oficial o proceso-owned.
- Implementar adaptador solo después de evidencia.
- No degradar a `resume` ni a control ciego de TTY.

### Fase 6 — SSE opcional

- Evaluar `/chat/stream` y los canales equivalentes de los otros harnesses.
- Diseñar cancelación, backpressure y reconexión como contrato separado.

## 15. Criterios de aceptación

La feature se considera completa cuando:

- el mismo compositor escribe de forma segura a las sesiones vivas que cada harness hace direccionables: Codex vía `codex queue`, Hermes solo al Bot Chat con dueño vivo y Claude Code solo con canal verificado;
- cada harness usa su canal real, no un segundo proceso que comparte historial;
- sesiones observables pero no direccionables aparecen como no disponibles;
- `/reply` conserva su comportamiento para sesiones quietas;
- errores y busy del upstream no se reimplementan;
- ningún secreto llega al navegador, logs, tests o commits;
- el transcript confirma el turno en la sesión correcta;
- no aparecen sesiones duplicadas por el envío;
- `docs/SCOPE.md` y `docs/SCOPE.en.md` reflejan el nuevo comportamiento;
- tests Python y frontend pasan;
- `bash scripts/check.sh` termina en verde;
- no se hace push sin orden explícita de Cristóbal.

## 16. Preguntas abiertas que requieren evidencia, no preferencia

Codex:

1. ¿`codex queue` alcanza una sesión TUI abierta en una terminal común, o solo sesiones alojadas en el app-server daemon? ¿Arranca el daemon como efecto lateral?
2. ¿Acepta el `native_id` que Suvadu publica sin transformación? La ayuda dice que acepta UUID o nombre exacto.
3. ¿Qué confirmación estable y machine-readable devuelve, y qué código de salida ante un thread inexistente o no vivo?

Hermes:

4. ~~¿`POST /api/sessions/{id}/chat` entrega realmente a una sesión Hermes terminal viva o inicia otro runner?~~ **Respondida por el source (2026-09-21):** inicia otro runner (`_run_agent`), salvo para el Bot Chat canónico con dueño vivo (§8.1).
5. ¿Existe una superficie pública para saber, antes de enviar, si una sesión es la línea del Bot Chat y tiene dueño vivo?
6. ¿Existe una superficie oficial para entregar a una sesión TUI viva que no sea el Bot Chat?
7. ¿Qué key y prefijo requiere cada perfil Hermes nombrado en el listener multiplexado?
8. ¿Qué pasa si ya hay un turno en curso sobre la misma sesión? Parcial: el cap global devuelve `429` y el handoff al Bot Chat puede devolver `202 queued`; falta el caso de la misma sesión.

Claude Code:

9. ¿Claude Code expone un canal local soportado para enviar a una sesión activa arbitraria, o solo a procesos background propiedad del controlador?

Estas preguntas son gates de implementación. No deben resolverse por suposición en código de producción.
