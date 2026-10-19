# Mapa de limpieza y modularización

## Alcance y punto de partida

Ordenar RepoCiv por responsabilidades, reducir deuda y alinear su documentación,
**sin añadir features ni cambiar comportamientos**. Este mapa es un backlog de
mantenimiento, no sustituye [SCOPE](SCOPE.md) ni autoriza cambios de arquitectura.

Base inspeccionada: `b93a5b6`, rama `chore/structure-cleanup`. Las dimensiones de
archivos y los avisos que siguen son una fotografía de esa base, no métricas vivas.

### Cerrado

- `8704ae0`: navegación documental y separación de históricos.
- `135b58a` y `fd9f495`: descubrimiento de ejecutables separado en
  `server/cli_discovery.py`, preservando candidatos, orden y fachadas del runner.
- `b93a5b6`: parsing puro separado en `server/harness_output.py`; wrappers del
  runner y 30 casos de caracterización conservados.

Último gate local del corte de código: 1.160 tests frontend; 1.796 backend y
2 omitidos; cobertura backend 83,45 %. Se ejecutó `scripts/check.sh` con afinidad
a dos CPU, sin cambiar tests, umbrales ni configuración del proyecto. Esto no
prueba la causa de los fallos anteriores de workers con concurrencia sin limitar.
El gate local no equivale a haber ejecutado Playwright localmente.
La [ejecución CI de `b93a5b6`](https://github.com/Grizaceo/repociv/actions/runs/39189610612)
terminó con resultado global `success`. Los commits posteriores necesitan su
propia comprobación de CI.

## Orden propuesto

Cada fila es un corte independiente. Los candidatos de extracción requieren
confirmar dependencias y pruebas antes de implementarlos: el tamaño por sí solo
no demuestra que una extracción sea correcta.

| Orden | Trabajo                                                     | Riesgo             | Condición de cierre                                                                   |
| ----- | ----------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| 0     | Verificar CI de la rama y separar resultados gate/e2e       | Bajo, solo lectura | Registrar SHA y resultado de ambos jobs; no confundir un push con CI verde            |
| 1     | Alinear documentación técnica y contribución                | Bajo               | ES/EN coherentes con código y tests, enlaces relativos válidos                        |
| 2     | Clasificar avisos Knip y reducir API exportada sobrante     | Bajo/medio         | Cada retirada justificada por usos reales, sin romper imports dinámicos ni tests      |
| 3     | Extraer geometría pura de `isoLocalRenderer.ts`             | Medio              | Caracterización previa, fachada pública conservada, cobertura y paridad visual        |
| 4     | Separar overlays isométricos por responsabilidad            | Medio              | Orden de dibujo y transformaciones intactos; unitarios y e2e de vista local           |
| 5     | Descomponer bloques del runner y rutas de backend           | Medio/alto         | Un solo bloque por commit; contratos, monkeypatch y efectos preservados               |
| 6     | Separar interacción, cámara y render del renderer principal | Alto               | Gestos, selección, coordenadas y ciclo de vida sin regresiones                        |
| 7     | Cierre de higiene y revisión de la rama completa            | Bajo/medio         | Diff acotado, gates y e2e comprobados, sin artefactos locales; revisar antes de merge |

### Reanudación: corte documental (base `aaa11cc`)

- En la inspección inicial, worktree y remoto de limpieza coincidían en
  `aaa11cc`; [su CI](https://github.com/Grizaceo/repociv/actions/runs/39196183046)
  terminó con `gate: success` y `e2e (Playwright): success`.
- READMEs ES/EN: fatiga ubicada en `GameState`; API real de prioridad,
  criterios y rangos 60/35/15 cotejados contra implementación, tests y panel.
  Atajos cotejados contra `hudWiring/hotkeys.ts` y renderer: sesiones mediante
  wizard, cámara con WASD/flechas, Ctrl+A/Ctrl+S y slots de sesión (no salas).
  Se distingue Gaceta de noticias del log de actividad F10. La doble escucha de
  `N` (perfiles/widget) se documenta, **no se corrige** en este corte.
- Revisión adversarial realizada y corregida: atribuciones a SCOPE, fallback de
  Ctrl+Q y correspondencia tecla/harness. La fórmula de longitud de ruta se
  documenta literalmente: con `size = -3`, `Math.min(..., 30)` no impone un
  límite inferior de −30. No se altera ese comportamiento.
- CONTRIBUTING se alinea con SCOPE, roadmap archivado y gate ejecutable.
  No se modifican snapshots históricos, código, configuración ni umbrales.
- Gate local de reanudación: `taskset -c 0,1 bash scripts/check.sh`, CPUs
  seleccionadas de la afinidad permitida. Resultado: 1.160 tests frontend;
  1.796 backend, 2 omitidos; cobertura backend 83,45 %. Presupuestos aprobados:
  atlas 5.318 KiB, props 719 KiB y eager JS 154 KiB gzip. Mypy no instalado;
  Knip informa avisos no bloqueantes. Este gate corresponde al mismo árbol de
  código; los cambios son documentales.
- Comprobaciones del corte: 57 destinos de enlaces relativos válidos; 48 tests
  dirigidos de prioridad, fatiga, renderer e inputs aprobados. Playwright local:
  `activity-presentation.spec.ts` y `approval-expiry.spec.ts`, **5 tests aprobados**
  en Chromium con workspace sintético, estado scratch aislado, puertos 5373–5375,
  dos CPUs y un worker. Sin ejecución de agentes/modelos. No es la suite e2e completa.

**Siguiente corte:** clasificar Knip (2), sin retirar exports por el solo informe.
No empezar simultáneamente frontend y backend. Las comprobaciones 0–1 se registran
arriba; las filas siguen describiendo las condiciones de cada trabajo.

## 1. Documentación: hallazgos de base atendidos

Hallazgos de la base corregidos en el corte documental (se conservan aquí como
trazabilidad, no como deuda aún abierta):

- El árbol y el diagrama mencionan `src/fatigue.ts`, que no existe. La lógica
  correspondiente vive en `src/game.ts`; `src/fatigue.test.ts` importa `GameState`.
- Se presenta `computePriorityScore(fileNode, weights)` como API de
  `src/priorityMatrix.ts`, pero ese símbolo no está implementado allí.
  Corregir las referencias según exports y tests actuales, no crear una API para
  hacer verdadera la documentación antigua.

En `CONTRIBUTING.md`:

- La referencia final a `ROADMAP.md` debe revisarse: el roadmap está archivado.
- La lista que descarta un renderer 3D debe cotejarse con `docs/SCOPE.md` y la
  implementación Canvas/WebGL actual; no redefinir el alcance por una frase vieja.
- Contrastar la descripción del gate con `scripts/check.sh`, incluyendo formato,
  cobertura y presupuestos, y mantener una sola fuente de verdad ejecutable.

Cotejo realizado: atajos, prioridades y umbrales descritos en README ES/EN
frente a `src/ui/hudWiring/hotkeys.ts`, `src/renderer.ts`,
`src/priorityMatrix.ts`, su test y `src/ui/priorityPanel.ts`. No se editaron
snapshots históricos para hacerlos coincidir retroactivamente.

## 2. Knip: avisos, no permiso para borrar

Inventario repetido sobre la base: **23 exports**, **4 tipos**, **5 imports no
resueltos** y **1 binario**. No reportó archivos sin uso ni dependencias sobrantes
en esta ejecución (`knip --exclude duplicates --reporter json`).

- Los cinco imports no resueltos son `/src/...` de tests Playwright:
  `e2e/activity-presentation.spec.ts` y `e2e/approval-expiry.spec.ts`.
  Determinar si son resolución del analizador para imports servidos por Vite;
  no reescribirlos como imports Node sin comprobar su ejecución en navegador.
- Entre los exports figuran paneles `openLogPanel`, `openTaskPanel`,
  `openKanbanPanel`, funciones de refresh, helpers de capabilities y pruebas,
  `eraSystem`, `layers`, y estado de chat. Algunos pueden usarse de forma dinámica
  o desde tests: buscar referencias antes de desexportar, y antes de eliminar.
- `python3` aparece como binario no reconocido de `package.json`; no es prueba de
  una dependencia npm faltante. Documentar/configurar solo tras verificar el uso.
- Inspeccionar también `knip.json` por excepciones obsoletas. No silenciar categorías
  enteras ni declarar todo «falso positivo» sin evidencia.

Pruebas: typecheck, lint, unitarios completos y Playwright dirigido a los imports
implicados. Mantener contratos expuestos a scripts y browser imports.

## 3–4. Renderer isométrico local

`src/isoLocalRenderer.ts`: 1.691 líneas en la base inspeccionada.

Primer candidato: geometría (`isoUnproject`, `isoTileCorners`) con constantes y
dependencias explícitas. Probar entradas/salidas antes de mover y conservar las
exportaciones existentes. `isoGeometry.ts` es un nombre propuesto, no un módulo
ya creado ni una arquitectura aprobada.

Segundo candidato, separado: zonas, preview de pintado, energía, temperatura y
debug (`drawIsoZones`, `drawIsoZonePaintPreview`, `drawIsoPowerOverlay`,
`drawIsoTemperatureOverlay`, `drawIsoDebugOverlay`). Inspeccionar el estado que
consumen antes de diseñar `isoLocalOverlays.ts`; no arrastrar dependencias circulares.
No mezclar inicialmente tiles, paredes, puertas, NPCs y workbenches en el mismo corte.

Pruebas existentes: `src/isoLocalRenderer.test.ts`,
`src/isoLocalRenderer.activity.test.ts`; e2e `local-view.spec.ts`,
`local-view-memory.spec.ts` y `render-mode-parity.spec.ts`.

**Riesgo de cobertura:** el renderer original está excluido, pero los nuevos
archivos `src/**/*.ts` entran por defecto en medición. Acompañar las extracciones
con pruebas; no bajar floors ni extender exclusiones para esconder una caída.
Conservar orden de dibujo, z/transformaciones y comportamiento de overlays.

## 5. Backend: límites antes de extracciones mayores

Tamaños observados: `server/agent_runner.py` 1.472 líneas,
`server/bridge.py` 1.424 y `server/routes/core.py` 1.258.

- Runner: mapear por separado ciclo de subprocess, streaming/eventos, registro de
  sesiones y resolución de directorio/rutas. Elegir una responsabilidad por corte,
  con caracterización previa; no trasladar el monolito a otro archivo equivalente.
- Rutas: `core.py` concentra salud, agentes/sesiones, perfiles, roster, proveedores,
  comandos, pending y kanban. Evaluar agrupación por dominio conservando registro,
  RouteContext, status codes, auth, approvals y validaciones. Es un candidato por
  mezcla de responsabilidades, no una regresión detectada.
- Descubrimiento CLI restante: no unificar a ciegas `profile_identity.py`,
  `live_session_chat.py`, `opencode_sessions.py` y `kanban_writer.py`.
  PATH-only, override configurado sin validación previa y fallback del runner son
  contratos distintos. Cambiar qué binario se ejecuta no es limpieza inocua.
- Conservar fachadas/globales usados por monkeypatch. Los tests existentes de
  runner, Codex, perfiles, rutas y sesiones son parte del contrato.
- Algunas pruebas de kanban invocan el CLI Hermes real, aunque usan stores
  aislados. No describir toda la suite como hermética ni ejecutar agentes/modelos
  reales para validar una extracción pura.

## 6. Renderer principal y arranque

`src/renderer.ts` tiene 2.117 líneas; `src/main.ts`, 1.309.

Candidatos posteriores: separar `setupInput`/selección/gestos, estado y movimientos
de cámara, y coordinación de render. Ya existe `src/rendererScreen.ts`: reutilizar
ese límite en lugar de duplicar overlays. Antes de tocar `main.ts`, inventariar
inicialización y teardown de listeners, timers, subscriptions y render loops.
No mover estado global a módulos sin caracterizar orden de inicialización.

Validación: `src/renderer.test.ts`, unitarios relacionados, e2e de paridad de modo,
selección/cámara y vista local. Las capturas ayudan, pero un hash dependiente de GPU
no reemplaza assertions de comportamiento.

## 7. Criterios de cierre de mantenimiento

- Un propósito por commit; ninguna feature, dependencia o política nueva por inercia.
- Pruebas de caracterización antes de mover lógica; revisión adversarial del diff.
- Gate completo sin reducir umbrales: frontend lines 43 / branches 36 /
  functions 50 / statements 42; backend mínimo 50.
- Para cambios visuales/interacción, Playwright dirigido y luego comprobación de CI
  gate/e2e. Seguir `CONTRIBUTING.md` para fixtures aislados y specs live opt-in.
- Validar enlaces documentales y actualizar este mapa al cerrar cada corte.
- No versionar `.venv`, `node_modules`, estados locales, logs ni credenciales.
- `main` permanece intacto durante la limpieza. PR/merge y futuros pushes requieren
  autorización; publicar este mapa no autoriza automáticamente los próximos lotes.

## 8. Pendientes consolidados

- Completar publicación y verificar gate/E2E de CI del SHA final antes del merge.
- No reabrir geometría, overlays ni extracciones backend cerradas.
- Providers live, configuración del runner, identidad/perfiles nativos, roster,
  cámara y teardown/remount siguen pospuestos: requieren un encargo separado.
- No homogeneizar contratos distintos de descubrimiento CLI ni perseguir cero
  avisos Knip. Conservar exports consumidos dinámicamente por browser tests.
- No versionar estados personales, entornos capturados, logs crudos ni perfiles
  de ejecución; usar ubicaciones locales ignoradas y documentación pública breve.
