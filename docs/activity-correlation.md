# Actividad y Crónica: contrato de evidencia

## Fuentes e identidades

- **Orquestador:** `/tasks` conserva `taskKey` (repo/issue) y fases declaradas. `TaskRunLinked` enlaza explícitamente una ejecución `runId` con `taskKey`; `TaskPhaseRecorded` conserva cambios de fase en el Event Store canónico.
- **Comandos/ejecuciones:** eventos del Event Store con `commandId`. `CommandCompleted` confirma el comando, no valida el éxito de una tarea. Cancelar la tarea en el orquestador tampoco confirma que todos sus procesos hayan salido.
- **Procesos del SO:** `/api/agent-processes` sigue usando el inventario del UID local y los descendientes de agentes reconocidos. `processIdentity` combina boot ID, PID y ticks de inicio de `/proc/<pid>/stat`. `ProcessBound` enlaza esa identidad con un comando y agente cuando el runner tiene evidencia directa.
- **Kanban de Hermes y sesiones de agentes:** siguen siendo entidades separadas, en sus paneles existentes. No hay un vínculo canónico universal entre task ID del Kanban, sesión Hermes, `taskKey` del orquestador y PID. No se los fusiona por nombre, hora ni similitud.

## Reglas de correlación

1. La selección/color se basan en `task:<taskKey>` cuando hay un único vínculo de ejecución; de lo contrario, `run:<commandId>`.
2. Un PID necesita identidad de proceso y un `ProcessBound` explícito. Los descendientes pueden heredar el vínculo de un ancestro observado en el mismo inventario, con identidad presente, mismo boot y tiempo de inicio no posterior al hijo. Un `rootPid` aislado no basta.
3. Vínculos a varios comandos son ambiguos incluso si pertenecen a la misma tarea: se muestra **sin correlación**. El PID no es una identidad histórica.
4. Desaparición del inventario, silencio o error HTTP nunca declaran éxito ni terminalidad. Se conservan eventos históricos y se advierte cuando el inventario anterior puede estar desactualizado.
5. Resultado del comando y fase declarada por el orquestador se muestran como evidencias distintas, no como validación independiente del trabajo.

## UI y privacidad

Tareas activas y Crónica comparten selección, etiquetas y color determinista. Las flechas de PID/PPID indican estructura de procesos, no tareas auxiliares nuevas. La navegación mantiene un solo panel visible y un solo propietario del refresco existente; el otro se actualiza bajo demanda. Las entradas de panel se registran sin imports circulares. Se conserva foco por control, no solo por tarea, y se evita reemplazar HTML idéntico.

`/log?n=500&metadata=1&paged=1` proyecta metadatos permitidos sin actor, argv, prompts, entorno, output ni resultados arbitrarios. Lee páginas del JSONL canónico en orden de append, con cursor byte-offset, hasta 500 metadatos y 256 KiB de lectura por consulta. La carga explícita de páginas anteriores mantiene accesible el historial sin reenviar todo el archivo en cada poll. Las páginas ya cargadas se conservan al refrescar la cola; no introduce un almacén paralelo. La vista sólo acredita eventos cargados, no una historia completa. `run:` significa comando; sólo un `TaskRunLinked` acredita pertenencia al orquestador. El cliente vuelve a proyectar los campos permitidos y descarta `AgentOutputChunk` por defensa ante bridges anteriores.

Un bridge anterior puede ignorar `metadata=1` y carecer de `processIdentity`. La UI avisa **ventana histórica limitada** y no inventa vínculos para esos PID. Activar el backend nuevo requiere recargarlo de forma segura; no se reinició el bridge durante esta verificación para evitar interrumpir agentes existentes. Los vínculos no se reconstruyen retroactivamente para ejecuciones antiguas.

## Evidencia de verificación

- `bash scripts/check.sh`, ejecutado con afinidad de dos CPU para limitar forks: verde; 107 archivos / 1114 pruebas frontend y 1259 pruebas backend, con 2 omitidas. TypeScript, ESLint, Prettier, build y Ruff incluidos. Knip es informativo; mypy no instalado y omitido por el script.
- El primer gate con concurrencia por defecto falló por un worker Vitest que terminó inesperadamente. No se contó como éxito; el reintento completo acotado sí finalizó con exit 0.
- `e2e/activity-correlation.spec.ts`: dos pruebas con paneles reales y respuestas interceptadas, a 1280 y 390 px. Verifican color compartido, navegación bidireccional, filtro, teclado/foco, identidad sin vínculo, inventario fallido, conservación tras desaparición y límites horizontales. No equivalen al dashboard completo.
- `REPOCIV_LIVE_INVENTORY=1 ... activity-live.spec.ts`: dashboard completo, consultas reales sin escribir tareas ni lanzar agentes. En la última ejecución coincidieron exactamente 66 PID con la respuesta usada por el panel; se navegaron por teclado selección/Crónica y se observaron 30 enlaces de eventos. Tras corregir la paginación, el mismo recorrido pasó con 79 PID y 30 enlaces. El bridge real seguía siendo anterior: no acredita correlaciones nuevas PID↔ejecución.
- Los tres recorridos anteriores pasaron juntos. La automatización con mouse del dashboard completo tuvo timeout durante los refrescos; no se presenta como aprobada. Mouse y móvil están acreditados en el harness aislado, no en toda la aplicación.

La revisión adversarial detectó el reenvío ilimitado de historia: se sustituyó por páginas canónicas acotadas, con pruebas de 1200 eventos, progreso del cursor ante una línea sobredimensionada, recorrido completo sin duplicaciones y carga de historia anterior en navegador. Las identidades con separadores malformados se rechazan. El boot ID real procede del kernel y `exec` conserva el PID; se documenta que un spawn demasiado corto puede no obtener vínculo, sin reconstruirlo por heurística.

Capturas y logs de esta ejecución se conservaron bajo `$TMPDIR/repociv-activity-paged-browser/` y `$TMPDIR/repociv-activity-resumed-gates.log`; no son fuentes persistentes del producto.
