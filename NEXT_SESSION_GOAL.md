## Goal

Continuar mejorando la vista 3D de **RepoCiv** (dashboard de ciudades hexagonales estilo Civilization V) hasta que se vea limpia y consistente. Ya está restaurado el anillo hexagonal cerrado de murallas y las torres en los 4 vértices alternos del hex. El usuario validó visualmente que la muralla ahora se ve como anillo continuo en vez de 6 pedazos sueltos, pero reportó "quedo verdaderamente mejor, aun queda un pco desalineado si". Quedan 2 desalineaciones medidas pero no resueltas.

## Estado actual (al cierre de la sesión anterior)

- **Repo:** `/home/gris/.hermes/workspace/repos/repociv`
- **Branch único:** `main` (local + remote, sin features)
- **Último commit:** `c3e79b6 fix(3d): align corner towers with hex vertices (0/60/180/240), not cardinals`
- **Top 3 commits (sesión):**
  - `c3e79b6` — torres en vértices del hex (4 alternate, no cardinales)
  - `acb2695` — anillo hexagonal cerrado (Shape + ExtrudeGeometry) reemplaza 6 BoxGeometry separadas
  - `4f81ed6` — restaura PR #4 (plaza+spire+sun fijo+edge-routed rivers)
- **Push:** hecho con `git push --force-with-lease origin main` (aprobado por el usuario). `origin/main` ahora en `c3e79b6`.
- **Servicios activos:** bridge `python3 -m server.bridge` en :5274, vite en :5273 (vite cache: `node_modules/.vite` se borra con `rm -rf` para forzar rebuild limpio)
- **Tests:** `npx tsc --noEmit` y `npx vitest run src/three/CityCluster3D.test.ts src/spatialDirectives.test.ts src/three/HexWorldScene.test.ts` → 18/18 ok

## Lo que el subagente midió con análisis de píxeles (sesión anterior, commit `c3e79b6`)

Antes (clip viejo del usuario `clip_20260615_185155_1.png`):
- 9 sub-clusters de muralla desconectados (tamaños 1026, 786, 302, 2771, 869, 199, 151, 112, 34 px)
- 60% con topología de anillo
- "scattered dots" = señal estructural real

Después (clip nuevo `clip_20260615_193316_2.png`):
- 6 anillos cerrados (1 por ciudad), 100% con topología de anillo
- 2.4× más píxeles de muralla
- Auto-centrado (centroide vs hueco, 1.5 px de offset)
- "verdaderamente mejor" según el usuario
- **PERO:** 2 desalineaciones residuales que NO arreglé todavía:
  1. **Plaza offset 60 px del centro del hueco de la muralla**: `plaza center=(252,158)`, `hole center=(195,176)`. Probablemente artefacto de proyección isométrica (la plaza es un disco horizontal, la muralla es un anillo vertical — proyectan distinto en pantalla, aunque en world space estén en el mismo `(base.x, base.z)`). Verificar antes de tocar.
  2. **Asimetría del anillo**: radios muestreados en 12 direcciones alrededor del hueco varían de 38 a 112 px (span 74 px, std 16.3). 30° vs 210° difieren en 52.8 px. El hex source code es regular (`(Math.PI/3)*i` para i=0..5), así que probablemente la asimetría es artefacto de muestreo del subagente, no geometría real. Verificar.

## Metodología de verificación (importante: la tool de visión está rota)

- `vision_analyze` falla con `Gemini HTTP 400 (unexpected model name format)` — no insistir.
- `browser_navigate` está bloqueado para `http://localhost:*` (private-address).
- **Usar la skill `dev/programmatic-visual-verification`** (recién creada) que está en `~/.hermes/skills/dev/programmatic-visual-verification/SKILL.md`.
- Flujo: capturar con Playwright (`page.locator('#main-canvas').screenshot()`), decodificar PNG con `zlib` o PIL, análisis programático de píxeles (colores, componentes conectados, topología de anillo, etc.).
- El subagente (vía `delegate_task`) puede correr el script de análisis. Pedirle reporte estructurado con números + visualizaciones, no veredictos vagos.
- El usuario provee clips (589×391 PNG en `/home/gris/.hermes/images/clip_*.png`) cuando quiere que verifique lo que ve. Comparar siempre contra captura fresca propia en el mismo zoom/seed.

## Scripts de análisis existentes (en `scripts/` del repo)

- `verify-city-walls.mjs` — cuenta píxeles por color, valida presencia de plaza/spire/wall/landmark
- `cluster-city-walls.mjs` — grid 32×18 con color dominante por celda, ratio de agrupamiento
- `wall-connected-components.mjs` — flood fill + bounding boxes de los píxeles de muralla
- `compare-to-user-clip.mjs` — captura fresca 589×391 y compara contra el clip del usuario
- `screenshot-3d-audit.mjs` — 7 cámaras golden (01-07) que el repo mantiene

## Reglas de operación standing

- **No `rm -rf`, no `git push --force`, no matar servicios sin aprobación explícita del usuario.** Mostrar el plan y esperar "ok" / "dale" / "si vamos alla".
- **Commits atómicos:** uno por fix, mensaje claro con prefijo `fix(3d):` / `feat(3d):` y por qué, no qué.
- **Antes de cualquier push que no sea fast-forward, mostrar qué se va a sobrescribir** y dar 3 opciones (rebase, force-with-lease, branch nuevo) con riesgos.
- **Cuando un clip del usuario muestra un síntoma, NO decir "ya está arreglado" basándose en métricas de píxeles.** Dar la falsificación estructural (X componentes, Y% topología de anillo, etc.) y dejar que el usuario confirme.
- **Idioma del usuario:** español principalmente. Reporta en español, comandos y outputs en inglés tal cual.

## Próximas tareas concretas (en orden de probabilidad de que el usuario las pida)

1. **Investigar las 2 desalineaciones residuales** (plaza offset, asimetría de anillo) — generar clip fresco, correr subagente de análisis, decidir si son reales o artefactos de proyección.
2. **Regenerar los goldens** (`e2e/golden/01-07.png`) con `node scripts/screenshot-3d-audit.mjs --update` para reflejar el render actual, así el CI no reporta falsos positivos de diff.
3. **Resolver el stash viejo:** `git stash list` muestra 2 stashes de feat/chat-model-picker y feat/profile-registry que ya están mergeados a main. `git stash drop stash@{0} stash@{1}` si el usuario confirma.
4. **Cerrar PR #4** en GitHub (ya no existe como rama, pero el PR queda abierto en la historia).
5. **Continuar con Wonder 3D** (commit perdido en sesiones anteriores: `wonderVignette.ts`, `WonderProps3D.ts`, `wonder_services.py`) — el usuario lo mencionó como trabajo pendiente antes de esta sesión.
6. **Mejorar la oficina local** (el commit `f40eb97` sobre ventanas en muros y el `placeWallWindows` están bien, pero hay room para mejorar sprites de sillas, decor, etc.).

## Archivos clave a tocar si seguís con la muralla 3D

- `src/three/CityCluster3D.ts` — el fix está en los commits acb2695 y c3e79b6; el resto del archivo (civic centre 105-180, spire 138-145, capital landmarks 147-160) es del iter11 restaurado.
- `src/three/HexWorldScene.ts` — `SUN_POSITION` constante en línea 131, `sunLight.position.set(SUN_POSITION...)` en 148.
- `src/three/Rivers3D.ts` — `edgeRoutePath` en línea ~185, color turquesa en ~338.
- `src/spatialDirectives.ts` — `interpretUnitDrag` retorna null para drag normal a ciudad, shift+drag crea run_tests.
- `src/three/CityCluster3D.test.ts`, `src/three/HexWorldScene.test.ts` — tests rojos que ahora son verdes, mantenerlos.
