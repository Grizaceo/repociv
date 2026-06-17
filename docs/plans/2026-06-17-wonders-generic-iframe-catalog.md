# Plan — Maravillas como catálogo genérico de iframes (conectables por el usuario)

Fecha: 2026-06-17
Continúa: `docs/plans/2026-06-16-wonder-autostart-and-3d.md` (auto-arranque F1–F5, ya mergeado).

## Objetivo (3 pedidos del usuario)

1. **Genéricas.** Una Maravilla debe poder conectar **cualquier servicio apto
   para iframe** que el usuario quiera, no solo Bibliotheca/Institutum. Estas
   dos pasan de "built-ins fijas" a **ejemplos**.
2. **Nada pre-instalado.** Por defecto NO viene activa la Biblioteca ni LabHub.
   En su lugar aparece una **guía de cómo conectar instancias iframe**, con
   Bibliotheca y LabHub como **ejemplos** señalados a sus **repos públicos de
   GitHub** y con su función descrita.
3. **Arranque desde la interfaz.** Para el usuario (que ya las tiene en local),
   el ciclo NO debe requerir levantar el server a mano: levantar y usar ambas
   en iframe directamente desde RepoCiv. *(Ya implementado en el plan
   2026-06-16; este plan lo re-cablea para que dependa del set "conectado +
   habilitado" en vez de la lista hardcodeada `['bibliotheca','institutum']`.)*

---

## 0. Auditoría — estado actual

### 0.1 Lo que YA funciona (no rehacer)
- **Backend registry dinámico.** `server/wonder_registry.py:222-246` ya lee y
  mergea `~/.repociv/wonders/*.json` sobre los estáticos. `GET /api/wonders`
  (server/routes/graph.py:140, wired en bridge.py:687) ya los sirve.
- **Backend launcher genérico.** `server/wonder_launcher.py` ya soporta specs
  de launch custom (`_load_custom_launch_specs`, líneas 158-214), allowlist por
  id, argv fijo server-side, adopción de servers externos (`_try_adopt_external`
  L467), idempotencia, loopback-only (`REPOCIV_REMOTE` rechazado L672), logs en
  `~/.repociv/wonders/logs/`. Endpoints `launch` / `launch-status` / `stop`
  (server/routes/wonder_ops.py).
- **Auto-arranque ciclo de vida (pedido 3).** `src/main.ts:624` corre
  `ensureWondersUp(['bibliotheca','institutum'])` no-bloqueante al boot;
  `src/ui/wonderVignette.ts::_tryAutoStart` (L586) levanta on-demand al abrir la
  viñeta y monta el iframe cuando `ready`. Cliente en `src/wonders/wonderLauncher.ts`.
- **Viñeta iframe casi-genérica.** `openWonderVignette()` ya acepta un
  `WonderManifest` arbitrario y `_mountIframe` (L420) es genérico (usa
  `manifest.ui.url` + `sandbox`). Doc del contrato en `docs/WONDER_CONTRACT.md`
  + guía custom en `docs/CUSTOM_WONDERS.md`.

### 0.2 Los bloqueos reales (lo que hay que cambiar)
- **B1 — Frontend con manifests HARDCODEADOS.** `src/wonders/manifest.ts:18`
  define `WONDER_MANIFESTS` estático (gaceta, bibliotheca, institutum).
  `listWonders()` (L201) solo devuelve esos 3. **Nunca hace `fetch /api/wonders`.**
  → Las maravillas custom del backend NO aparecen en UI (limitación documentada
  en CUSTOM_WONDERS.md §6 y WONDER_CONTRACT.md §5.2). Es la raíz del pedido 1.
- **B2 — `defaultEnabled: true` en ambas built-ins** (manifest.ts:76,132 y
  wonder_registry.py:83,139). Out-of-the-box un usuario sin los repos ve 2 tiles
  que fallan al cargar ("en construcción"). Contra el pedido 2.
- **B3 — Colocación en el mapa HARDCODEADA a 2 coords.** `src/map.ts:1016-1096`
  pone bibliotheca en `q=-1,r=0` e institutum en `q=+1,r=0` con tiles `sacred` +
  `district.type='wonder'`. No hay estrategia para N maravillas arbitrarias.
- **B4 — Auto-start con lista fija.** `main.ts:624` hardcodea los 2 ids; debe
  derivar del set conectado+habilitado.
- **B5 — Sin flujo de "conectar".** Hoy conectar una maravilla custom = editar
  JSON a mano en `~/.repociv/wonders/`. No hay UI ni endpoint de escritura.
- **B6 — 3D solo conoce 2 geometrías.** `src/three/WonderProps3D.ts` tiene
  templo (bibliotheca) y laboratorium (institutum); falta una geometría genérica
  por defecto para maravillas arbitrarias (+ label genérico).
- **B7 — Doble fuente de manifests** (TS estático + Python). El TS debe dejar de
  ser fuente de verdad y pasar a ser fetch del backend (+ fallback mínimo).

### 0.3 Modelo de "conexión" recomendado (decisión clave — confirmar)
**Opción C (recomendada): todo pasa por el mismo camino custom.**
Bibliotheca y LabHub se envían como **plantillas de ejemplo** (no manifests
activos). "Conectar" escribe `~/.repociv/wonders/<id>.json` desde la plantilla
(un clic) → de ahí en más fluyen por el **mismo path** que cualquier servicio
custom (registry + launcher + auto-start). Un único code path.
- Pedido 1 ✔ (un solo mecanismo), pedido 2 ✔ (nada activo por defecto, solo
  guía + ejemplos), pedido 3 ✔ (un clic y auto-launch como hoy).
- Alternativas descartadas: A) flag `installed` en localStorage (mantiene 2
  paths y el doble-source); B) obligar al usuario a copiar JSON a mano (fricción).

---

## Parte 1 — Frontend dinámico (raíz del pedido 1) · [B1, B7]

### 1.1 Registry que fetchea el backend
- `src/wonders/manifest.ts`: convertir el registry en async/cacheado.
  - Nuevo `loadWonders(): Promise<WonderManifest[]>` → `GET /api/wonders` vía
    `bridgeUrl`/`bridgeHeaders` (patrón de `wonderLauncher.ts`). Cachea en
    memoria + revalida.
  - `WONDER_MANIFESTS` estático queda SOLO como **fallback de arranque** (gaceta
    nativa siempre; bibliotheca/institutum se RETIRAN del estático tras la Parte 2).
  - `getWonder(id)`/`listWonders()` leen la caché ya hidratada; añadir
    `ensureWondersLoaded()` llamado en bootstrap antes de construir el capital panel.
- `src/main.ts::bootstrap`: `await ensureWondersLoaded()` antes de armar capital
  panel y antes de colocar tiles de maravilla en el mapa.
- Mantener validación (`_validateManifest`) sobre lo fetchado; descartar inválidos.

### 1.2 Capital panel y viñeta ya genéricos
- `src/ui/capitalPanel.ts:33` ya itera `listWonders()` → al volverse dinámico,
  las custom aparecen como tabs automáticamente. Verificar `_renderWonderTab`
  (no asume bibliotheca/institutum salvo el `statsText` cosmético L150 — generalizar).
- `wonderVignette.ts`: `SPLIT_WONDERS` (L54) y el panel de relaciones siguen
  siendo específicos de bibliotheca/institutum (OK, son features avanzadas
  opt-in). Para maravillas genéricas: ruta de `_checkWonderHealth` + `_mountIframe`
  (ya genérica). El `_tryAutoStart` debe poder correr para cualquier id con
  launch spec (hoy ya llama `pollWonderUntilReady(type)` genérico).

### 1.3 URLs desde el manifest, no desde constantes
- Las custom traen `ui.url`/`health.url` en el manifest servido por el backend.
  `_mountIframe` ya usa `manifest.ui.url`. Las constantes de `src/wonderEnv.ts`
  (WONDER_BIBLIOTHECA_URL, etc.) quedan solo para los **defaults de las dos
  plantillas de ejemplo**.

---

## Parte 2 — Democión a ejemplos + guía de onboarding (pedido 2) · [B2, B5]

### 2.1 Plantillas de ejemplo (no activas)
- Nuevo `src/wonders/exampleTemplates.ts`: array de `WonderExample` con
  `{ manifest, launch, repoUrl, description, defaultRepoDir }` para:
  - **Bibliotheca / La Gran Biblioteca** — grafo de conocimiento sobre repos;
    repo público `<URL-LGB>`; launch = `python -m backend.library_bridge` (:3001)
    + `cd frontend && npm run dev` (:5173).
  - **Institutum / LabHub** — laboratorio de experimentos; repo público
    `<URL-LabHub>`; launch = `npm start` (:5281 API / :5280 UI).
  - (La plantilla espeja exactamente los specs de `wonder_launcher.py:259-306` y
    los manifests retirados del estático.)
- Quitar bibliotheca/institutum de `_STATIC_WONDER_MANIFESTS` (registry Python)
  **y** de `WONDER_MANIFESTS` (TS). El backend deja de listarlas hasta que el
  usuario las conecte (escribe el JSON). Gaceta sigue nativa y siempre activa.

### 2.2 Guía / catálogo de maravillas en la UI
- Nueva vista "Maravillas" (tab en capital panel o panel dedicado):
  - Texto-guía: "Conecta cualquier servicio web local apto para iframe…"
    enlazando `docs/CUSTOM_WONDERS.md`.
  - **Tarjetas de ejemplo** (de `exampleTemplates.ts`): título, función, badge
    "Ejemplo", enlace al **repo público de GitHub**, y botón **Conectar**.
  - Botón **"Conectar un servicio propio…"** → abre el formulario genérico (Parte 4).
- Estado por tarjeta: *no conectada* → muestra "Conectar"; *conectada* → muestra
  "Abrir" + "Desconectar".

### 2.3 Endpoint backend de escritura de manifests
- Nuevo `POST /api/wonders/connect` (loopback-only, token-gated, rechazado en
  `REPOCIV_REMOTE` igual que launch) en `server/routes/wonder_ops.py`:
  - Body: un `WonderManifest` validado (+ opcional `launch`). Escribe
    `~/.repociv/wonders/<id>.json` (sanitizar id: `[a-z0-9_-]`, sin path
    traversal). Recarga registry + custom launch specs en caliente
    (`reset_custom_specs_for_tests` → versión productiva `reload_custom_specs()`).
  - `DELETE /api/wonders/<id>/connect` → borra el JSON (solo de
    `~/.repociv/wonders/`, nunca built-in del repo).
  - Validación dura del `launch.repo_dir` (existe) y `argv` (lista no vacía de
    strings) reutilizando `_validate_launch_field` (ya existe, L109).
- Cliente TS en `wonderLauncher.ts`: `connectWonder(manifest)` / `disconnectWonder(id)`.

### 2.4 "Conectar" un ejemplo (un clic, pedido 2↔3)
- Botón Conectar de una tarjeta de ejemplo → `connectWonder(template.manifest+launch)`
  con `repo_dir` = `defaultRepoDir` (overrideable). Tras conectar: re-fetch
  `/api/wonders`, aparece tab + tile, y queda disponible para auto-launch.

---

## Parte 3 — Mapa: N maravillas dinámicas · [B3, B6]

### 3.1 Colocación dinámica en `src/map.ts`
- Reemplazar las 2 coords fijas (L1016-1096) por una función
  `placeWonders(connectedWonderIds: string[])`:
  - Asigna tiles `sacred` + `district.type='wonder'` en los 6 vecinos del hex
    capital `(0,0)`, en orden estable; si hay >6, anillo siguiente.
  - Bibliotheca/Institutum mantienen sus coords actuales (q=-1, q=+1) cuando
    están conectadas, para no romper goldens existentes.
  - Si no hay maravillas conectadas: capital sin tiles de maravilla (pedido 2).
- La lista de conectadas viene del registry ya fetchado (Parte 1).

### 3.2 3D genérico
- `src/three/WonderProps3D.ts`: añadir geometría **default** (p. ej. obelisco/
  pabellón neutro) para `wonderType` desconocido, manteniendo templo/laboratorium
  para los dos ejemplos. Label = `manifest.title` en mayúsculas (genérico).
- Goldens: regenerar en el MISMO entorno (software-GL), before/after, sin
  `--update` a ciegas (memorias iter6/iter9). Caso "0 maravillas" + caso "1
  maravilla genérica".

---

## Parte 4 — Formulario "Conectar servicio propio" (pedido 1, genérico) · [B5]

- Modal en la vista Maravillas con campos mínimos: `title`, `ui.url`
  (iframe), `health.url` (opcional), y bloque `launch` opcional (repo_dir +
  procs[].argv) para auto-arranque. Defaults seguros del contrato
  (passive, canAct=false, sandbox estándar).
- Submit → `connectWonder()` (Parte 2.3). Validación client-side + el backend
  revalida.
- Nota de seguridad inline (mismo tono que CUSTOM_WONDERS.md): single-operator,
  el launch ejecuta argv en el host.

---

## Parte 5 — Auto-launch keyed off "conectado + habilitado" · [B4]

- `src/main.ts:624`: en vez de `ensureWondersUp(['bibliotheca','institutum'])`,
  derivar la lista de `listWonders()` filtrando los que tienen launch spec
  **y** `defaultEnabled !== false` (o flag `autoStart` del manifest). Respeta
  `isAutoStartWondersEnabled()` global (ya existe).
- Botón **"Levantar"** explícito en la tab de cada maravilla conectada (además
  del auto-start), llamando `launchWonder(id)` + progreso (la viñeta ya lo hace
  al abrir; exponerlo también en el tab).

---

## Parte 6 — Docs, config, tests

- **Docs:**
  - `docs/CUSTOM_WONDERS.md`: quitar la "limitación conocida §6" (ya no aplica:
    el frontend fetchea). Documentar el flujo UI de Conectar + el endpoint.
  - `docs/WONDER_CONTRACT.md` §5: actualizar (built-in vs ejemplo vs custom),
    nuevo endpoint connect, nota de que bibliotheca/institutum son ejemplos.
  - `docs/GETTING_STARTED.md`: sección "Conectar una Maravilla" reemplaza el
    asumido pre-install; enlazar repos públicos de los ejemplos.
- **Config:** `.env.example`: degradar VITE_WONDER_* a "solo si conectas el
  ejemplo correspondiente"; documentar `REPOCIV_WONDER_*_DIR`.
- **Tests:**
  - Python: `test_wonder_registry` (no built-ins por defecto), nuevo
    `test_connect_endpoint` (escribe/borra JSON, sanitiza id, rechaza remoto/
    sin token, recarga en caliente).
  - TS: `manifest.test.ts` (fetch + fallback + cache), `capitalPanel`/viñeta con
    set vacío y con custom, `wonderLauncher` connect/disconnect.
  - 3D: `WonderProps3D.test.ts` (geometría default) + goldens 0/1 maravilla.
  - `npm run check` + pytest verdes.

---

## Secuencia recomendada (fases pequeñas, verificables)

- **F1** — Frontend dinámico: `loadWonders()` fetch `/api/wonders` + cache +
  bootstrap await; capital panel/viñeta consumen el registry dinámico. (Parte 1)
- **F2** — Endpoint `connect`/`disconnect` + cliente TS + recarga en caliente. (2.3)
- **F3** — Democión a ejemplos: retirar built-ins del estático (TS+Py),
  `exampleTemplates.ts`, vista/guía de Maravillas con tarjetas + botón Conectar. (2.1,2.2,2.4)
- **F4** — Mapa dinámico `placeWonders()` + 3D genérico + labels + goldens. (Parte 3)
- **F5** — Auto-launch keyed off conectadas + botón "Levantar" en tab. (Parte 5)
- **F7** — Docs + config + tests + closure. (Parte 6)
- **F6 (segunda tanda, diferido)** — Formulario in-app "conectar servicio
  propio". (Parte 4) — confirmado fuera de esta tanda; la guía + tarjetas de
  ejemplo cubren el pedido 1 inicialmente.

## Riesgos / notas
- **Frame-ability**: confirmar que el servicio destino no manda
  `X-Frame-Options: DENY` / CSP `frame-ancestors` restrictivo (Vite dev no;
  nginx/prod podría). Documentar el requisito en la guía.
- **Seguridad de escritura**: el endpoint `connect` añade superficie (escribe
  manifests que el launcher ejecuta). Mitigar: loopback-only + token + rechazo
  remoto + sanitización de id + revalidación server-side del `launch` (mismo
  modelo que CUSTOM_WONDERS.md). Documentar en `SECURITY.md`.
- **Goldens 3D** GPU-sensibles: before/after mismo entorno.
- **Compat**: la democión cambia el comportamiento out-of-the-box (de "2 tiles
  que fallan" a "mapa limpio + guía"). El usuario re-conecta sus 2 locales una
  vez (un clic c/u) y recupera el flujo actual.

## Estado de implementación (2026-06-17)

**Implementado F1–F5 + F7.** Verificación: `npm run check` (tsc + 587 tests +
build ✓), `pytest server/` (849 passed/1 skipped), eslint + ruff limpios en los
archivos tocados.

- **F1** ✓ `src/wonders/manifest.ts`: `loadWonders()`/`ensureWondersLoaded()`/
  `invalidateWondersCache()`/`listIframeWonders()`; `WonderType` widened en
  `types.ts`; `main.ts` hace `await ensureWondersLoaded()` antes de world-gen.
- **F2** ✓ `POST /api/wonders/connect` + `POST /api/wonders/{id}/disconnect`
  (`wonder_ops.py`, `bridge.py`, `http_routes.py`); `wonder_registry.save_custom_manifest`/
  `delete_custom_manifest` (sanitiza id, expande `~`); `wonder_launcher.reload_custom_specs()`;
  cliente TS `connectWonder`/`disconnectWonder`.
- **F3** ✓ built-ins retiradas del estático (TS `manifest.ts` + Py
  `wonder_registry.py`); `src/wonders/exampleTemplates.ts` (repos públicos);
  pestaña **Maravillas** en `capitalPanel.ts` con guía + tarjetas conectar/
  desconectar/abrir + CSS en `panels.css`.
- **F4** ✓ `map.ts::assignWonderCoords` + colocación dinámica; `WonderProps3D.ts`
  monumento genérico + `setWonderVisible('generic')`; labels genéricos en
  `MapLabels3D.ts`; fallback de glifo 2D en `renderer.ts`.
- **F5** ✓ auto-start derivado de `listIframeWonders()` (no lista fija) +
  botón "Levantar"/"Desconectar" por pestaña + auto-start en la viñeta para
  genéricas.
- **F7** ✓ tests (frontend `manifest`/`wonderConfig`/`WonderProps3D`; backend
  `test_wonder_registry` reescrito + nuevo `test_wonder_ops`); docs
  (`WONDER_CONTRACT`, `CUSTOM_WONDERS`, `GETTING_STARTED`, `API.md`); `.env.example`.

**Follow-ups:**
- **F6** (formulario in-app genérico) — diferido por decisión.
- **Golden 3D `08-wonders-closeup.png`** quedó obsoleto: el mapa por defecto ya
  no trae maravillas. Recapturar en el box GPU del usuario tras conectar los dos
  ejemplos (no regenerado aquí: software-GL, GPU-sensible — práctica iter9). No
  es gate de CI (se captura con `scripts/screenshot-3d-audit.mjs`).
- `server/bridge.py` arrastra F401 preexistentes (imports `pending_tracker`),
  ajenos a este cambio.

## Decisiones (confirmadas 2026-06-17)
1. **Modelo de conexión**: ✅ Opción C — "Conectar" escribe
   `~/.repociv/wonders/<id>.json` vía endpoint; un solo code path para ejemplos
   y custom. Reconectar Biblioteca/LabHub = un clic c/u.
2. **Alcance**: ✅ Guía + ejemplos primero (F1–F5 + F7). El formulario genérico
   in-app (F6) se difiere a una segunda tanda.
3. **PENDIENTE — URLs públicas exactas** de los repos de ejemplo (La Gran
   Biblioteca y LabHub) para las tarjetas. Org parece `github.com/Grizaceo/…`;
   falta confirmar nombres (`labhub` vs `labhub-oss`). Único input bloqueante
   para F3 (tarjetas de ejemplo).
