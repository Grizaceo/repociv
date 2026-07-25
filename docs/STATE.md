# RepoCiv — STATE (empieza por aquí)

> **Punto de entrada para retomar el repo en frío.** Documento vivo, corto a
> propósito. Si algo aquí contradice al código, gana el código — y hay que
> actualizar este archivo. Última actualización: **2026-07-24**.

---

## 1. Realidad de la rama (lo primero que hay que saber)

- **Rama activa:** `feat/parent-folder-map-autolayout`
- **Base:** `main` (`1088dfa`)
- **Estado:** la rama está **~52 commits adelante de `main` local** y es
  **fast-forward-mergeable** (sin conflictos — `main` es ancestro directo de HEAD).
  `origin/main` (`bc8eebe`) está aún más atrás. **Ambos `main` están stale
  respecto a esta rama; todo el trabajo vive aquí, sin mergear.**
- **Qué carga esta rama:** la *Total Rehabilitation* completa + el feature
  *parent-folder map* + esta auditoría (2026-07-24).
- **Para aterrizar en main** (cuando se decida):
  ```bash
  git checkout main
  git merge --ff-only feat/parent-folder-map-autolayout
  # git push   # confirmar el remoto previsto antes de publicar
  ```
  No hay decisión registrada de si se mergea ya o se sigue trabajando en la
  rama; decidir eso es el primer paso al retomar.

---

## 2. Estado del gate (`scripts/check.sh`) — VERDE

`scripts/check.sh` es la única fuente de verdad de "¿build verde?". Tras la
auditoría del 2026-07-24 **pasa completo** (frontend + backend + assets +
bundle + seguridad). Lo que se arregló en esta auditoría para dejarlo verde:

- **npm audit (era el único gate rojo):** `valibot 1.3.1→1.4.2`,
  `postcss→8.5.23`, `brace-expansion→5.0.8` (overrides). Ahora `0 vulnerabilities`.
- **pip-audit ahora es hermético:** auditaba el **env global de miniconda**
  (96 vulns ajenas); ahora audita `requirements.lock` con
  `pip-audit -r requirements.lock --no-deps`. Además el lock tenía 11 advisories
  reales de 2026-07 → se bumpearon `mcp→1.28.1` (+ closure: `starlette 1.3.1`,
  `python-multipart 0.0.32`, `pydantic-settings 2.14.2`, `cryptography 49.0.0`).
  Verificado en venv limpio: **837 passed, 1 skipped**, 0 advisories.
- El `requirements.lock` estaba desincronizado con `requirements.txt` (le
  faltaba el árbol de pip-audit; sobraba `pytest-asyncio`, que ningún test usa).
  Se regeneró con `pip-compile` — ahora es honesto.

> ⚠️ **Ojo con el entorno:** `python` en PATH resuelve al **miniconda global**,
> no al `.venv` del repo (que puede estar incompleto). El gate `pytest`/`ruff`
> corre contra el global; `pip-audit` ya es independiente del intérprete. Para
> un entorno limpio: `python3 -m venv .venv && . .venv/bin/activate &&
> pip install -r requirements.txt`.

Correr el gate:
```bash
bash scripts/check.sh          # todo (tsc, eslint, prettier, vitest+cov, build,
                               # ruff, pytest+cov, budgets, seguridad)
```

---

## 3. Qué shipeó (contexto de producto)

- **Total Rehabilitation** — lifecycle canónico `execute_agent`, fronteras de
  seguridad (token/Origin, membresía de repo seleccionado, contención
  realpath/symlink, riesgo server-owned con piso de aprobación), Event Store v1,
  transporte WS autenticado. Registro: `execplan/REPOCIV_TOTAL_REHABILITATION.md`.
- **Parent-folder map** — inspeccionar una carpeta previsualiza su parent + hijos
  elegibles; aplicar persiste una selección exclusiva atómica (save-before-swap)
  y reusa el auto-layout hex existente. Registro:
  `docs/audits/2026-07-16-3d-visual-and-parent-folder-map.md`. Endpoints nuevos
  (plugin Vite): `POST /api/repo/inspect`, `POST /api/map-from-parent` — ya
  documentados en `docs/API.md` §"Local endpoints (Vite plugin)".
- **Auditoría 2026-07-24** (esta) — `docs/audits/2026-07-24-total-audit.md`.

---

## 4. Cómo correr / testear

```bash
# Frontend
npm install
npm run dev                    # Vite en 127.0.0.1:5273 (loopback por default)

# Backend (bridge Python)
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m server.bridge        # bridge HTTP/WS en localhost:5274

# Todo junto
npm start                      # scripts/dev-start.sh (bridge + frontend)
bash scripts/check.sh          # gate completo
npx playwright test            # E2E (requiere GPU para el modo WebGL)
```

Config: copiar `.env.example → .env`. Variable clave: `REPOCIV_MAP_ROOT`
(carpeta de repos). Para clientes no-browser (MCP/CLI/remoto) hace falta
`REPOCIV_TOKEN` de 32+ chars.

---

## 5. Versión y scope (verdad canónica)

- **Versión de release:** `v0.1.0-alpha` (fuente: `package.json`).
- **"v2.0"** = nombre del **hito interno de scope/arquitectura** ("Agent OS
  Industrial"), **no** la versión de release.
- **Autoridad de scope:** `docs/SCOPE.md`. `docs/ROADMAP.md` es un snapshot
  histórico de May-2026 (algunos ítems ya shipearon, p. ej. el render 3D).

---

## 6. Issues conocidos diferidos (no bloquean el gate)

- **✅ Resuelto (2026-07-25):** el callback async de "agregar ciudad"
  (`src/main.ts`) ahora maneja errores inline y degrada con datos locales — sin
  unhandledrejection ni ciudad perdida.
- **✅ Resuelto (2026-07-25):** P1.1 fit de cámara — `focusOnWorldBounds` ahora
  ajusta el zoom a los bounds de las ciudades (`computeFitZoom`, testeado) para
  no clipar las periféricas. **A QA:** seleccionar ≥2 repos y confirmar que
  todas las ciudades entran en el viewport sin clip; si el margen se siente muy
  suelto/apretado, tunear `marginFrac` (0.75) en `renderer.ts:focusOnWorldBounds`.
- **Deuda visual 3D restante (P1/P2, del audit 2026-07-16)** — trabajo estético
  iterativo, ideal para el loop de QA con Blender:
  - P1.2 oclusión de HUD (los paneles tapan mucho mapa);
  - P1.3 jerarquía de silueta de ciudad débil a media/corta distancia;
  - P2 grosor de listones de territorio, patrón "grid" de la textura de terreno,
    solape de labels, separación de verdes de bioma, labels Bibliotheca/LabHub
    despegadas, legibilidad de detalles de ciudad en zoom cercano.
- **cursor-agent:** flags/formato de stream sin verificar contra una instalación
  real (`server/agent_runner.py`). Caveats documentados, no bugs activos.
- **knip:** report-only; sus ~174 "unused exports" son ruido de
  redundant-export/test-seam/dynamic-dispatch, **no** dead code. No borrar a ciegas.
- **Archivos de status locales** (`TODOS.md`, `WORKER_FIX_PLAN.md`,
  `REFACTOR_PLAN.md`, `CODEX_HARNESS_INTEGRATION.md`, `README_PUBLICO.md`) están
  **gitignored/untracked** — son notas locales del owner, no están en un clon
  fresco. Históricos/cerrados.

---

## 7. Mapa de documentación (quién manda en qué)

| Tema | Fuente autoritativa |
|------|--------------------|
| Empezar aquí / estado actual | **este `docs/STATE.md`** |
| Scope (qué entra / qué no) | `docs/SCOPE.md` |
| Plan de rehabilitación (lo que shipeó) | `execplan/REPOCIV_TOTAL_REHABILITATION.md` |
| Índice del plan de implementación | `docs/implementation_plan.md` |
| API del bridge + endpoints locales | `docs/API.md` |
| MCP (38 tools) | `docs/MCP.md` |
| Setup paso a paso | `docs/GETTING_STARTED.md` |
| Auditorías (features/visual/gate) | `docs/audits/` |
| Roadmap (histórico May-2026) | `docs/ROADMAP.md` (⚠️ ver SCOPE.md) |
