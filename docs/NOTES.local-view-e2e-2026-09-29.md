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

## El test de FPS: atribución por medición — y una corrección

`rendimiento: FPS sostenido` mide **2,7–2,9 FPS** de media en cuatro corridas,
contra un umbral de 10 y un rango histórico documentado de 13,9–18,4.

**Medición 1 — ¿es la máquina?** No, en apariencia: `e2e/fps-baseline.spec.ts`
abre una página vacía en el mismo Chromium headless y da **57,4 FPS** con load
9,5, mientras la vista local da 2,8 con la misma carga. Ratio de 20×.

**Medición 2 — coste por clase de dibujo.** Con el cronómetro por lotes
(el `performance.now()` por llamada redondea a 0 en headless y reportaba
números imposibles):

| Clase | Coste por llamada |
|---|---|
| `fillRect` pequeño (2000) | 0,35 µs |
| `save`/`restore` (2000) | 0,65 µs |
| `fillText` (2000) | 0,9–1,7 µs |
| `drawImage` al minimapa (272) | 3,7 µs |

Total por frame de todo eso: **~1 ms**. Un frame a 10 FPS son 100 ms. **El
dibujo 2D no es el cuello de botella.**

**Medición 3 — ¿es el minimapa?** `src/renderer.ts:1198` llama a
`minimapR.draw()` en cada frame, y `computeBounds()` recorre el mapa de tiles
**dos veces** antes de su propio chequeo de `isDirty` — O(tiles) de JS por
frame, incluso con el minimap ya cacheado. Parece un culpable obvio.

**Experimento decisivo:** `MinimapRenderer.draw()` retorna de inmediato si
`#minimap-canvas` no existe, así que quitar el elemento quita la llamada
entera sin tocar producto. Primera corrida dio 0,3 → 2,7 FPS (¡9×!) y parecía
confirmarlo. **Era un artefacto de warmup**, exactamente la trampa que
sospeché: la primera muestra de cualquier sonda rAF cae durante el warmup
(JIT, first paint, decodificación de assets).

Repetido con warmup previo y **el control medido al final**:

| | FPS |
|---|---|
| Sin minimapa | 4,9 y 4,4 |
| Con minimapa | 4,1 y 4,8 |

**Sin diferencia.** El minimapa no es el cuello de botella. La hipótesis del
O(tiles) queda como *candidato no confirmado* — puede seguir siendo un
problema real de CPU, simplemente no uno que mueva la aguja aquí.

**Conclusión honesta: la atribución queda abierta.** Lo que sí es sólido:

- El dibujo 2D no es el problema (~1 ms por frame).
- El minimapa no explica la caída (medido, no supuesto).
- **La máquina está saturada durante todas las corridas: load 10–17 sobre 12
  núcleos**, con RimWorld al 141% y un build de Unreal al 125% compitiendo.
  El `live` de la sonda pasó de 2,8 a 0,6 mientras el load subía de 10,9 a
  15,4.

Es decir: **es plausible que el 2,8 sea mayoritariamente la máquina**, y que
el test de FPS nunca haya tenido una máquina quieta en esta sesión. Eso
invalidaría la afirmación previa de «degradación de render». **No se baja el
umbral**: con esta máquina saturada, el umbral no se puede ni confirmar.

Siguiente paso al retomar, en este orden:
1. Repetir el perfil en una máquina descargada (o con los juegos pausados) y
   ver si el `live` sube a ~14 como documenta el test. Eso decide si hay un
   defecto real.
2. Solo si sigue bajo: instrumentar `render()` con muestreo propio para
   localizar el JS, no el dibujo.

### Trampas de este perfilado

- `performance.now()` por llamada redondea a 0 en headless: hay que medir
  **lotes completos** contra el reloj de pared.
- La primera muestra rAF de la página cae en warmup. Toda comparación
  A/B necesita warmup y **el control al final**.
- `live` y `liveWithWrap` quedaron en 0,1–0,6 en la última corrida: son las
  muestras contaminadas por warmup, no un dato. No citarlas.

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
