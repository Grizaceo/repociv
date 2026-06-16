# Plan — Auto-arranque de Maravillas + Estructuras 3D en el mapa

Fecha: 2026-06-16
Alcance acordado con el usuario:
1. **Auto-arranque**: RepoCiv debe levantar por sí mismo los servidores de `institutum` (LabHub) y `bibliotheca` (La Gran Biblioteca) y abrirlos en sus iframes, **sin depender de que estén corriendo de antemano**. Modo elegido: **arranque automático al abrir**.
2. **3D**: renderizar `institutum` y `bibliotheca` como **maravillas 3D distintivas en el mapa hex WebGL** de RepoCiv (hoy salen como `sacred tiles` genéricos). Trabajo en `src/three/`.

---

## 0. Auditoría — estado actual y hallazgos

### 0.1 Arquitectura de Maravillas (iframe)
- Las maravillas se declaran dos veces (deben mantenerse en sync):
  - Frontend: `src/wonders/manifest.ts` (fuente de verdad TS) + `src/wonderEnv.ts` (URLs/probes).
  - Backend: `server/wonder_registry.py` (registry servido por el bridge) + `server/labhub_adapter.py` (status vivo).
- El iframe se monta en `src/ui/wonderVignette.ts::openWonderVignette()`. Flujo: chequea health → si offline, muestra `_showEmptyState()` con **instrucciones copy-paste** y un botón **"Reintentar"**. **No hay capacidad de lanzar nada.**
- El bridge **solo sondea** (`labhub_adapter._probe_institutum`, `wonder_registry.check_wonder_health`). **No existe endpoint para arrancar procesos.**

### 0.2 Apps externas (repos hermanos en disco) — comandos de arranque reales
| Maravilla | Repo (cwd) | Procesos | Puertos | Health |
|---|---|---|---|---|
| `bibliotheca` (LGB) | `~/.hermes/workspace/repos/la-gran-biblioteca` | `python -m backend.library_bridge` (API) · `cd frontend && npm run dev` (UI) | API **3001**, UI **5173** | `http://127.0.0.1:3001/api/health` |
| `institutum` (LabHub) | `~/.hermes/workspace/repos/labhub` | `npm start` → `scripts/dev-start.sh` arranca **bridge** (`python3 -m server.bridge`) **+ Vite** (`npm run dev`) | bridge/API **5281**, UI **5280** | `http://localhost:5281/health` |

> Nota: existe también `~/.hermes/workspace/repos/labhub-oss` (variante OSS). El canon vivo es **`labhub`** (tiene `.env`, fechas recientes, puerto 5281). El plan apunta a `labhub`, con la ruta configurable por env para poder cambiar a `labhub-oss`.

### 0.3 BUGS / drift detectados (arreglar como parte del plan)
1. **Puerto del iframe de Institutum equivocado.** `src/wonderEnv.ts:18` define `WONDER_INSTITUTUM_URL = http://localhost:5281` (eso es el **bridge/API**, sirve JSON). La UI de LabHub vive en **:5280**. `server/wonder_registry.py:152` ya usa `:5280` correcto → **el frontend y el backend están desincronizados**. Resultado: aunque LabHub esté arriba, el iframe carga la API, no la UI. (Ya anotado en `docs/ROADMAP_IMPERIAL_WORKSHOP.md:169,390`.)
2. **Probe UI/backend solo existe para LGB.** `wonderEnv.ts` tiene `findReachableLgbUiUrl()` / `checkLgbReachability()` (separa UI vs backend), pero Institutum usa un solo health (`_checkWonderHealth`) contra :5281 — nunca verifica que la UI :5280 esté lista antes de montar el iframe.
3. **Sin lifecycle.** No hay arranque, ni estado de arranque, ni parada. El `WONDER_CONTRACT.md` no cubre ciclo de vida.

### 0.4 Estado 3D de las maravillas (WebGL)
- Las maravillas se colocan como tiles de distrito en `src/map.ts:1014-1100`: `bibliotheca` en `q=-1,r=0`, `institutum` en `q=1,r=0`, ambas `terrain:'sacred'`, `district.type:'wonder'`, `district.wonderType`.
- El **2D canvas** (`src/hexRenderer.ts:624-766`) ya dibuja visuales ricas: templo (bibliotheca) y matraz/flask (institutum), animados y con labels.
- El **WebGL/3D NO las distingue**: `src/three/TileDecor3D.ts::buildSacred()` (≈385-429) trata TODO tile `sacred` igual (standing stones + altar + gem). `CityCluster3D.ts` solo procesa `City[]`, no lee `districts`. **No hay geometría específica de maravilla, ni GLB de maravilla** en `public/assets/3d/props/`.
- Dato clave a favor: la escena 3D ya itera `state.world.tiles` (p.ej. `HexWorldScene.ts:470`), y los tiles **ya llevan** `district.type==='wonder'` y `district.wonderType`. La data está disponible; solo falta consumirla en 3D.
- El click en tile de maravilla ya abre la viñeta en 2D (`renderer.ts:681-690`). Hay que asegurar la paridad en el pick 3D.

---

## Parte 1 — Auto-arranque de maravillas desde el frontend

Objetivo: al abrir RepoCiv (y/o al abrir una maravilla offline), el bridge lanza los procesos, espera health y monta el iframe. Sin terminales manuales.

### 1.1 Backend — nuevo lanzador en el bridge
**Nuevo archivo `server/wonder_launcher.py`:**
- `WONDER_LAUNCH_SPECS`: **allowlist** keyed por id. Cada spec define una lista de procesos con **argv fijo** (sin shell), `cwd` resuelto desde env, y health/ready checks:
  - Rutas configurables:
    - `REPOCIV_WONDER_BIBLIOTHECA_DIR` (default `~/.hermes/workspace/repos/la-gran-biblioteca`)
    - `REPOCIV_WONDER_INSTITUTUM_DIR` (default `~/.hermes/workspace/repos/labhub`)
  - `bibliotheca`: proc A = `[python, -m, backend.library_bridge]` cwd=repo; proc B = `[npm, run, dev]` cwd=`repo/frontend`. Ready = API `:3001/api/health` OK **y** UI `:5173/` responde.
  - `institutum`: proc único = `[npm, start]` cwd=repo (su `dev-start.sh` levanta bridge :5281 + Vite :5280). Ready = `:5281/health` OK **y** UI `:5280/` responde.
- `launch_wonder(id) -> dict`: **idempotente**.
  - Si ya está ready → `{status:"already_running"}` sin spawnear.
  - Si no → `subprocess.Popen(argv, cwd=..., start_new_session=True, stdout/stderr=<log>)`, logs en `~/.repociv/wonders/logs/<id>-<proc>.log`. Detached (sobrevive al request).
  - Registrar PIDs + puerto + timestamp en `~/.repociv/wonders/launched.json`.
  - Lock por id para evitar doble-spawn concurrente.
- `wonder_launch_status(id) -> dict`: `{status: starting|ready|offline|error, ready:{api,ui}, pids, log_tail}`. Combina health checks + PIDs vivos.
- `stop_wonder(id)`: matar el process-group registrado (para un botón "detener" opcional).
- **Guardas de seguridad**:
  - Solo ids del allowlist; argv fijo del lado servidor; **nunca** comando provisto por el cliente.
  - Verificar que `cwd` existe (si no → error claro "repo no encontrado, configura REPOCIV_WONDER_*_DIR").
  - **Rechazar si `REPOCIV_REMOTE=true`** (no spawnear procesos desde sesión remota; loopback-only).
  - Reusar el patrón de spawn ya presente en `server/agent_runner.py` / `server/container_runtime.py`.

### 1.2 Backend — rutas en el bridge
- `server/routes/core.py` (donde viven `get_wonders`/`get_wonder_health`): añadir
  - `post_wonder_launch(ctx, body)` → `wonder_launcher.launch_wonder`
  - `get_wonder_launch_status(ctx)` → `wonder_launcher.wonder_launch_status`
  - `post_wonder_stop(ctx, body)` (opcional)
- `server/bridge.py`:
  - **GET** (bloque prefix `do_GET` ≈línea 600, junto a `/api/wonders/{id}/health`): manejar `…/{id}/launch-status`.
  - **POST** (bloque prefix `do_POST` ≈línea 737): `POST /api/wonders/{id}/launch` y opcional `…/{id}/stop`. El token + rate-limit ya se aplican en `do_POST` (líneas 683-689). ✔ seguro por defecto.

### 1.3 Frontend — cliente + flujo de arranque
**Nuevo `src/wonders/wonderLauncher.ts`:**
- `launchWonder(id)`: `POST {bridgeUrl}/api/wonders/{id}/launch` con `bridgeHeaders()`.
- `pollWonderUntilReady(id, {timeoutMs=60000, intervalMs=1500})`: loop sobre `GET …/launch-status` hasta `ready` o timeout; devuelve `{ready, apiUrl, uiUrl}`.

**`src/ui/wonderVignette.ts` — reemplazar el flujo offline:**
- Cuando health/reachability falla, en vez de solo instrucciones: mostrar estado **"⚙️ Levantando la maravilla…"**, llamar `launchWonder(id)` + `pollWonderUntilReady`, y al quedar `ready` montar el iframe (`_mountIframe`) con la URL UI resuelta.
- Si el arranque falla/timeout → caer al `_showEmptyState` actual (instrucciones + botón), ahora también con botón **"Levantar de nuevo"**.

**`src/main.ts::bootstrap()` — arranque automático al abrir (decisión del usuario):**
- Tras `bridge.start()` (≈línea 604), disparar **no-bloqueante** `ensureWondersUp(['bibliotheca','institutum'])` que hace launch+poll en background y reporta vía `notificationBanner`/log (no congelar el boot del mapa).
- Gobernado por un flag en settings `autoStartWonders` (**default ON**, exponible en `settingsPanel.ts`) para poder desactivarlo.

### 1.4 Arreglar el drift de puertos (bloqueante para que el iframe funcione)
- `src/wonderEnv.ts`: `WONDER_INSTITUTUM_URL` default → **`http://localhost:5280`** (UI). Mantener `WONDER_INSTITUTUM_API_URL = :5281` (health). Actualizar `src/wonderEnv.test.ts`.
- Generalizar el split UI/backend que hoy es solo-LGB: añadir probes de Institutum (UI :5280 vs API :5281) y un `findReachableWonderUiUrl(manifest)` genérico; usarlo en `openWonderVignette` para Institutum igual que para Bibliotheca (esperar a que la UI esté lista antes de montar).
- `.env.example`: corregir el comentario de Institutum y añadir `VITE_WONDER_INSTITUTUM_URL=http://127.0.0.1:5280`.

### 1.5 Cross-cutting iframe (verificar, no asumir)
- **Frame-ability**: confirmar que LGB (Vite :5173 y su `frontend/nginx.conf` en modo Docker) y LabHub (:5280) **no** envían `X-Frame-Options: DENY/SAMEORIGIN` ni CSP `frame-ancestors` restrictivo que bloquee el embed desde RepoCiv :5273. Vite dev normalmente no los pone; el nginx de LGB sí podría. Si bloquean, añadir `frame-ancestors` permisivo para loopback en esos repos (cambio menor en cada app).
- **postMessage origin**: `registerWonderOrigin(manifest)` ya valida origin desde la URL del manifest; al corregir el puerto a :5280 queda consistente.

### 1.6 Aceptación Parte 1
- Con ambos repos presentes y **ningún** servidor corriendo: abrir RepoCiv → en ≤60s los dos iframes muestran las apps reales (no JSON, no "en construcción").
- Segundo `launch` es idempotente (no duplica procesos).
- En `REPOCIV_REMOTE=true` el launch responde 4xx claro y la UI muestra instrucciones manuales.

---

## Parte 2 — Maravillas como estructuras 3D en el mapa

Objetivo: en WebGL, `bibliotheca` e `institutum` se ven como edificios distintivos (no `sacred` genérico), en paridad de identidad con el 2D.

### 2.1 Nuevo `src/three/WonderProps3D.ts`
- Patrón espejo de `CityProps3D.ts` / `ResourceProps3D.ts`: API `rebuildWonderProps(tiles)`, `getWonderPropsGroup()`, `clearWonderProps()`, con dirty-check por firma de tiles (estilo `tileCountSignature` en `HexWorldScene.ts`).
- Para cada tile con `district.type==='wonder'`, construir por `wonderType`:
  - **`bibliotheca` → templo**: dais de piedra escalonado + columnata (columnas/obeliscos) + frontón/techo con leve glow. Eco del templo 2D.
  - **`institutum` → laboratorium**: cuerpo tipo domo/observatorio o torre-matraz con glow emisivo de "experimento". Eco del flask 2D.
  - **`gaceta`**: nativa, hoy sin tile en el mapa → omitir (pabellón opcional a futuro si se le da tile).
- **Procedural-first** (flat-shaded low-poly, coherente con el lenguaje de decor actual — ver memorias iter13/iter14): cero dependencia de assets, entra de inmediato.
- **Opción GLB** (fase posterior): consumir `wonder-bibliotheca-0.glb` / `wonder-institutum-0.glb` desde `public/assets/3d/props/`, producidos por `repociv-3d-asset-forge` (RepoCiv solo consume, sin auto-install — ver memoria asset_forge). Cargar con el loader existente (`mergeGlbScene.ts`), con fallback procedural si el GLB falta (mismo patrón que `TileDecor3D`/`ResourceProps3D`).

### 2.2 Suprimir el decor genérico en tiles de maravilla
- En `TileDecor3D.ts::buildSacred()`: si `tile.district?.type==='wonder'`, **saltar** el altar+gem genérico (para no doblar geometría); conservar el anillo de standing-stones como plinto, o reemplazarlo por la base del edificio. Reutilizar el enfoque "decor de relieve suprimido en tiles con city" (memoria iter12).

### 2.3 Wire en la escena + labels + pick
- `src/three/HexWorldScene.ts`: importar y llamar `rebuildWonderProps(tiles)` en el update; `scene.add(getWonderPropsGroup())`; dispose en rebuild.
- `src/three/MapLabels3D.ts`: añadir labels de maravilla (BIBLIOTHECA / LABHUB), reutilizando el sistema de labels de distrito.
- **Pick 3D**: asegurar que clicar la maravilla en WebGL abra la viñeta igual que en 2D. Revisar el handler de pick en `ThreeMapRenderer.ts`/`HexPicker.ts` y enrutar a `openWonderVignette(wonderType)` (en 2D ya está en `renderer.ts:681-690`).

### 2.4 Layer gating (paridad con 2D)
- Respetar las capas existentes: bibliotheca bajo `knowledge`, institutum bajo `labs` (en 2D se gatean en `renderer.ts:1190-1225`). Exponer visibilidad del grupo 3D según `getLayerState()`.

### 2.5 Goldens / e2e
- Añadir cámara golden que encuadre capital + las dos maravillas. Regenerar goldens **en el mismo entorno** (software-GL aquí) con before/after — **no** `--update` a ciegas (memoria iter9/iter6). Tests unitarios `WonderProps3D.test.ts`: geometría por `wonderType`, supresión en tiles no-wonder.

### 2.6 Aceptación Parte 2
- En `?renderer=webgl`, las tiles `q=-1` y `q=+1` muestran templo y laboratorio distintos entre sí y del keep capital.
- Click 3D abre la viñeta correcta.
- Las capas `knowledge`/`labs` ocultan/muestran cada maravilla.
- `npm run check` + goldens verdes.

---

## Parte 3 — Seguridad, config, docs, tests

- **Seguridad** (Parte 1): endpoint loopback-only, token-gated (ya en `do_POST`), allowlist de ids + argv fijo, rechazo en modo remoto, logging de spawns. Documentar superficie de riesgo en `SECURITY.md`.
- **Config**: `.env.example` + `REPOCIV_CONFIG_DIR` → añadir `REPOCIV_WONDER_BIBLIOTHECA_DIR`, `REPOCIV_WONDER_INSTITUTUM_DIR`, corregir `VITE_WONDER_INSTITUTUM_URL`.
- **Docs**: `docs/WONDER_CONTRACT.md` → nueva sección "Ciclo de vida / arranque" (manifest opcional con `launch` spec). `docs/GETTING_STARTED.md` → "RepoCiv ahora levanta las maravillas solo". `docs/ROADMAP_IMPERIAL_WORKSHOP.md` → cerrar el item de drift 5280/5281.
- **Tests**:
  - Python: `server/test_wonder_launcher.py` (idempotencia, rechazo de id no-allowlist, rechazo remoto, status, repo inexistente).
  - TS: actualizar `wonderEnv.test.ts` (puertos), nuevo `wonderLauncher.test.ts` (polling/montaje), `manifest.test.ts` si se añade `launch` al tipo.
  - 3D: `WonderProps3D.test.ts` + goldens.

---

## Secuencia recomendada (fases pequeñas y verificables)

- **F1 — Arreglo de puerto + probe Institutum** (rápido, desbloquea el iframe aunque el server ya esté arriba). 1.4.
- **F2 — Lanzador backend + rutas** (`wonder_launcher.py`, endpoints, tests Python). 1.1–1.2.
- **F3 — Cliente + flujo en viñeta + auto-start en boot**. 1.3.
- **F4 — Cross-cutting iframe (frame-ancestors)** verificar y, si hace falta, parchear LGB/LabHub. 1.5.
- **F5 — `WonderProps3D` procedural + supresión sacred + wire/labels/pick**. 2.1–2.4.
- **F6 — Goldens + tests 3D + docs**. 2.5, Parte 3.
- **F7 (opcional) — GLB de maravillas vía asset-forge**. 2.1.

## Riesgos / notas
- Spawnear procesos desde un endpoint web es sensible: mitigado por allowlist + argv fijo + loopback + token + rechazo remoto.
- Doble fuente de manifests (TS + Python) debe mantenerse en sync al tocar puertos/launch.
- Goldens 3D son GPU-sensibles: comparar before/after en el mismo entorno.
- `labhub` vs `labhub-oss`: ruta por env; default `labhub`.
- El auto-start asume que los repos hermanos existen y tienen deps instaladas (`npm i`, `.venv`); el error de "repo no encontrado / deps faltantes" debe ser explícito en la UI.
