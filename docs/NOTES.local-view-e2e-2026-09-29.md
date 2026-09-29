# Estado: continuation point — Local View E2E (2026-09-29)

Detenido a pedido del usuario para reiniciar la PC. Nada quedó en un estado
intermedio: el árbol de trabajo estaba limpio respecto al momento de la pausa.

## Rama

`feat/local-view-activity` sobre `1b85f88`. Todo sin commitear. El diff mezcla
trabajo previo de la rama con los cambios de este encargo — no separarlos a
ciegas.

Archivos de este encargo:
- `vite.config.ts` — bind `127.0.0.1`, `allowedHosts: false`
- `vite.config.test.ts` — regresión de la config Vite cargada (nuevo)
- `playwright.config.ts` — bridge con `.venv/bin/python`, `timeout: 90_000`
- `e2e/local-view.spec.ts` — entrada/salida, chat, actividad WebSocket
- `server/subagent_tracker.py` + `server/test_subagent_tracker.py` —
  `tool_use` anidado en `assistant.message.content`

## Verificado en verde

- `bash scripts/check.sh` → rc 0. 1096 tests frontend, 1212 backend + 2 skipped.
- `vite.config.test.ts` pasa (regresión roja antes del fix de bind).
- `server/test_subagent_tracker.py` → 19 passed.
- E2E `actividad por WebSocket se dibuja sobre la unidad y expira` → passed.
  En verde **con** aserción de píxeles: 68 píxeles del color del glifo
  (`#ffd166`) dentro del recorte 64×64 capturado en el instante del
  `fillText('✳')`, con el punto en pantalla (`py ≈ 95` de 720).
- E2E `monta el chat` aislado → 3/3 passed.
- E2E `monta el chat|actividad por WebSocket` juntas → 2 passed.
- Prettier limpio en los cuatro archivos de config/spec.

## El test del chat: cerrado como intermitente por carga, no por lógica

Tras el reinicio, la corrida completa de `local-view.spec.ts` dio **5 passed /
1 failed** — el único fallo fue el de FPS. `monta el chat` pasó dentro de la
corrida completa. Combinado con las 3 pasadas aisladas y la pareja con el test
de actividad, la hipótesis de estado residual no se sostiene: era ruido de
carga. **No diagnosticado más a fondo; no hay regresión abierta aquí.**

## El test de FPS: sí es un defecto real, y es del render

`rendimiento: FPS sostenido` mide **2,7–2,8 FPS de media**, contra un umbral
de 10 y un rango histórico documentado de 13,9–18,4.

Descartado el entorno con medición, no con suposición. Se añadió
`e2e/fps-baseline.spec.ts`: abre una página vacía en el mismo Chromium headless
y mide su techo de `requestAnimationFrame`.

- Página vacía, mismo momento, **load average 9,5**: **57,4 FPS**.
- Vista Local de RepoCiv, misma carga: **2,8 FPS**.

La máquina no es el techo; el render sí. **Es una regresión de rendimiento de
la Vista Local**, no un umbral mal puesto ni ruido.

Comparación contra `main` (todo el trabajo de la rama en `git stash`, solo
`playwright.config.ts` restaurado porque el original usa `python3` sin venv y
el bridge no arranca — `ModuleNotFoundError: No module named 'idna'`): en
`main` el test **ni siquiera completa la medición** (`page.evaluate` excede los
60 s). O sea: `main` tampoco rendía, pero por un motivo distinto. **El
rendimiento de Vista Local no es una regresión introducida por este trabajo;
es una degradación preexistente que el test documenta desde 2026-06-05 y que
hoy es mucho peor que entonces.**

Siguiente paso al retomar: perfilar el render de Vista Local (`src/isoLocalRenderer.ts`,
`src/localRenderer.ts`) antes de tocar el umbral. **Bajar el umbral para que
pase sería falsificar la medición.**

## Prueba de Baseline: cómo atribuir un rojo de FPS

`e2e/fps-baseline.spec.ts` existe para esta pregunta: ¿el 2,8 es del código o
de la máquina? Corre el techo del entorno en la misma sesión. Si el baseline
también cae, es la máquina; si el baseline se mantiene y la vista no, es el
render. La cifra es el resultado; el test solo afirma que la medición corrió
(`samples === 10`), para que una medición rota no pase por resultado.

## Fallos preexistentes — NO tocar (pero sí diagnosticar: tienen causa raíz)

La suite completa del repo (27 tests) dio **9 passed / 18 failed en 42.8 min**.

**Los 15 fallos de `hero-chip` son UN solo defecto, no quince.** Rastreado con
`git log -S`:

```
c2c7214 2026-09-21 feat(ui): F8 queda como única vista de agentes — la barra inferior desaparece
```

Ese commit borró `#hero-bar-slots` (y 546 líneas de HUD, incluido
`botModeSpawner.ts` y `sessionLauncherSummary.ts`) **del código de producción**.
`grep -rn 'hero-bar-slots'` sobre `src/` devuelve **cero**. El elemento ya no
existe: la barra de agentes fue reemplazada por F8 como vista única.

Pero los selectores E2E **nunca se actualizaron** y siguen apuntando al elemento
muerto. Afecta `chat-model-picker.spec.ts:107`, `profile-selector.spec.ts:147`,
`repociv.spec.ts:65,86`.

Es decir: **8 días de specs rotos por un cambio de producto que sí se aplicó.**
No es un bug del producto; es deuda de test no actualizada.

**No tocar estos specs** (fuera del alcance acordado «vamos con 1 y 2»), pero
cuando se aborden: no es «arreglar 15 tests», es migrar los tres selectores al
reemplazo de F8 y borrar el bloque legacy `.hero-chip` de
`src/styles/components.css:448-473` (ya comentado como *legacy*).

Los otros 3: `local-view-memory` (heap), `local-view` FPS (2,8, ver arriba), y
`repociv.spec.ts` flujo bridge.

## Verificado preexistente por medición, no por suposición

Con *todo* el trabajo de la rama en `git stash` (incluido `src/`,
`vite.config.ts` y `playwright.config.ts`), `repociv.spec.ts` → `carga inicial`
falla igual. Código base `1b85f88` limpio. No es regresión de este trabajo.

**Trampa al reproducirlo:** el `playwright.config.ts` de `main` usa `python3`
sin el venv, así que el bridge E2E no arranca (`ModuleNotFoundError: No module
named 'idna'`). Hay que restaurar solo ese archivo del stash para que la
comparación sea válida.

## Trampa conocida

`vite.config.ts` tenía `host: '0.0.0.0'` con un comentario que **ya decía
"loopback-only"** — el comentario y el código se contradecían, y el propio
código lo anotaba como *"loopback-only was hiding the server from Windows
browser"*. No reintroducir `0.0.0.0` como arreglo de conectividad: la
afordancia real es el acceso por Tailscale al puente, no abrir el bind.

La **credencial local del bridge sigue inyectada en el bundle cliente**
(`src/bridgeEnv.ts`). El bind a loopback reduce la exposición pero no la
elimina. Fuera del alcance acordado; requiere decisión aparte.

`magick` está bloqueado por la security policy de ImageMagick en esta máquina
(`HISTOGRAM` y `INFO` no autorizados). Para analizar píxeles, contar en el
navegador desde el propio canvas, no con `magick`.

## Pendiente de decisión de Cristóbal

Credencial local del bridge inyectada en el bundle cliente: sigue presente. El
bind a loopback reduce la exposición pero no la elimina. Fuera del alcance
acordado («vamos con 1 y 2»); requiere decisión aparte.

## Evidencia visual

- `test-results/local-activity-raster.png` — recorte 64×64 en el `fillText`.
- `test-results/local-activity-frame.png` — canvas completo 1280×720.
- `test-results/local-activity-zoom.png` — región 320×320 alrededor del punto.

El frame completo es la prueba de por qué hizo falta zoom: la unidad queda
fuera de encuadre (`py = -960` en un canvas de 720). Por eso el test ahora
hace zoom out con rueda antes de medir, en vez de afirmar sobre un draw
off-camera.
