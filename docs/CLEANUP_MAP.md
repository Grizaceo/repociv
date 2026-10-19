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

**Cortes 1–2 completados:** documentación en `31cf99e` y clasificación Knip abajo,
sin retirar exports por el solo informe. Siguiente candidato: elegir un único
subgrupo de higiene de exports o geometría isométrica (3), con caracterización
previa. No empezar simultáneamente frontend y backend; las filas siguen
describiendo las condiciones de cada trabajo.

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

| Símbolos | Clasificación / evidencia y límite |
| --- | --- |
| `openLogPanel`, `refreshActivityHistory` | Conservar exports. `e2e/activity-presentation.spec.ts:81` y `activity-correlation.spec.ts:123` importan el módulo servido por Vite; también usados internamente en `logPanel.ts:140,301,303`. |
| `openTaskPanel`, `refreshTaskInventory` | Conservar exports. Imports en `activity-presentation.spec.ts:86,115,130`, `activity-correlation.spec.ts:122` y `pending-work.spec.ts:41`; registro interno de panel en `taskPanel.ts:419,421`. |
| `openKanbanPanel` | Conservar export. Import en `e2e/kanban-create.spec.ts:54`; llamado internamente en `kanbanPanel.ts:79`. |
| `notifyWorkingUnitsChanged` | Candidato a desexportar, **no borrar**: referencias internas en `chat/state.ts:132,135,167`. |
| Tipos `EraDefinition`, `CapabilitiesAgent`, `CapabilitiesSnapshot` | Candidatos a desexportar, no borrar sus definiciones: usos internos en `eraSystem.ts:14` y `capabilitiesClient.ts:18,69,89,92,116,128`. |
| `unmountGacetaWidget` | Sin caller localizado fuera de su definición (`gacetaWidget.ts:118`). Mantener el teardown hasta revisar ciclo de vida; la ausencia de llamadas no demuestra que eliminarlo sea prudente. |
| `getCurrentEraIndex`, `getEraLabel`, `updateEraDisplay` | Candidatos a inspeccionar como cadena: los dos primeros tienen callers internos en `eraSystem.ts:62–64`; no se localizó caller externo del tercero. No borrar `getStoredEraLabel`, usado en main y capitalPanel. |
| `setFullCapabilitiesForTesting`, `getCapabilitiesSnapshot`, `setCapabilitiesSnapshotForTesting`, `resetCapabilitiesSnapshotForTesting`, `isCapabilitiesSnapshotLoaded`, `initCapabilities` | Sin callers externos localizados en `capabilitiesClient.ts:53–113`. Revisar el subsistema snapshot por separado; **no borrar el módulo**: `setCapabilitiesForAgentsForTesting` se usa en `spatialDirectives.test.ts:10,30`. No confundirlo con la tabla de `agentCapabilities.ts`. |
| `_testTerrainSurface` | Sin import localizado del objeto de `terrainSurfaceY.ts:121`; el test importa las funciones públicas. Candidato a desexportar/eliminar solo tras cotejar contratos del módulo. |
| `setUnitWorking`, `syncWorkingUnitsFromGameState`, tipo `GameStateLike` | Sin caller externo localizado (`chat/state.ts:128,144,147`); el tipo sirve al segundo helper. Revisar juntos, sin retirar `workingUnits` ni `subscribeWorkingUnits`, usados por `agentChip.ts`. |
| `toggleLayer`, `setLayer`, `resetLayers`, `subscribe` de `layers.ts` | Sin callers localizados de estos exports (`layers.ts:72,96,104,110`). **No borrar el módulo**: `getLayerState` e `isLayerVisible` alimentan wonderVignette, renderer y ordenDeBatalla. No confundir este `subscribe` con GameState u otros homónimos. |

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

Siguiente candidato independiente: debug (`drawIsoDebugOverlay`). Inspeccionar
sus dependencias y efectos antes de extraerlo; no arrastrar dependencias
circulares. No mezclar tiles, paredes, puertas, NPCs y workbenches en ese corte.
Backend y renderer principal permanecen en la cola, no incluidos en temperatura.

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
