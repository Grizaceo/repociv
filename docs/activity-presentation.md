# Actividad: presentación humana sin identidad inventada

## Antes / después

En `9ee35f4`, la lista de procesos tiene como títulos PID y claves `task:…` / `run:…`; el lector debe reconstruir la ejecución y distinguir software, propietario y tarea por su cuenta. La tabla mezcla identidad, estructura del proceso y correlación.

La nueva vista usa tarjetas compactas por ejecución o árbol externo. Prioriza nombre de unidad seguro, agente registrado o descripción del tipo de comando. Los identificadores opacos quedan en el detalle. Estado, propietario, harness/profile y pertenencia a tarea ocupan capas distintas. Raíces/descendientes se resumen y expanden; las tareas existentes siguen en una sección secundaria. El color compartido se complementa con título, etiquetas y símbolo.

## Matriz de evidencia

| Dato | Fuente | Identificador de enlace | Fiabilidad / límite | Historia |
|---|---|---|---|---|
| Comando y tipo | Event Store; `CommandCreated` / `ExecutionIdentityRecorded` | `commandId` | Tipo validado del comando; no se usa prompt/payload como título | JSONL canónico, páginas acotadas |
| Harness | Rama efectiva de dispatch de `server/agent_runner.py` | `commandId` | Intento registrado; no demuestra spawn, trabajo activo ni éxito. Fallbacks se presentan como varios intentos | Nuevos eventos `ExecutionIdentityRecorded`; no retroactivo |
| Proveedor / modelo | Selección enviada al gateway o adaptador | `commandId` | Selección, no verificación del modelo servido; `auto` y valores no pasados se omiten | Opcional, detalle de cada intento |
| Profile | `config.profile` que Hermes CLI usa como `HERMES_HOME` | `commandId` | Sólo basename y sólo `hermes-cli`; otro harness no acredita que cargó ese profile | Opcional, identidad registrada del intento |
| Agente | `display_name` de la entrada de registro seleccionada | `commandId` | No se fabrica desde ejecutable, familia, prefijo, UUID o `agentId` legacy | Opcional, identidad registrada |
| Unidad | Enlace exacto `sessions.get(unit_id).unitId == unit_id`; la sesión canónica alimenta la rematerialización de unidades | `commandId` + `unitId` | Excluye `MAIN` genérico; no basta un prefijo ni estar en el registro de profiles. Vinculada históricamente, no necesariamente viva/materializada ahora | Opcional; ID completo en detalle, nombre humano si hay evidencia |
| Sesión nativa | Session store / trackers específicos del harness | Identificador nativo de cada adaptador | No existe vínculo universal acreditado con esta proyección. No se equipara al profile ni a la unidad | No se exporta un ID nativo viejo como sesión de esta ejecución |
| Proceso y parentesco | `/api/agent-processes`, `/proc` del UID actual | boot ID + PID + ticks; PPID de la misma muestra | Observación actual; no prueba trabajo activo. Herencia sólo con ancestro acreditado, mismo boot e inicio no posterior | Inventario actual; `ProcessBound` conserva vínculo histórico explícito |
| Tarea del orquestador | `/tasks`; `TaskRunLinked` / `TaskPhaseRecorded` | `taskKey` + `runId` | Sólo vínculo explícito; no Kanban, sesión ni proximidad temporal | Eventos canónicos cargados |
| Resultado | `CommandCompleted/Failed/Cancelled/Rejected` | `commandId` | Resultado del comando, no validación independiente de la tarea | Eventos canónicos cargados |

## Reglas de presentación y continuidad

- Cada `run:<commandId>` conserva tarjeta propia aunque comparta tarea con otra ejecución. Selección y color mantienen la clave acreditada de correlación con Crónica.
- Identidad opcional ausente no se completa por heurística. Conflictos cierran el campo ambiguo, no eliminan los otros datos independientes conocidos.
- Un fallback que cambia harness conserva la unidad acreditada; el título no adopta el último snapshot como dueño. Un profile presente sólo en algunos intentos queda en el detalle, no describe toda la ejecución.
- Los árboles externos tienen software/familia observados, propietario desconocido y harness no acreditado. Son actividades normales, no nuevas tareas.
- `Sin unidad vinculada`, `Propietario desconocido` y `Inventario no disponible` significan cosas distintas. Un error conserva el último inventario con aviso de posible desactualización.
- Conservación de foco por control, expansión por tarjeta y scroll durante reconstrucciones. HTML idéntico no se reemplaza. No se añade polling paralelo ni almacén persistente.
- `Ver Crónica` mantiene selección; `Ver unidad` reutiliza `focusOwnChat`: si no está materializada, abre la lista de agentes, no inventa una unidad.
- Proveedor/modelo y ausencia de enlace a sesión nativa se explican en detalle, separados del harness/profile/agente/unidad.
- Backend y cliente proyectan campos seguros: sin argv, prompt, output, entorno, credenciales ni rutas de profile. IDs técnicos quedan disponibles en los detalles.

## Verificación y aplicación

- Pruebas unitarias aisladas cubren identidad parcial, unidad, profile sin unidad, harness sin propietario, descendientes, ambigüedad, procesos terminados, PID reciclado y varios runs por tarea.
- Backend aislado: Event Store temporal, sesiones/run-state temporales, callbacks de misión/notificación sustituidos y adaptadores simulados; ningún agente real se inicia.
- Dos recorridos aislados de correlación (1280/390 px) verifican teclado, selección/color, Crónica bidireccional, acceso real al handler de unidad con objeto en memoria, historial paginado y errores.
- Dos recorridos adicionales (1280/390 px) cubren 44 tarjetas, identidad parcial/ambigua, descendientes añadidos, retención de foco/expansión/scroll y fallo del inventario. Los cambios de fixture se controlan explícitamente, no con carreras de temporizador.
- Dashboard real: comprobaciones sólo de lectura, teclado, agrupación, límites desktop/mobile; prueba live compara PID de la misma respuesta con DOM. No demuestra asociaciones positivas nuevas harness/profile/unidad si el bridge no ha recargado el backend.
- Contraste medido de texto principal/secundario de tarjetas: aproximadamente 15.79:1 sobre fondo opaco. Los paneles se elevan sobre el HUD del mapa para que éste no tape encabezados ni controles, sin superar diálogos/tutorial.
- Capturas antes/después reproducen los mismos datos aislados con frontend `9ee35f4` y frontend actual. Capturas live separadas: no presentar fixtures como asociaciones del sistema real.

`repociv.service` supervisa bridge **y Vite** mediante `scripts/dev-start.sh`, con `KillMode=control-group`. Reiniciarlo interrumpe todo ese grupo. No se reinició durante este cambio. El frontend se actualiza por recarga/HMR; el nuevo registro backend requiere una recarga segura del servicio. Ejecuciones antiguas no reciben identidad retrospectiva. Hermes y su Kanban permanecen intactos.

Los conteos finales y los logs reales de gates se entregan en el cierre de la sesión; esta documentación no sustituye su ejecución.
