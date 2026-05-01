# RepoCiv — Plan de lo que falta después de los arreglos

> **Para Hermes:** ejecutar este plan con subagents o TDD, una fase a la vez, sin mezclar refactors con cambios de producto.

**Objetivo:** llevar RepoCiv desde “ya funciona y ya no miente” a “consola permanente sólida”, cerrando la deuda estructural, la verificación visual real y la documentación de operación.

**Arquitectura:**
El repo ya tiene transporte SSE, smoke tests y una base funcional. Lo que falta no es otra feature grande; falta terminar de separar responsabilidades, probar el flujo real en navegador, y dejar el modo permanente/operativo sin ambigüedades. El plan prioriza: 1) extraer lo que todavía vive pegado en `server/bridge.py`, 2) probar el camino UI→bridge→eventos con navegador real, 3) limpiar referencias viejas y documentar el estado actual, y 4) cerrar la ruta de operación permanente (systemd, lockfiles, backup, recuperación).

**Tech stack:** Python 3.13, TypeScript, Vite, Vitest, pytest, Browser/Playwright opcional, bash scripts, systemd user services.

---

## Estado actual de referencia

Verificado al momento de escribir este plan:
- `python3 -m py_compile server/*.py` ✅
- `pytest server -q` ✅
- `npm run check` ✅
- `scripts/healthcheck.sh` ✅
- `scripts/smoke-test.sh` ✅
- UI en `http://localhost:5273` cargando ✅
- Bridge en `http://localhost:5274` respondiendo ✅

Cambios ya hechos que NO se deben repetir:
- SSE live en `/events`
- `server/agent_runner.py`, `server/quest.py`, `server/tech_debt.py`
- tests de bridge / integration / map
- eliminación de `src/renderer3d.ts` y `debug_rooms.ts`
- corrección del bug de `~/.repociv` literal en scripts

---

## Fase 1 — Terminar de adelgazar `server/bridge.py`

**Meta:** bajar `server/bridge.py` a una pieza de routing/orquestación clara, no a un vertedero de lógica.

**Criterio de salida:** `server/bridge.py` queda por debajo de ~550 líneas y sus responsabilidades quedan separadas en módulos pequeños con tests propios.

### Task 1.1: Extraer helpers de estado y observabilidad

**Objetivo:** mover funciones de estado/scan que no deberían vivir en el handler HTTP.

**Files:**
- Create: `server/bridge_observability.py`
- Modify: `server/bridge.py`
- Modify: `server/test_bridge_integration.py`

**Contenido esperado del módulo nuevo:**
- `get_gpu_info()`
- `load_pending_tasks()`
- `scan_active_processes()`
- `detect_lexo()`
- constantes de proceso/keywords

**Tests a añadir:**
- `server/test_bridge_observability.py`
- casos: GPU presente/ausente, pending tracker vacío, scanner de procesos no rompe, detección LexO emite evento

**Verificación:**
- `pytest server/test_bridge_observability.py -v`
- `pytest server -q`

---

### Task 1.2: Extraer el handler de recuperación/harness

**Objetivo:** mover el bloque de rutas de recuperación y harness fuera del handler principal.

**Files:**
- Create: `server/bridge_recovery.py`
- Modify: `server/bridge.py`
- Modify: `server/test_bridge_integration.py`

**Contenido esperado del módulo nuevo:**
- `build_recovery_plan` routing wrapper
- handler de `/harnesses/<id>/recovery-command`
- handlers de `/harnesses` si conviene agruparlos
- utilidades de respuesta 404 / JSON de recuperación

**Tests a añadir:**
- `server/test_bridge_recovery.py`
- casos: harness inexistente → 404, harness existente → plan válido, evento de auditoría emitido

**Verificación:**
- `pytest server/test_bridge_recovery.py -v`
- `pytest server -q`

---

### Task 1.3: Dejar `bridge.py` como router

**Objetivo:** consolidar `bridge.py` como capa de wiring, sin lógica de dominio innecesaria.

**Files:**
- Modify: `server/bridge.py`
- Modify: `server/__init__.py` si hiciera falta exportar nuevos módulos

**Checklist de salida:**
- `BridgeHandler` solo enruta
- `send_to_repociv()` y SSE permanecen con tests
- `run_agent()` sigue delegando a `server/agent_runner.py`
- `scan_tech_debt()` vive en `server/tech_debt.py`
- `generate_quest_name()` vive en `server/quest.py`

**Verificación:**
- `python3 -m py_compile server/*.py`
- `pytest server -q`
- `npm run check`

---

## Fase 2 — E2E visual real en navegador

**Meta:** que el flujo real de UI se valide con navegador automatizado, no solo con smoke HTTP.

**Criterio de salida:** un suite e2e reproduce el camino principal y falla cuando el UI o el bridge se rompen.

### Task 2.1: Elegir runner e instalarlo

**Objetivo:** fijar una herramienta de navegador real para RepoCiv.

**Files:**
- Modify: `package.json`
- Create: `playwright.config.ts` o `e2e/playwright.config.ts`
- Create: `e2e/repociv.spec.ts`

**Recomendación:** Playwright, porque el objetivo es navegador real, no DOM falso.

**Verificación:**
- `npx playwright install --with-deps` (si faltan binarios)
- `npx playwright test --list`

---

### Task 2.2: Probar la carga del mapa y el estado vivo

**Objetivo:** abrir RepoCiv y verificar que la pantalla inicial tiene contenido real.

**Files:**
- Create: `e2e/repociv.spec.ts`

**Casos mínimos:**
- el mapa carga con texto/elementos visibles
- el badge de bridge muestra online
- el HUD de recursos se ve
- el hero bar muestra al menos DAVI

**Verificación:**
- `npx playwright test e2e/repociv.spec.ts -g "carga inicial"`

---

### Task 2.3: Probar el flujo UI → bridge → evento

**Objetivo:** demostrar que un comando real viaja por el sistema y deja rastro visible.

**Files:**
- Create: `e2e/repociv.spec.ts`
- Modify: `src/bridge.ts` solo si hace falta exponer un hook de test

**Casos mínimos:**
- abrir panel de aprobación o timeline y ver datos reales
- disparar un comando de prueba y observar `mission_start` / `chat_chunk` / `mission_complete`
- verificar que un evento SSE entra y actualiza el UI

**Verificación:**
- `npx playwright test e2e/repociv.spec.ts -g "flujo bridge"`

---

### Task 2.4: Bloquear regresiones visuales básicas

**Objetivo:** convertir lo que hoy es smoke manual en una red mínima de seguridad.

**Casos mínimos:**
- repos visibles
- 2D/3D ya no existe como toggle roto
- panels no rompen el layout
- error de `/api/repos` se ve y no deja pantalla vacía

**Verificación:**
- `npx playwright test e2e/repociv.spec.ts`
- `npm run check`

---

## Fase 3 — Limpieza documental y coherencia interna

**Meta:** que el repo diga la verdad sobre sí mismo.

### Task 3.1: Actualizar docs que aún mencionan cosas eliminadas

**Files:**
- Modify: `README.md`
- Modify: `docs/PLAN_ARREGLOS.md`
- Modify: `docs/PERMANENT_AGENT_CONSOLE_PLAN.md` si sigue mencionando 3D/debug rooms
- Modify: `docs/PLAN_EJECUCION.md` si hay referencias viejas

**Cambios esperados:**
- quitar referencias a `renderer3d.ts`
- quitar referencias a `debug_rooms.ts`
- reflejar que SSE es el transporte live actual
- reflejar el bug/fix de `REPOCIV_CONFIG_DIR=~/.repociv`
- actualizar tamaños/estados de build y tests

**Verificación:**
- búsqueda de texto en el repo no debe devolver referencias muertas a 3D/debug rooms en docs principales

---

### Task 3.2: Crear un “estado actual” corto y canónico

**Objetivo:** un documento breve que diga qué está listo, qué falta, y qué no tocar.

**Files:**
- Create: `docs/STATE_AFTER_ARREGLOS.md`

**Contenido esperado:**
- qué está green hoy
- qué quedó fuera del alcance
- cómo levantar el sistema
- qué comandos usar para verificarlo

**Verificación:**
- `cat docs/STATE_AFTER_ARREGLOS.md` debe servir como handoff corto sin leer diez archivos

---

## Fase 4 — Consola permanente de verdad

**Meta:** cerrar la experiencia de operación continua, no solo la demo local.

### Task 4.1: Validar instalación systemd user end-to-end

**Files:**
- Modify: `deploy/systemd/repociv-bridge.service`
- Modify: `deploy/systemd/repociv-frontend.service`
- Modify: `deploy/systemd/repociv-backup.service`
- Modify: `deploy/systemd/repociv-backup.timer`
- Modify: `deploy/systemd/README.md`
- Modify: `scripts/healthcheck.sh`

**Objetivo:** que el modo permanente tenga una historia de arranque/paro inequívoca.

**Verificación:**
- `systemctl --user status repociv-bridge.service repociv-frontend.service`
- `bash scripts/healthcheck.sh`
- `bash scripts/smoke-test.sh`

---

### Task 4.2: Probar backup y recovery real

**Files:**
- Modify: `scripts/backup-events.sh`
- Modify: `deploy/systemd/repociv-backup.service`
- Modify: `deploy/systemd/repociv-backup.timer`
- Create: `server/test_backup_scripts.py` o equivalente si se decide testear scripts

**Objetivo:** respaldar `events.jsonl`, `missions.json`, `scheduler-queue.json`, `directive_records.jsonl`, `directive_templates.json` y rotar backups sin romper nada.

**Verificación:**
- backup manual genera archivo con timestamp UTC seguro
- rotación mantiene el número esperado de backups
- restauración manual es posible

---

### Task 4.3: Definir la UX de recuperación/TUI como respaldo, no competencia

**Files:**
- Modify: `src/ui/recoveryPanel.ts`
- Modify: `server/recovery.py`
- Modify: `src/main.ts` si falta algún atajo de acceso

**Objetivo:** que la ruta de recuperación sea explícita y no se sienta como una salida de emergencia improvisada.

**Verificación:**
- panel o acción de recuperación disponible
- mensaje claro de estado
- no se ejecutan acciones destructivas sin aprobación

---

## Fuera de alcance explícito

No tocar en esta ronda:
- reescritura del juego 2D
- multiplayer
- añadir otra UI experimental
- volver a introducir Three.js
- reabrir el rediseño del grafo legal o del workspace scan

---

## Definición de “terminado” para esta ola

RepoCiv queda en buena forma cuando:
- `bridge.py` deja de ser un monolito de dominio
- hay e2e real de navegador
- los docs no mienten
- la operación permanente se puede reproducir y verificar
- health/smoke/build/test siguen verdes después de cada cambio

**Nota objetivo:** 9/10 en consola permanente, 8.5/10 en producto general.
