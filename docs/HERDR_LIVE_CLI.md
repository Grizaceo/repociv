# herdr como CLI en vivo

El chat de un agente en RepoCiv es su CLI real: el mismo proceso y la misma
pantalla que ve una terminal conectada a herdr. Este documento registra lo que
se **midió**, para no volver a suponerlo. Todo el código que habla con herdr vive
en `server/herdr_runtime.py`.

## Decisiones

- herdr es el runtime, sin modificar. RepoCiv se conecta al servidor default del
  usuario; una copia privada no vería los agentes abiertos en el CLI.
- Se usa el mismo binario que corre el servidor, porque `observe` va por el
  protocolo interno, que no tiene garantía entre versiones.
- Nunca se usa `terminal session control`: fija el PTY a su tamaño hasta soltarlo
  y admite un solo controlador.
- `REPOCIV_HERDR_SOCKET` sustituye el socket. Un `HERDR_SOCKET_PATH` heredado se
  ignora a propósito: si el bridge nace dentro de un panel de una sesión con
  nombre, ese valor apuntaría a otro servidor.

## Lo medido (herdr 0.9.1, servidor aislado, Claude Code 2.1.314 con Haiku)

### `observe` entrega píxeles, no modos

Los frames son pantalla ya compuesta. **No transmiten ningún modo del PTY**, ni en
los diffs ni en el primer frame: ni pegado entre corchetes (`?2004`), ni cursor de
aplicación (`?1`), ni ratón (`?1000`, `?1006`), ni foco (`?1004`), ni teclado kitty,
ni pantalla alternativa (`?1049`). Tampoco pasan las consultas al terminal, así que
xterm no responde nada al PTY.

Una medición que busque estos modos debe usar la secuencia con su `ESC` y generarla
desde un script. Buscar `?2004h` a secas coincide con la línea de comando `printf`
visible en pantalla y da un falso positivo.

Consecuencias:

| Efecto | Qué se hace |
|---|---|
| xterm no sabe si el panel usa pegado entre corchetes | El pegado no pasa por `onData`: va a `pane.send_input`, que aplica el modo vivo del panel. Pegar por `pane.send_text` envió cada línea como mensaje. |
| xterm no recibe modos de ratón | La rueda y los clics quedan en xterm. La aplicación no los recibe. |
| Shift+Enter llega igual que Enter | Se envía `ESC CR`, que en Claude Code inserta un salto de línea. |
| Teclado kitty desconocido | Sin efecto medido: las flechas crudas (`ESC [ B`) y Shift+Tab (`ESC [ Z`) funcionaron. |

### Sin historial en el stream

`observe` solo entrega la pantalla visible; de 300 líneas llegan las últimas. Las
líneas que suben nunca entran al scrollback de xterm. El historial se pide una vez
al conectarse con `pane.read` (`source: recent`, `format: text`). `format: ansi`
devolvió solo la pantalla: 38 líneas contra 342. `pane.scroll` no sirve: mueve una
posición compartida con las demás terminales.

### Enter no siempre envía

| Forma | Resultado con Claude |
|---|---|
| Carácter a carácter, Enter aparte (como xterm) | Se envía |
| Bloque, pausa de 200 ms, Enter aparte | Se envía |
| `pane.send_input`, pausa de 200 ms, Enter aparte | Se envía |
| Texto corto y `\r` en un solo envío | Se envía |
| Texto largo (~80 caracteres) y `\r` en un solo envío | **No se envía**: `\r` entra como salto de línea |
| `agent prompt --wait` con el cuadro ya ocupado | `agent_prompt_stalled` |

El caso que falla responde `ok` igual, y el texto queda en el cuadro. No se encontró
el umbral exacto: 61 caracteres pasaron, 78 no, y `/zzz…` de 300 sí. Por eso:

- La terminal en vivo no se ve afectada: xterm manda Enter en su propio evento.
- Todo envío programático (Fase 3) debe separar texto y Enter con una pausa, y
  confirmar con `state_change_seq`. El `ok` de herdr no prueba nada.
- `agent_prompt_stalled` no prueba que el mensaje no llegó: un Enter posterior
  envió el contenido acumulado. No reintentar a ciegas.

### Estados

- `pane.agent_status_changed` llegó en unos 220 ms tras el Enter.
- `blocked` se detectó en el diálogo de confianza de la carpeta y en una aprobación
  real de herramienta, antes de ejecutarla, **sin** `herdr integration install`.
- `done` significa terminado y no visto; `idle`, listo. Ambos aceptan entrada.
- `agent start` devuelve `agent_not_ready` si el agente arranca en un diálogo.
- Sin validar: un prompt que herdr no reconozca. Es el fallo más peligroso para un
  RTS y sigue pendiente para la Fase 4.

### Identidad de un panel

- **`pane_id` cambia al mover un panel** entre workspaces (`w1:p4` → `w2:p2`), y
  `HERDR_PANE_ID` en `/proc/<pid>/environ` queda obsoleto. `terminal_id` es estable.
- `observe` acepta `terminal_id` y sigue vivo durante el movimiento.
- El mapeo sesión → panel no lee el entorno: pregunta a herdr con `agent.list` y
  `pane.process_info`, y cruza los PID con la evidencia exacta de cada agente.
  Devin deja `session_locks/<id>.lock`, Claude `~/.claude/sessions/<pid>.json` y
  Hermes su lease. Sin evidencia exacta no hay mapeo: escribir en el agente
  equivocado es peor que no ofrecer el atajo.

### Tamaño y cierre

- `pane.layout` da el tamaño real. El observador con ese tamaño recibe `width` y
  `height` iguales.
- `terminal.closed` llega al cerrarse el panel, y también en `stdout` con código 0
  si el destino no existe.
- Un observador huérfano sale con la siguiente salida del panel (EPIPE).

## Ciclo de vida: pendiente para la Fase 3

`repociv.service` usa `KillMode=control-group`. Un `herdr server` iniciado por el
bridge quedaría en ese cgroup y moriría con el servicio, junto con todos los agentes.
Debe lanzarse fuera, por ejemplo con `systemd-run --user`.

## Seguridad

La terminal equivale a una shell. El proxy de Vite agrega el token, así que en esa
ruta el token no distingue a un cliente de otro: la barrera real es el `Origin`.

- `Origin` obligatorio y dentro de una lista propia: loopback más
  `REPOCIV_TERMINAL_ORIGINS`. `REPOCIV_CORS_ORIGINS` no da acceso a la terminal.
- Token obligatorio, por encabezado. Sin `REPOCIV_TOKEN` la terminal no abre.
- Si el WS no está en loopback (`REPOCIV_REMOTE`), la terminal no abre.
- Solo se adjuntan paneles con un agente detectado.
- La escritura va solo por el WS. No hay POST que escriba en un panel: los POST de
  `/bridge` no validan `Origin` y el proxy les agrega el token.
