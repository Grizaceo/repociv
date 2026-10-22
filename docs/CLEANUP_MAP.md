# Mapa de limpieza y modularización

## Estado de cierre local

La ronda de limpieza está validada localmente con fixtures aislados. No quedan
extracciones obligatorias; publicación, CI y merge se verifican por separado.

- Suite Playwright fixture/offline anterior: 46 aprobados, 2 skips live originales,
  ningún fallo. No es validación live ni prueba de ejecución de modelos reales.
- Gate anterior: exit 0; 1.329 tests frontend y 2.143 backend aprobados,
  10 skips backend, cobertura backend 83,93 %. Knip es report-only; mypy opcional
  no estaba instalado. La publicación requiere un gate nuevo sobre el SHA final.
- Revisión independiente final anterior: aprobatoria, contrastada con evidencia.
  Los registros de diagnóstico y sus rutas permanecen fuera del repositorio.
- La configuración de lanzamiento cambia efectivamente: Chromium completo usa
  `swiftshader-webgl`; headless-shell reconocido mantiene su backend predeterminado
  con `unsafe-swiftshader`. La suite local ejercitó Chromium completo, no todas
  las variantes. No cambian timeouts, retries, skips, cobertura ni presupuestos.
- Los SIGKILL históricos siguen sin causa ni emisor demostrados. La suite verde
  acredita validación fixture/offline, no una reparación causal de esos incidentes.
- Saneamiento público: el HOME capturado de una fixture se sustituye por un HOME
  sintético; se conservan resultados, eventos y contratos. No cambia producción.

Los resultados por corte siguientes son históricos; no sustituyen CI del SHA
publicado. El diario operativo privado no forma parte de este mapa público.
Los SHA históricos citados identifican las revisiones originales anteriores al
saneamiento; no todos son accesibles en el historial público saneado.

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

> Orden histórico de exploración, no una obligación de ejecutar cada candidato.
> La decisión vigente está en [Pendientes consolidados](#8-pendientes-consolidados):
> pasar al cierre de rama, sin una nueva extracción obligatoria.

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

**Cortes 1–2 completados:** documentación en `31cf99e` y clasificación Knip abajo,
sin retirar exports por el solo informe. Geometría, zonas/preview, energía,
temperatura y debug se documentan en la sección 3–4 con su evidencia por corte.
No empezar simultáneamente frontend y backend; las filas siguen describiendo
las condiciones de cada trabajo.

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

## 2. Knip: clasificación completada, sin retirar código

Inventario repetido: **23 exports + 4 tipos + 5 imports no resueltos + 1 binario**.
Son **33 avisos**, no 33 piezas de código muerto. No reportó archivos sin uso ni
extras de dependencias bajo la configuración actual (`knip --exclude duplicates
--reporter json`), que contiene excepciones. Se cotejaron referencias en archivos
versionados, incluidos tests y scripts; ausencia de referencias estáticas **no**
prueba ausencia de contratos dinámicos ni autoriza borrado automático.

### Exports y tipos (27)

| Símbolos                                                                                                                                                                                   | Clasificación / evidencia y límite                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openLogPanel`, `refreshActivityHistory`                                                                                                                                                   | Conservar exports. `e2e/activity-presentation.spec.ts:81` y `activity-correlation.spec.ts:123` importan el módulo servido por Vite; también usados internamente en `logPanel.ts:140,301,303`.                                                                                      |
| `openTaskPanel`, `refreshTaskInventory`                                                                                                                                                    | Conservar exports. Imports en `activity-presentation.spec.ts:86,115,130`, `activity-correlation.spec.ts:122` y `pending-work.spec.ts:41`; registro interno de panel en `taskPanel.ts:419,421`.                                                                                     |
| `openKanbanPanel`                                                                                                                                                                          | Conservar export. Import en `e2e/kanban-create.spec.ts:54`; llamado internamente en `kanbanPanel.ts:79`.                                                                                                                                                                           |
| `notifyWorkingUnitsChanged`                                                                                                                                                                | Candidato a desexportar, **no borrar**: referencias internas en `chat/state.ts:132,135,167`.                                                                                                                                                                                       |
| Tipos `EraDefinition`, `CapabilitiesAgent`, `CapabilitiesSnapshot`                                                                                                                         | Candidatos a desexportar, no borrar sus definiciones: usos internos en `eraSystem.ts:14` y `capabilitiesClient.ts:18,69,89,92,116,128`.                                                                                                                                            |
| `unmountGacetaWidget`                                                                                                                                                                      | Sin caller localizado fuera de su definición (`gacetaWidget.ts:118`). Mantener el teardown hasta revisar ciclo de vida; la ausencia de llamadas no demuestra que eliminarlo sea prudente.                                                                                          |
| `getCurrentEraIndex`, `getEraLabel`, `updateEraDisplay`                                                                                                                                    | Candidatos a inspeccionar como cadena: los dos primeros tienen callers internos en `eraSystem.ts:62–64`; no se localizó caller externo del tercero. No borrar `getStoredEraLabel`, usado en main y capitalPanel.                                                                   |
| `setFullCapabilitiesForTesting`, `getCapabilitiesSnapshot`, `setCapabilitiesSnapshotForTesting`, `resetCapabilitiesSnapshotForTesting`, `isCapabilitiesSnapshotLoaded`, `initCapabilities` | Sin callers externos localizados en `capabilitiesClient.ts:53–113`. Revisar el subsistema snapshot por separado; **no borrar el módulo**: `setCapabilitiesForAgentsForTesting` se usa en `spatialDirectives.test.ts:10,30`. No confundirlo con la tabla de `agentCapabilities.ts`. |
| `_testTerrainSurface`                                                                                                                                                                      | Sin import localizado del objeto de `terrainSurfaceY.ts:121`; el test importa las funciones públicas. Candidato a desexportar/eliminar solo tras cotejar contratos del módulo.                                                                                                     |
| `setUnitWorking`, `syncWorkingUnitsFromGameState`, tipo `GameStateLike`                                                                                                                    | Sin caller externo localizado (`chat/state.ts:128,144,147`); el tipo sirve al segundo helper. Revisar juntos, sin retirar `workingUnits` ni `subscribeWorkingUnits`, usados por `agentChip.ts`.                                                                                    |
| `toggleLayer`, `setLayer`, `resetLayers`, `subscribe` de `layers.ts`                                                                                                                       | Sin callers localizados de estos exports (`layers.ts:72,96,104,110`). **No borrar el módulo**: `getLayerState` e `isLayerVisible` alimentan wonderVignette, renderer y ordenDeBatalla. No confundir este `subscribe` con GameState u otros homónimos.                              |

Resumen: **5 exports necesarios por browser/tests; 1 función y 3 tipos con uso
interno (candidatos a desexportar); 17 exports y 1 tipo requieren revisión de
contratos antes de una eventual retirada**. Ninguno se retiró en este corte.

### Resolución y herramientas (6)

- Imports `/src/ui/logPanel.ts` y `/src/ui/taskPanel.ts` en
  `activity-presentation.spec.ts:81,86`; `/src/ui/chat/state.ts`,
  `/src/ui/chat/history.ts` y `/src/ui/approvalCards.ts` en
  `approval-expiry.spec.ts:13,14,25`: URLs de módulos servidos por Vite dentro del
  navegador, no imports Node. Las dos specs se ejecutaron en Chromium: **5 tests
  aprobados** con fixtures y estado aislado. No reescribir por el aviso Knip.
- `python3` en los scripts `assets:office` y `assets:props` (`package.json:21–22`)
  es una herramienta del sistema, no una dependencia npm faltante. No silenciar
  la categoría completa de binarios ni cambiar su descubrimiento.

### Excepciones de `knip.json`

- `scripts/screenshot-3d-audit.mjs`: se invoca desde `.github/workflows/ci.yml:127`;
  la excepción evita tratar como huérfano un entrypoint de CI. Si se desea modelar
  como `entry`, hacerlo en otro corte y comprobar el inventario resultante.
- `@xterm/xterm` y `@xterm/addon-fit`: no se localizaron imports actuales;
  `terminalPanel.ts` es un stub y `vite.config.ts:164` conserva una regla de chunk
  xterm. Los ignores ocultan posibles dependencias sobrantes, no demuestran uso.
  Revisar deps, lockfile, stub y regla juntos; **no se modificaron** aquí.

Validación del corte: inventario contado por JSON, búsqueda sobre archivos
versionados y comprobación independiente de usos browser/CI. Gate completo y
48 unitarios dirigidos registrados arriba; Playwright dirigido no sustituye toda
la suite. Mypy no disponible. Sin cambios de código, config, cobertura, binarios,
políticas de descubrimiento ni excepciones Knip.

### Corte posterior: tres interfaces pasan a ser internas

- Base local: `d9eb8a1`. Se retira únicamente `export` de `EraDefinition`
  (`src/ui/eraSystem.ts`), `CapabilitiesAgent` y `CapabilitiesSnapshot`
  (`src/capabilitiesClient.ts`). Las definiciones y todas las funciones se
  conservan. No se conecta ni elimina el subsistema capabilities.
- Cotejo de referencias en código, e2e y scripts: los tres nombres solo se
  referencian en su módulo. Typecheck completo aprobado. La API de tipos se
  reduce en esos tres nombres; las firmas estructurales de las funciones se
  conservan. No hay cambios de comportamiento en ejecución.
- Verificación por archivo contra HEAD con TypeScript y opciones del proyecto:
  el fuente cambia solo esos tres modificadores; el JavaScript transpileado es
  idéntico byte a byte (comparación sin sourcemaps).
- Gate completo con afinidad CPUs 0–1: **1.160 frontend; 1.796 backend aprobados,
  2 omitidos; cobertura backend 83,45 %**. Types, lint, formato, build y presupuestos
  aprobados; mismos tamaños 5.318/719/154 KiB. Mypy no instalado. No se ejecutaron
  agentes/modelos; no se repitió Playwright en este corte sin cambios de JS.
- Knip repetido y comparado programáticamente: desaparecen **solo esos tres
  avisos de tipos**, sin avisos añadidos. Inventario actual: **23 exports,
  1 tipo, 5 imports no resueltos, 1 binario = 30 avisos**. Las tablas anteriores
  conservan el inventario de base (33), no el inventario actual.
- Revisión adversarial completada: sin imports type, reexports de barrel ni
  consumidores browser de los tres nombres. Comparación esbuild independiente
  también produjo JS idéntico. Se contrastó su cautela sobre `.d.ts` mediante
  TypeScript `declaration + emitDeclarationOnly`: ambos módulos emiten sin
  errores TS4023/TS4053 (salida capturada en memoria, sin escribir archivos).
  Las interfaces locales siguen siendo expresables en las declaraciones de
  funciones; solo dejan de ser importables directamente por su nombre.

## 3–4. Renderer isométrico local

`src/isoLocalRenderer.ts`: 1.691 líneas en la base inspeccionada.

### Corte de geometría pura (base `78cb6c2`)

- Se extraen a `src/isoGeometry.ts` las constantes `ISO_TILE_W`, `ISO_TILE_H`,
  `ISO_WALL_H` y las funciones `isoProject`, `isoUnproject`, `isoTileCorners`.
  El módulo hoja no importa dibujo, DOM, atlas ni otros módulos.
- Se conservan las fachadas de `isoOfficeSprites.ts` (constantes/proyección) y
  `isoLocalRenderer.ts` (proyección/inversa), incluida identidad de funciones.
  No se modifica ninguna rutina de dibujo, orden de render ni overlay.
- Caracterización previa al movimiento: 8 fixtures capturados desde el HEAD
  original mediante AST (coordenadas negativas, fraccionarias, elevadas y grandes),
  esquinas de origen y round-trips comprobados; las 19 pruebas existentes pasan.
  Se incorporan 36 pruebas permanentes en `src/isoGeometry.test.ts`.
- Comparación AST/transpilación: valores de las tres constantes y cuerpos/defaults
  completos de las tres funciones idénticos a la base. Esta equivalencia se refiere
  a las funciones trasladadas, no a los bundles completos, cuyos imports cambian.
- Validación: 55 tests dirigidos; gate completo aprobado con afinidad CPU 0–1:
  **1.196 frontend; 1.796 backend, 2 omitidos; cobertura backend 83,44 %**.
  Tipos, lint, formato, build y presupuestos pasan sin cambiar umbrales/exclusiones.
  Mypy ausente (opcional); Knip JSON idéntico a la base de 30 avisos.
- Chromium con fixtures aislados y `E2E_SIM_NO_HERMES=1`: **5 tests aprobados** de
  `local-view.spec.ts`, excluyendo solo rendimiento. Incluyen entrada/dibujo,
  workbenches/agentes, chat, salida y actividad WebSocket con raster/expiración.
  No se ejecutan aquí memoria, paridad de modos ni la suite e2e completa; no se
  afirma paridad visual pixel a pixel de toda la escena.
- Revisión adversarial independiente completada, sin defectos bloqueantes:
  declaraciones trasladadas equivalentes por AST, fachadas y bindings preservados,
  ningún ciclo nuevo, fixtures contrastados con la base y configuración de cobertura
  intacta. Se precisó el nombre del test de salida de la proyección inversa; el
  round-trip real permanece en un test separado.

### Corte de zonas y preview (base `47fd6db`)

- `src/isoLocalZones.ts` recibe solo contexto Canvas, tokens, estado de pintado,
  zonas y límites de vista mediante tipos estructurales estrechos. No importa el
  renderer; consume `isoGeometry.ts`. Se extraen únicamente `drawIsoZones` y
  `drawIsoZonePaintPreview`; energía, temperatura y debug permanecen intactos.
- `monoFont` pasa a la hoja compartida `src/isoRenderStyle.ts`, manteniendo la
  expresión `??`, incluido el caso de cadena vacía. Renderer y zonas lo reutilizan
  sin duplicar el fallback ni introducir callbacks/resolución anticipada.
- Caracterización **antes** del movimiento y gate base aprobado: 26 capturas de
  órdenes Canvas, incluyendo escrituras de propiedades y orden. El fixture
  `src/fixtures/isoLocalZones.canvas.json` conserva 871 operaciones de la base.
  Cubre las seis paletas, fallback desconocido, tokens de fuente, zonas ausentes/
  vacías, recorte inclusivo, drag inverso, tile único y objetos fuera de vista.
  Se preserva el comportamiento existente: bordes/etiquetas pueden dibujarse
  aunque todos los tiles queden fuera de vista; no se corrige en limpieza.
- Se añaden 29 tests (26 trazas + 3 de fuente); 84 tests dirigidos aprobados.
  Las pruebas también comprueban que no se mutan las entradas. La comparación
  de comandos no se presenta como igualdad pixel a pixel en todos los navegadores.
- AST/transpilación: las dos funciones Canvas y `monoFont` producen exactamente
  el mismo código de función que la base. **Todas** las demás declaraciones del
  renderer fuera de imports permanecen iguales, incluidas guardas y orden de dibujo.
  El JSON versionado es idéntico al capturado antes de mover, salvo formato.
- Gate completo con afinidad CPU 0–1 aprobado: **1.225 frontend; 1.796 backend,
  2 omitidos; cobertura backend 83,45 %**. Tipos, lint, formato, build y presupuestos
  pasan sin cambiar configuración/umbrales; mypy ausente (opcional). Knip JSON
  idéntico a la base: 30 avisos, ninguno nuevo.
- Chromium con fixtures aislados y `E2E_SIM_NO_HERMES=1`: **3 tests** de vista local
  (entrada/dibujo, montaje/desmontaje de chat y salida). No es una prueba de
  interacción de pintado de zonas en navegador ni suite e2e completa; la regresión
  específica de zonas se verifica por sus trazas Canvas unitarias.
- Revisión adversarial independiente completada sin defectos bloqueantes: cuerpos
  Canvas idénticos a la base, golden rederivado de HEAD y 26 casos contrastados,
  guardas/orden de llamadas intactos y ningún ciclo nuevo. El revisor comprobó
  además que 16 mutaciones deliberadas en copias de scratch eran detectadas por
  los fixtures; no modificó código del repositorio.

### Corte de overlay de energía (base `f155846`)

- Se extrae únicamente `drawIsoPowerOverlay` a `src/isoPowerOverlay.ts`.
  Estado privado limitado a `ctx`/`tokens`, mundo `Pick<LocalWorld, 'powerGrid'>`;
  dependencias runtime solo geometría y fuente compartida, sin retorno al renderer.
- Gate base aprobado y caracterización previa: **25 fixtures, 382 operaciones**
  Canvas/reloj/gradiente en `src/fixtures/isoPowerOverlay.canvas.json`. Se registran
  propiedades, creación e identidad de gradientes, color stops y cada lectura del
  reloj intercalada en la secuencia. No se inyecta ni se adelanta tiempo en producción:
  `performance.now()` sigue ejecutándose una vez por fuente visible.
- Casos: red ausente/vacía, conduits malformados/no finitos, parsing numérico
  preexistente (vacíos, espacios, partes extra, exponentes y fracciones), recorte
  inclusivo y viewport negativo, fuentes visibles/ocultas y varios tiempos,
  fuente personalizada/vacía, cargas negativas/cero/límites 100/160/200 y exceso,
  estadísticas con/sin generación, consumo y batería, y orden combinado de capas.
  No se normalizan ni corrigen estas conductas durante la extracción.
- Cuerpo Canvas byte-idéntico y función transpilada idéntica a HEAD de base.
  Todas las demás declaraciones no-import del renderer permanecen iguales:
  guardas, orden de overlays, temperatura y debug incluidos. El fixture versionado
  coincide con la captura original, salvo formato. Se añaden **25 tests** y pasan
  **109 dirigidos**, incluida comprobación de no mutación y lecturas exactas del reloj.
- Gate completo CPU 0–1 aprobado: **1.250 frontend; 1.796 backend, 2 omitidos;
  cobertura backend 83,45 %**. Tipos/lint/formato/build/presupuestos pasan, sin
  modificar configuración/umbrales. Mypy ausente (opcional); Knip JSON idéntico:
  30 avisos, ninguno nuevo.
- Chromium con fixtures aislados y `E2E_SIM_NO_HERMES=1`: **3 smoke tests**
  de vista local (entrada/dibujo,
  chat y salida), no interacción específica del overlay eléctrico ni suite e2e
  completa. La animación específica se caracteriza por sus comandos y reloj;
  no se afirma igualdad pixel a pixel de todos los frames.
- Revisión adversarial independiente completada sin defectos: cuerpo de dibujo
  idéntico, golden rederivado de HEAD coincidente, tipos estrechos y dependencias
  sin ciclos. El revisor también contrastó versiones original/extraída con entradas
  aleatorias en scratch sin divergencias; esto complementa, no sustituye, los
  fixtures deterministas y el gate del padre.

### Corte de overlay de temperatura (base `e90c291`)

- Se extrae solo `drawIsoTemperatureOverlay` a `src/isoTemperatureOverlay.ts`.
  Estado privado: `ctx`, `tokens` y callback `spawnBreath`; mundo limitado a
  geometría de salas y mapa de climas. Dependencias runtime solo geometría y
  fuente compartida; no importa el renderer ni modifica debug, backend o arranque.
- Preflight real: rama y HEAD comprobados, copia principal limpia y `main` en
  `9d8f358`; remoto de limpieza sigue en `aaa11cc`, con ambos jobs `gate`/`e2e`
  aprobados en la CI enlazada arriba. Los nuevos commits siguen **sin publicar**.
  Gate base repetido con afinidad CPU 0–1: 1.250 frontend; 1.796 backend,
  2 omitidos; cobertura backend 83,45 %.
- Caracterización capturada desde el original **antes de mover código**:
  **40 fixtures / 801 operaciones**, incluidas escrituras Canvas, **19 lecturas
  de reloj y 15 de aleatoriedad**, y callbacks de partículas intercalados.
  Golden en `src/fixtures/isoTemperatureOverlay.canvas.json`, sin regenerarlo
  desde la implementación extraída. El overlay no crea gradientes.
- Casos: climas ausentes/vacíos, salas desconocidas/duplicadas, orden del Map,
  recorte inclusivo por centros y por dispositivos en los cuatro lados, vista
  negativa/fraccionaria, dimensiones nulas, colores fríos/confort/calor y extremos,
  umbral estricto de objetivo 0,5 °C, fuente personalizada/vacía, temperatura 10 °C,
  probabilidad estricta de aliento 0,02 y coordenadas aleatorias, relojes
  independientes de calefactores/refrigeradores/ventilaciones y módulo de animación.
  Se conserva el quirk: dispositivos visibles de salas con centro fuera del
  viewport se dibujan aunque no haya etiqueta ni aleatoriedad de esa sala.
- Cuerpo Canvas byte-idéntico y función transpilada idéntica al original.
  Todas las declaraciones restantes del renderer se comparan tanto por fuente
  AST como por transpilación, incluidos tipos, guardas y orden de dibujo; solo se
  añade el import del overlay. Golden idéntico a la captura previa salvo formato.
  **40 tests nuevos / 149 dirigidos aprobados**; se comprueba no mutación de entradas.
- Gate completo CPU 0–1 aprobado: **1.290 frontend; 1.796 backend, 2 omitidos;
  cobertura backend 83,45 %**. Tipos/lint/formato/build/presupuestos aprobados;
  sin cambiar configuración, umbrales, exclusiones ni descubrimiento de binarios.
  Mypy ausente (opcional). Knip JSON idéntico a la base: **30 avisos**, ninguno nuevo.
- Chromium con fixtures aislados, scratch nuevo, un worker y
  `E2E_SIM_NO_HERMES=1`: **3 smoke tests** de entrada/dibujo, chat y salida.
  No se ejecutan agentes/modelos. Puertos 5373–5375 sin listeners al terminar.
  No es interacción específica de temperatura, rendimiento, memoria, paridad de
  modos ni suite e2e completa; no se afirma igualdad pixel a pixel de todos los frames.
- Revisión adversarial independiente completada sin bloqueantes: original del
  commit fijo contrastado contra los 40 fixtures, cuerpo/resto del renderer
  equivalentes y dependencias sin ciclos. El harness adicional de scratch
  (artefacto local no publicado) detecta **25/25 mutaciones deliberadas**.
  Límites de caracterización: no cubre NaN/infinitos ni reloj negativo; no se
  cambian ni normalizan esas conductas preexistentes en esta extracción.

### Corte de debug (base `51ba9d7`)

- `drawIsoDebugOverlay` pasa a `src/isoDebugOverlay.ts`. Estado limitado a
  ctx/tokens/FPS; mundo limitado a salas con colecciones opacas de workbenches;
  unidades limitadas a los campos leídos. Consume geometría y fuente compartidas,
  sin importar el renderer ni introducir ciclos. No cambia la guarda debug ni su
  posición al final del dibujo local.
- Caracterización capturada **antes** de extraer desde el commit fijo original:
  **39 fixtures / 1.429 operaciones Canvas**, incluidas todas las escrituras de
  propiedades. Cubre mundo vacío, suma de workbenches, rutas vacías/cortas,
  índices agotados, negativos y fraccionarios (sin normalizarlos), coordenadas
  fraccionarias/lejanas, waypoints repetidos, múltiples unidades y dibujo en dos
  pasadas, textos opcionales/vacíos/largos/Unicode, redondeo, estados, fuente
  ausente/custom/vacía y FPS literal. No hay reloj, aleatoriedad ni gradientes;
  los tests fallan ante lecturas nuevas de reloj/random o APIs Canvas no previstas.
- Fixture histórico: `src/fixtures/isoDebugOverlay.canvas.json`, original fijo
  `51ba9d7d540c4e3c96d4269562b7215772066442`. No regenerarlo del módulo extraído.
  El modelo de asignación/save/restore parte de estilos y transformación no
  triviales; comprueba estado residual y no mutación de entradas. No simula la
  validación de estilos del navegador. Se conserva el leak preexistente de
  estilos de rutas/tarjetas: solo el contador de pantalla hace save/restore.
  `Ticks` sigue contando workbenches; no se corrige la etiqueta.
- Cuerpo byte-idéntico y función transpilada idéntica. Comparación de todas las
  declaraciones restantes del renderer: **39 fuente / 36 JS** intactas, incluida
  la guarda, orden de dibujo y transformaciones. **39 tests nuevos / 188 dirigidos**.
- Gate completo local con CPUs permitidas 0–1: **1.329 frontend; 1.796 backend
  aprobados y 2 omitidos; cobertura backend 83,45 %**. Tipos, lint, formato, build
  y presupuestos aprobados; mypy ausente opcional. Knip JSON idéntico a la base:
  30 avisos clasificados, ninguno nuevo. No cambian configuración ni umbrales.
- Chromium: **3 smoke tests** de entrada, render y salida de vista local, con
  workspace sintético, scratch nuevo, `E2E_SIM_NO_HERMES=1`, dos CPUs y un worker.
  Sin ejecutar agentes/modelos; puertos liberados al terminar. No es la suite
  completa ni una prueba de activación del debug por teclado.
- Comprobación adicional en Canvas real de Chromium **152.0.7977.82**: compara
  original fijo contra módulo extraído en **39 fixtures**, con trazas, propiedades
  finales reales, transformación y raster idénticos. Sirve solo el módulo en un
  documento vacío, sin arrancar la aplicación ni agentes. Incluye la validación
  real de fuentes vacías del navegador, que el modelo unitario no simula.
  Es paridad de los fixtures en ese navegador, no paridad visual de toda la app
  ni garantía entre motores/GPU. NaN e infinitos no están caracterizados.
- Revisión adversarial independiente sin bloqueantes: golden contrastado contra
  el original fijo, sin ciclos y sin cambios de comportamiento detectados.
  Los harnesses scratch (artefacto local no publicado)
  comprueban además **4.000 casos generados** equivalentes y **12/12 mutaciones**
  deliberadas detectadas por el golden. El padre reejecutó y verificó esos
  resultados antes del commit. No amplían la garantía a entradas no finitas.

Debug queda separado; tiles, paredes, puertas, NPCs, workbenches, backend y
renderer principal no forman parte de este corte. Siguiente candidato: inspección
acotada de una responsabilidad del runner (sección 5), antes de decidir qué mover.
La cola no autoriza empezar otro corte automáticamente.

Pruebas existentes: `src/isoLocalRenderer.test.ts`,
`src/isoLocalRenderer.activity.test.ts`; e2e `local-view.spec.ts`,
`local-view-memory.spec.ts` y `render-mode-parity.spec.ts`.

**Riesgo de cobertura:** el renderer original está excluido, pero los nuevos
archivos `src/**/*.ts` entran por defecto en medición. Acompañar las extracciones
con pruebas; no bajar floors ni extender exclusiones para esconder una caída.
Conservar orden de dibujo, z/transformaciones y comportamiento de overlays.

## 5. Backend: límites antes de extracciones mayores

Tamaños antes del corte de rutas (base `869e143`):
`server/agent_runner.py` 1.472 líneas, `server/bridge.py` 1.424 y
`server/routes/core.py` 1.258.

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

### Corte de rutas del runner (base `869e143`)

Límite: raíz de repos, directorio de trabajo seleccionado, contención de archivos
y texto de contexto espacial, ahora en
[`server/agent_paths.py`](../server/agent_paths.py). El módulo solo importa
stdlib y recibe callbacks tipados; no importa al runner, stores ni adaptadores.
No mueve sesiones, streaming/eventos, subprocesos, rutas HTTP ni búsqueda de CLI.

- `agent_runner` conserva las cinco fachadas, firmas, defaults y nombres globales;
  `_resolve_city_path` y todos los consumidores permanecen intactos. Los callbacks
  diferidos conservan el monkeypatch de `_rrs` (incluso sustituyendo el objeto),
  `_repos_root` y `_path_is_within`, no solo el valor que tenían al entrar.
  La ruta especial de `capital` usa el `__file__` del runner, no el del módulo nuevo.
- Caracterización **antes** de modificar producción, ejecutando el original fijo
  `869e14388f432e6eb771abbef1e418e8a9dba7f1`: **59 casos** con resultados,
  excepciones y orden de callbacks, retenidos en
  [`server/fixtures/agent_paths.json`](../server/fixtures/agent_paths.json).
  Incluye prioridad state/env/default, tilde/whitespace, main/capital y repos
  explícitos, rutas relativas/absolutas/inexistentes, traversal, prefijo hermano,
  symlinks de entrada/salida/bucle, NUL y contexto espacial literal/Unicode.
  Los paths temporales se normalizan a `$FIXTURE`. El caso original `root-tilde`
  usa un HOME sintético en la copia pública; solo el prefijo de HOME
  se normaliza al leerlo, conservando el resultado y los eventos esperados. El harness aísla `Path.home()` y `HOME`; comprobado con
  `HOME=/nonexistent`. No se regenera el golden desde la implementación movida.
- Se mantienen quirks: `main`/`capital` no recortan whitespace, el root de estado
  no pasa por `expanduser`, `commonpath` por sí solo es léxico y `realpath` no
  exige existencia. No se añade strip, strict, validación de selección ni política
  nueva. La selección real sigue a cargo del store existente.
- Comparación AST de los **5 cuerpos**, normalizando únicamente las referencias
  de dependencias introducidas por los callbacks; las **5 firmas de fachada** y
  los **84 statements top-level restantes** del runner son idénticos al original.
  No es identidad byte a byte: las firmas del leaf reciben dependencias explícitas.
- [`server/test_agent_paths.py`](../server/test_agent_paths.py): **71 tests**
  (59 golden + 2 casos `ValueError` de `commonpath` + 1 cambio tardío del guard
  durante `realpath` + 6 integraciones de `run_agent` con selección persistida real
  y ejecución/stores fake + 2 ramas main/capital con mayúsculas + 1 `__file__`
  relativo). Los 71 también pasan contra los cuerpos originales en un proceso
  aislado con HOME alternativo; golden 59/59 con normalización de home al leer.
  Dirigidos junto a runner/command-security, en ambos órdenes: **115 aprobados y
  1 omitido preexistente**. No se ejecutan agentes/modelos en estas pruebas.
- Gate completo posterior, CPUs **0–1**: **1.329 frontend**, **1.867 backend**
  aprobados y **2 omitidos**; cobertura backend **83,61 %**. Tipos, lint,
  formato, build y presupuestos sin cambios y aprobados (5318/719/154 KiB).
  Mypy ausente, opcional; warning preexistente de HMAC efímero sin clave.
  Knip JSON idéntico al baseline, **30 avisos** ya clasificados.
- Revisión independiente sin bloqueantes de comportamiento: **641 escenarios**
  original/extraído sin discrepancias en resultados/excepciones ni callbacks;
  **14/14 mutaciones** detectadas, con control intacto sin discrepancias.
  Ambos harnesses reejecutados por el padre. La revisión detectó portabilidad de
  `root-tilde` y huecos `commonpath`, mayúsculas y filename relativo; atendidos
  con aislamiento/normalización de test y casos nuevos, sin cambios de producción
  ni de resultados del golden; su prefijo de HOME se anonimiza en la copia pública. La revisión final confirmó HOME y
  TMPDIR alternativos y normalización discriminante (`drop-expanduser` falla).
  El golden solo detecta **11/14** mutaciones; con los tests adicionales, la
  suite de 71 detecta **14/14**, control sin discrepancias. Padre reprodujo ambas
  mediciones tras corregir un comparador scratch que leía el golden sin normalizar;
  no se atribuye al golden la cobertura aportada por los casos nuevos.
- Chromium con scratch nuevo, **un worker**, CPUs 0–1 y `E2E_SIM_NO_HERMES=1`:
  **3 smoke tests** (`repociv.spec.ts`: carga inicial, paneles, error de repos).
  Sin agentes/modelos; puertos 5373–5375 liberados. No es la suite completa ni
  una ejecución de misión real desde el navegador; ese límite se comprueba con
  la selección real y el adaptador fake de las integraciones Python.

### Corte de persistencia de sesiones Hermes (base `06618a7`)

Límite: lectura/escritura JSON de ids de sesión nativos, ahora en
[`server/hermes_session_store.py`](../server/hermes_session_store.py). El leaf
solo importa stdlib y recibe callbacks sin argumentos. El runner conserva la
política de ruta/clave, las dos fachadas y todos sus consumidores. No se mueve
streaming, ejecución de procesos ni registro de sesiones en otros stores.

- Caracterización previa contra el código original; tras extraer, el corpus
  ejecuta las mismas expectativas sobre helper y fachadas. Cubre JSON válido,
  inválido y no-mapping, claves ausentes/duplicadas, coerción con `str`, errores
  de IO/callbacks y su orden, corto-circuito de ids falsey, bytes JSON Unicode y
  datos no serializables. No añade reparación, validación, locking ni atomicidad.
- Los callbacks mantienen lookup tardío: un cambio de `_hermes_session_key`
  durante la lectura afecta la búsqueda/escritura posterior como antes. La ruta
  se resuelve dentro del mismo bloque `try`; fallos conservan `""` o silencio.
- Comparación AST: los **2 cuerpos** son equivalentes normalizando solo las
  llamadas de dependencia; las **2 firmas de fachada** y los **88 statements
  top-level restantes** no cambian, salvo el import del leaf. La fachada de
  guardado no propaga un retorno accidental del helper: sigue retornando `None`.
- [`server/test_hermes_session_store.py`](../server/test_hermes_session_store.py):
  **102 casos**, incluidos roundtrip con archivo temporal y separación de claves
  por perfil/unidad/ciudad, integración de dos llamadas al CLI fake con resume
  stateful y ausencia de caché/resume stateless. El fake sustituye solo el alias
  `agent_runner.subprocess`, no el módulo global. No ejecuta binarios ni modelos.
  **53 casos** de fachada/integración también pasan contra los cuerpos originales
  AST del SHA fijo `06618a725bfbaee735ffe78df6f990c1f564fe73` en proceso aislado;
  los otros 49 casos prueban directamente el helper nuevo.
- Dirigidos junto a runner/Codex: **138 aprobados y 1 omitido**. Backend completo:
  **1.969 aprobados y 2 omitidos**, cobertura **83,90 %**; leaf **100 %**.
  Frontend completo con cobertura: **1.329 aprobados**, sin cambiar umbrales.
- Gate baseline y primer gate tras extracción aprobaron con afinidad a dos CPUs
  (backend 1.867 y 1.968, respectivamente). Tras ajustes de revisión, la repetición
  aprobó todos los controles excepto Vitest, cuyo proceso terminó `Killed`, sin
  fallo de aserción. Repetición de toda la cobertura frontend con la misma afinidad
  y `--maxWorkers=2`: exit 0. No se atribuye una causa al kill ni se presenta esa
  última invocación de `scripts/check.sh` como exit 0. Mypy sigue ausente/opcional.
- Revisión adversarial independiente sin bloqueantes; atendidos el retorno `None`,
  aislamiento del fake de subprocess y documentación del orden de IO.
- Knip conserva las categorías conocidas: 23 exports, 1 tipo, 5 imports no
  resueltos y 1 binario. No se retira código frontend en este corte.

### Corte de coordinación de reanudación Claude (base `bcf54f3`)

Límite pequeño: elección de argumentos de sesión, comprobación de transcripción
al reanudar y olvido/reemplazo único de un hilo sin transcripción, ahora en
[`server/claude_session_args.py`](../server/claude_session_args.py). El leaf solo
importa stdlib y recibe tres callbacks; no importa stores, runner ni ejecución.
Se eligió este límite frente al ciclo de subprocess/streaming, que entrelaza
registro de procesos, salida, eventos y callbacks. No se mueve ese ciclo ni se
cambia la política de sesiones existente.

- Fachada `_claude_session_args`, firma, import local de `transcript_path` y
  normalización de ciudad conservados. Las lambdas consultan el global
  `_claude_sessions` al invocarse, incluso si un callback sustituye el objeto.
  No se capturan anticipadamente los métodos del store.
- Caracterización original previa de resultados, excepciones y efectos ordenados;
  [`server/test_claude_session_args.py`](../server/test_claude_session_args.py)
  contiene **27 casos** tras revisión. Todos pasan también ejecutando la función
  original AST del SHA fijo `bcf54f3237757825d9e0de72cc8875574e7f51f4` en un
  proceso limpio. Incluye dos integraciones de streaming con procesos falsos y
  store real aislado, stateful/stateless, argumentos y callbacks ordenados.
  Ningún agente/modelo real valida la extracción.
- Preserva quirks: solo `None` significa transcripción ausente; no convierte ids,
  no revalida el reemplazo ni añade fallback/captura de errores. Las excepciones
  se propagan sin efectos posteriores; `resume` conserva evaluación por veracidad.
- AST: cuerpo trasladado equivalente normalizando solo dependencias; firma,
  preludio y **89 statements top-level restantes** del runner intactos salvo el
  nuevo import. Dirigidos: **68 aprobados y 1 omitido preexistente**.
- Gate completo final, CPUs **0–1**, `NODE_OPTIONS=--max-old-space-size=1024`:
  **exit 0**, **1.329 frontend**, **1.996 backend y 2 omitidos**, cobertura backend
  **83,98 %**, leaf **100 %**. Tipos/lint/formato/build y presupuestos aprobados,
  sin cambios de configuración, floors ni presupuestos. Mypy ausente/opcional.
  El gate previo aprobó controles obligatorios pero Knip terminó `Killed`;
  no se atribuye causa. La repetición final sí completó Knip: diagnóstico
  no bloqueante con **30 avisos** (23 exports, 1 tipo, 5 imports no resueltos,
  1 binario), confirmados por JSON separado. No se ejecutó Playwright en este corte.
- Revisión adversarial (registro privado) sin bloqueantes. Su hueco de veracidad del
  primer `resume` se cerró con dos casos, también verdes contra el original.
  Padre reejecutó sonda: **7/7 mutantes detectados**, control sin fallos. Los
  tests ejercitan el leaf por su fachada; el diferencial original queda en scratch,
  no se añade una dependencia Git al gate versionado.

### Corte de consumo NDJSON OpenCode (base `f593290`)

Límite: solo clasificación de líneas, acumulación de texto/errores/stray y emisión
ordenada de chunks de `_run_opencode_streaming`, ahora en
[`server/opencode_stream.py`](../server/opencode_stream.py). El leaf importa solo
stdlib, recibe iterable y callbacks, y devuelve los cuatro acumuladores originales.
El runner conserva firma y preludio, creación/registro del proceso, assert de stdout,
`wait(timeout=600)`, returncode, precedencia de errores y fallbacks finales. No se
unifican otros protocolos ni se cambia ejecución, política de sesiones o rutas HTTP.

- Caracterización previa contra runner original, ampliada tras revisión:
  [`server/test_opencode_stream.py`](../server/test_opencode_stream.py), **35 casos**
  con procesos/callbacks falsos y HOME/config aislados. Todos pasan también contra
  el cuerpo original AST del SHA fijo `f5932901a0a55c891bca6f6cd5d25720099aa82e`
  en proceso fresco. Ningún agente/modelo real valida la extracción.
- Preserva líneas vacías, JSON no-mapping, chunks Unicode/whitespace, newline de
  envío sin alterar texto acumulado, tools sin nombre que cuentan, primeros veinte
  stray recortados, primer error y precedencia frente a returncode. Prueba ocho
  límites de excepción, `ValueError` de decoder frente a otros errores, stdout
  ausente y lookup tardío de los globals `json`, `send_to_repociv` y `_es`.
  Los callbacks envían antes de registrar y pueden reemplazar dependencias entre
  eventos o entre el envío y registro del mismo chunk.
- AST: bloque movido equivalente normalizando únicamente tres accesos de
  dependencia; firma, preludio, ciclo/finalización y resto del runner intactos
  salvo import. Dirigidos con runner/Codex/Claude: **98 aprobados, 1 omitido**.
- Revisión read-only completada (registro privado): sin bloqueantes. La primera
  revisión quedó interrumpida sin conclusión; sus artefactos no se tomaron como
  aprobación. Hueco de whitespace stray cerrado: el caso con espacios está en
  las tres últimas líneas retenidas, no descartado por `stray[-3:]`.
- Padre corrigió la sonda scratch de mutación: alcance por función, número de
  reemplazos explícito y exit pytest **1** obligatorio. **14/14 mutantes no
  equivalentes detectados**, control verde; una transformación `elif`→`if`
  equivalente sobre kinds mutuamente excluyentes sobrevive y no cuenta como fallo
  de cobertura. Fallos al instalar un mutante no se cuentan como detecciones.
- Primera invocación postextracción interrumpida por timeout de herramienta
  durante Vitest (420 s), sin aserción fallida ni proceso restante; no se atribuye
  causa. Repetición completa verde antes del último caso de whitespace:
  **2.030 backend + 2 omitidos, 84,25 %**, leaf **100 %** y **1.329 frontend**.
  Gate completo de cierre tras el caso adicional: **exit 0**, **2.031 backend +
  2 omitidos**, **84,25 %**, leaf **100 %** y **1.329 frontend**. Ambos gates usan
  `NODE_OPTIONS=--max-old-space-size=1024 taskset -c 0,1 bash scripts/check.sh`.
  Tipos/lint/formato/build y los tres presupuestos pasan. Knip completa sus
  diagnósticos: **30 avisos** (23 exports, 1 tipo, 5 imports, 1 binario), además
  de un hint de configuración, sin retirar código frontend. Baseline íntegro
  previo a extracción también terminó con exit 0.
  Revisión previa observó un fallo en el test del CLI kanban; ejecución aislada
  posterior por el padre pasa y también pasó en el gate completo. No se infiere
  causa ni se corrige comportamiento ajeno a este corte.
- Mypy ausente/opcional; Knip diagnóstico no bloqueante. No se ejecuta Playwright
  ni misión real de OpenCode; los tests generales de kanban pueden invocar el CLI
  Hermes real con stores aislados, no modelos. Sin cambios de configuración,
  umbrales, snapshots ni presupuestos.

### Corte de construcción del cuerpo HTTP Hermes (base `63de7d2`)

Límite: solo construcción del payload (mensajes, modo quick-chat y campos
opcionales), ahora en
[`server/hermes_request_payload.py`](../server/hermes_request_payload.py).
El runner conserva selección de modelo/proveedor, configuración y sesión,
URL/credenciales, serialización, HTTP, ledger, envío de respuesta y fallback.
No se modifica el endpoint ni se activa streaming: `stream: False` ya existía.

- Caracterización **antes** de mover el bloque, con HTTP/callbacks/ledger falsos
  y HOME/config aislados. Los **37 casos** de
  [`server/test_hermes_request_payload.py`](../server/test_hermes_request_payload.py)
  pasan contra extraído y contra cuerpo original AST del SHA fijo
  `63de7d2c3dc44fbedc13011e0c5181d58801ce38` en proceso fresco.
- Preserva orden quick-chat→espacial→lectura de system, configuración compartida
  sin copia, strings vacíos/defaults y TypeError de system inválido. La petición
  mantiene modelo/proveedor previamente resueltos, texto literal de chat rápido,
  presupuestos 1024/4096, reasoning low y working_directory incluso para chat
  rápido (sin añadir `cd` a ese mensaje). No se corrigen esas particularidades.
- Las dos lambdas conservan lookup tardío de `_is_quick_chat_message` y
  `_spatial_context_block`: el primer callback puede sustituir el segundo.
  Preparación continúa **fuera** del try de transporte; sus fallos se propagan
  sin enviar un error HTTP sintético. Serialización/HTTP siguen en su try original.
- AST: cuerpo movido equivalente normalizando solo dos nombres de callback;
  firma y todo el resto del runner intactos salvo import y delegación. Dirigidos
  con runner/Codex/store: **175 aprobados y 1 omitido preexistente**. Módulo nuevo
  **100 %** de cobertura por fachada; sin petición HTTP ni agente/modelo real.
- Baseline completo y gate posterior **exit 0**, CPUs **0–1** y heap Node 1024 MB,
  sin editar configuración ni umbrales. Gate posterior: **2.068 backend y 2
  omitidos**, cobertura **84,33 %**, **1.329 frontend**; tipos, lint, formato,
  build y tres presupuestos aprobados. Mypy sigue ausente/opcional; Knip completa
  sus **30 avisos** conocidos (23 exports, 1 tipo, 5 imports, 1 binario) y 1 hint.
- Padre ejecutó sonda in-memory con control verde y **10/10 mutantes detectados**,
  todos por exit pytest 1: presupuestos, stream, guarda de cd, provider/workdir,
  reasoning, system/spatial, copia temprana de config y spatial prebound.
  No se confunde fallo de instalación con detección.
- Revisión adversarial independiente (registro privado): **sin bloqueantes**;
  inspección del límite/orden/try, 37 casos extraídos y originales y AST verdes.
  El revisor no ejecutó suite completa; el gate completo anterior lo ejecutó
  el padre. Sin reclamo de identidad byte a byte ni validación remota.
- No Playwright ni integración real con gateway Hermes. Los tests generales de
  kanban pueden invocar CLI Hermes real con stores aislados, no modelos. Sondas
  de diferencial/mutación permanecen fuera del gate versionado, en scratch:
  (artefacto local no publicado).

### Corte de rutas de salud y disponibilidad (base `31e4540`)

Límite: cuerpos de `get_health` y `get_ready` a
[`server/routes/health.py`](../server/routes/health.py). `core.py` conserva ambas
fachadas, firmas, `RouteContext`, `_build_identity` y `time`; `http_routes.py`,
`routes/registry.py` y `bridge.py` permanecen byte-idénticos. No se mueve registro,
autenticación, approvals, políticas ni otros dominios HTTP.

- **32 casos** de
  [`server/test_health_routes.py`](../server/test_health_routes.py) ejecutados
  contra el original antes de extraer; pasan contra original AST de SHA fijo
  `31e45406f7187f1261fcfc1ed14fe37a162c696f` y extraído, en proceso fresco.
  Módulos colaboradores falsos aislados en `sys.modules` y atributos de `server`,
  restaurados por monkeypatch; HOME/config temporales. Sin GPU, binarios, servicios
  ni scheduler reales en esos nuevos casos. Contexto sigue ignorado.
- Conserva orden scheduler→cola→GPU→selección de identidad→timestamp→capabilities
  →MCP→agregados/store→Suvadu→snapshot. Imports siguen locales: capacidades,
  scheduler, store y función MCP se capturan al entrar; atributo `Suvadu.status`
  se resuelve más tarde. Excepciones se propagan sin envolturas nuevas.
- Dos lambdas leen `_build_identity` y `time.time` de core al invocarse. La
  identidad se selecciona tras GPU y antes de capabilities; fallback solo para
  `None`, no para objetos falsey. El snapshot usa la identidad ya seleccionada.
  No se convierte todo el dominio a dependencias uniformemente eager o late.
- Se preservan forma/orden de claves y referencias retornadas, conteo exacto de
  status `active`, `str(_store_path)` incluso para valores falsey y doble lectura
  del descriptor por `hasattr` en health. Ready sigue sin guarda si falta store y
  expone solo `bool(REPOCIV_TOKEN)`. No se corrigen estas particularidades.
- AST de ambos cuerpos equivalente por sustituciones explícitas de source/clock;
  resto de core intacto salvo import y cuerpos de fachada. La prueba de registro
  comprueba identidad de callable core→shim→tabla exacta para `/health` y `/ready`.
  El diferencial original restaura `__code__` de fachada en proceso fresco, no
  rebind del objeto que rompería artificialmente esa prueba.
- **45 dirigidos** con diagnósticos existentes aprobados; módulo nuevo **100 %**.
  Sonda in-memory del padre: control verde y **9/9 mutantes no equivalentes**
  detectados con pytest exit 1, incluyendo source/clock prebound, fallback falsey,
  guarda/coerción de store, transporte, capabilities, conteo y token sin bool.
- Baseline completo y gate posterior **exit 0**, CPUs **0–1**, heap Node 1024 MB,
  sin cambios de configuración ni umbrales. Gate posterior: **2.100 backend y 2
  omitidos**, cobertura **84,38 %**, **1.329 frontend**, tipos/lint/formato/build y
  tres presupuestos verdes. Knip completa sus **30 avisos** conocidos + 1 hint;
  Mypy ausente/opcional. Los tests generales de kanban pueden invocar CLI Hermes
  real con stores aislados, no modelos; no se declara toda la suite hermética.
- Revisión adversarial (registro privado): **aprobado, sin bloqueantes**; AST,
  32 originales y 45 dirigidos extraídos verificados. Import limpio de core no
  carga bridge; mantener health sin imports server a nivel módulo. El revisor
  no ejecutó gate completo; lo ejecutó el padre. No es prueba HTTP end-to-end.
- No Playwright, peticiones HTTP reales ni nueva prueba end-to-end de auth; su
  implementación/registro no cambian. Evidencia scratch efímera fuera del gate:
  (artefacto local no publicado). El mapa
  conserva evidencia resumida aunque caduque scratch.

Las otras responsabilidades backend siguen pendientes. Elegir una sola en otro
corte, solo con nuevo encargo; los cortes cerrados no autorizan más cambios de
streaming, ciclo de procesos, políticas de sesión ni rutas HTTP.

### Corte del registro de perfiles RepoCiv (base `eff8df6`)

Límite: `get_profiles`, `post_profiles`, `post_profiles_delete` se copian **sin
transformar sus cuerpos** a
[`server/routes/profile_registry.py`](../server/routes/profile_registry.py).
Core conserva fachadas, firmas/defaults, docstrings públicos y contexto ignorado.
No se mueven roster, identidad, lectura/escritura de archivos de perfiles nativos,
default harness ni políticas; `config_store.py`, `profile_identity.py`, bridge,
shim y registro HTTP permanecen byte-idénticos.

- **51 casos nuevos** de
  [`server/test_profile_registry_routes.py`](../server/test_profile_registry_routes.py)
  pasan antes de extraer, contra el original fresco de SHA fijo
  `eff8df6fe5f9a578fef17e88ceaf7ea76ff8f0ac` y contra el extraído. Store falso en
  `sys.modules` y atributo padre de `server`; HOME/config temporales y monkeypatch
  restaurable. Ningún perfil real, proceso de agente ni modelo en estos casos.
- Se conservan nombres/harness sin strip ni validación nueva, nueve keywords
  opcionales con su orden/referencias y valores por defecto None, errores 400/404,
  formato repr del nombre y resultado de listado/entry sin coerción/copia.
- Imports locales de store antes de leer body; callee upsert seleccionado antes
  de evaluar keywords opcionales. Lecturas name/harness fuera del try; lecturas
  opcionales dentro. Solo ValueError capturado en ese alcance; truthiness de
  delete fuera del try. Bodies no mapping siguen levantando AttributeError.
- AST de las tres funciones completas idéntico al original; resto de core intacto
  salvo import y delegaciones. Identidad de fachadas core→shim→tablas GET/POST y
  docstrings comprobados. Diferencial restaura __code__ para no romper registro.
- **60 dirigidos**: 51 falsos más 9 HTTP existentes de
  `test_profiles_endpoints.py` (localhost y config temporal, no modelos).
  Cobertura del nuevo módulo **100 %**, 29 sentencias. Control mutacional verde y
  **10/10 no equivalentes** detectados, pytest exit exactamente 1, sin editar disco.
- Baseline y gate completo posterior **exit 0**, CPUs 0–1 y heap Node 1024 MB.
  **2.151 backend, 2 omitidos**, cobertura **84,46 %**; **1.329 frontend**;
  tipos/lint/formato/build y tres presupuestos verdes, sin rebajar umbrales.
  Knip 30 avisos conocidos + 1 hint; Mypy ausente/opcional. Los tests generales
  de kanban pueden invocar CLI Hermes aislada, no modelos.
- Revisión adversarial (registro privado): **sin hallazgos ni bloqueantes**; las
  tres funciones comparadas también byte a byte, 51 originales, 51 extraídos y
  9 HTTP existentes verdes. Ruff y diff-check del revisor verdes; gate completo
  y mutaciones ejecutados por el padre, no por el revisor.
  Sin Playwright ni integración con perfiles nativos/modelos. Los HTTP existentes
  no equivalen a integración de navegador ni a una auditoría completa de auth.

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
