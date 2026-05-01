# Plan de Arreglos — RepoCiv

**Fecha:** 2026-04-30  
**Diagnóstico base:** 6.5/10 — buenos fundamentos, problemas estructurales reales  
**Principio rector:** conectar lo que existe antes de construir más

---

## Contexto del diagnóstico

El repo tiene código TypeScript bien escrito, tests sólidos para matemática pura (hex, A\*, scoring), y separación de responsabilidades razonable. Los problemas no son de calidad de código sino de **estructura y completitud**:

1. El transporte de eventos usa Vite HMR — funciona solo en dev
2. `bridge.py` (1,239 líneas) hace demasiado en un solo archivo
3. Los tests cubren el math pero no el pipeline completo
4. Tres features existen pero no están conectadas al flujo real
5. La propuesta de valor al usuario no es evidente

Este plan ataca esos cinco problemas en orden de impacto.

---

## Fase 1 — Transporte de producción (bloqueante)

**Problema central:** `src/bridge.ts:30` usa `import.meta.hot.on('bridge:event', ...)`. En `vite build` esto es `undefined`. El app entero queda mudo en producción.

**Solución:** SSE (Server-Sent Events) como canal principal, HMR de Vite como canal secundario solo en dev.

### 1.1 Añadir endpoint SSE en `server/bridge.py`

Buscar la función que maneja las rutas HTTP y añadir:

```python
# Nuevo endpoint: GET /events
# Mantiene la conexión abierta y envía eventos en formato SSE
# data: {json}\n\n
```

El endpoint debe:
- Aceptar `GET /events` con header `Accept: text/event-stream`
- Mantener un registro de clientes conectados (lista de `queue.Queue` por conexión)
- Cuando `send_to_repociv(event)` sea llamado internamente, además de Vite HMR, encolar el evento en todos los clientes SSE activos
- Enviar heartbeat `data: {"type":"ping"}\n\n` cada 15 segundos para mantener la conexión viva
- Limpiar el cliente de la lista cuando la conexión se cierre

**Archivo:** `server/bridge.py`  
**Cambio en:** función `send_to_repociv()` — añadir fan-out a clientes SSE  
**Cambio nuevo:** handler de ruta `GET /events`

### 1.2 Actualizar `src/bridge.ts` para usar SSE en producción

Estrategia dual: SSE siempre, HMR como complemento en dev.

```typescript
// En BridgeEvents.start():

// Canal SSE (funciona en dev Y producción)
this._connectSSE();

// Canal HMR solo en dev (más rápido, sin polling)
if (import.meta.hot) {
  import.meta.hot.on('bridge:event', (data: unknown) => {
    // solo procesar si SSE no está activo para evitar duplicados
    if (!this._sseConnected) this._handleRaw(data);
  });
}
```

```typescript
private _connectSSE() {
  const url = `${BRIDGE_URL}/events`;
  const src = new EventSource(url);  // native browser API, no deps
  src.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'ping') return;
    this._handleRaw(data);
  };
  src.onerror = () => {
    this._sseConnected = false;
    src.close();
    // reconectar con backoff existente
    setTimeout(() => this._connectSSE(), this.reconnectDelay);
  };
  src.onopen = () => { this._sseConnected = true; };
}
```

**Archivo:** `src/bridge.ts`  
**Tests a añadir:** mock de EventSource en `src/bridge.test.ts` (crear el archivo)

### 1.3 Verificación

```bash
npm run build          # debe compilar sin errores
# Abrir dist/index.html en browser sin Vite dev server
# Verificar que los eventos del bridge llegan igual que en dev
```

---

## Fase 2 — Partir bridge.py

**Problema:** 1,239 líneas en un archivo hace que sea imposible razonar sobre qué hace cada parte, y los tests de Python tienen que importar todo para probar cualquier cosa.

**Regla:** cada módulo nuevo debe tener sus propios tests.

### 2.1 Extraer `server/agent_runner.py`

Mover de `bridge.py`:
- `run_agent()` (línea ~490)
- `_execute_streaming()` (~534)
- `_run_openclaw_streaming()` (~567)
- `_run_hermes_streaming()` (~595)
- `_resolve_city_path()` (~479)
- `_find_openclaw()` (~565)
- `_has_openclaw()` (~560)
- `_get_agent_config()` (~471)
- `AGENT_CONFIGS` dict (~440)

`bridge.py` llama a `agent_runner.run_agent(...)` en vez de definirlo.

**Tests:** `server/test_agent_runner.py` — mockear subprocess, verificar que hermes → openclaw fallback emite el evento correcto.

### 2.2 Extraer `server/tech_debt.py`

Mover de `bridge.py`:
- `scan_tech_debt()` (~293)
- `_assess_debt_severity()` (~340)
- `_TD_PATTERNS`, `_TD_EXTENSIONS`, `_TD_CACHE`, `_TD_CACHE_TTL`

Ya existe `server/metrics.py`. `tech_debt.py` es su hermano de observabilidad.

**Tests:** `server/test_tech_debt.py` — crear árbol de archivos en tempdir, verificar que detecta TODO/HACK/FIXME y respeta el TTL del caché.

### 2.3 Extraer `server/quest.py`

Mover de `bridge.py`:
- `generate_quest_name()` (~262)
- Cualquier lógica de nombres/misiones que no sea routing

### 2.4 Resultado esperado de bridge.py

Después de las extracciones, `bridge.py` debe quedar en ~400-500 líneas haciendo solo:
- Setup del servidor HTTP
- Routing de endpoints (dispatch a los módulos)
- `send_to_repociv()` + fan-out SSE
- Auth / rate limiting

---

## Fase 3 — Tests de integración

**Problema:** el pipeline `evento bridge → game state → render` no tiene ni un solo test. Si algo se rompe en esa cadena, no hay red de seguridad.

### 3.1 `src/bridge.integration.test.ts`

Tests usando `vitest` con mocks de DOM:

```typescript
describe('BridgeEvents → GameState', () => {
  it('unit_spawn crea unidad en world', () => {
    const state = new GameState(emptyWorld());
    const bridge = new BridgeEvents(state);
    bridge.handleBridgeEvent({ type: 'unit_spawn', unit: 'DAVI', civ: 'gris', hex: [0, 0] });
    expect(state.getUnit('DAVI')).toBeDefined();
  });

  it('unit_move inicia pathfinding', () => { ... });
  it('building_complete marca edificio como completo', () => { ... });
  it('mission_complete cierra misión', () => { ... });
  it('resource_update actualiza DOM element', () => { ... });
  it('chat_chunk acumula texto', () => { ... });
  it('evento inválido es descartado silenciosamente', () => { ... });
});
```

**Archivo:** `src/bridge.integration.test.ts`  
**Mínimo:** 8 tests cubriendo los casos del switch en `handleBridgeEvent()`

### 3.2 `server/test_bridge_integration.py`

Tests de extremo a extremo para el servidor HTTP:

```python
# Levantar bridge en un puerto temporal
# POST /commands con payload válido → verificar respuesta y evento emitido
# GET /health → verificar estructura de respuesta
# GET /events → verificar que llegan eventos SSE (requiere threading)
# GET /techdebt → verificar caché (segunda llamada debe ser más rápida)
```

**Nota:** estos tests pueden ser lentos — marcarlos con `@pytest.mark.integration` y excluirlos del run rápido con `pytest -m "not integration"`.

### 3.3 Objetivo

Después de Fase 3: cualquier cambio en el pipeline de eventos rompe un test antes de llegar a producción.

---

## Fase 4 — Cerrar o eliminar features incompletas

**Principio:** un feature que existe pero no funciona es peor que uno que no existe — genera confianza falsa y complejidad de mantenimiento.

### 4.1 Renderer 3D (`src/renderer3d.ts`) — decidir y ejecutar

**Opción A — Eliminar:**
```bash
rm src/renderer3d.ts
# Verificar que nadie lo importa: grep -r "renderer3d" src/
# Si hay imports, eliminarlos también
# Beneficio: -515KB del bundle (Three.js)
```

**Opción B — Completar (solo si se planea usar):**
- Definir qué muestra la vista 3D que no muestra la 2D
- Conectar al toggle de teclado existente (tecla `3` en `src/ui/keyboard.ts`)
- Mínimo: el mapa hex renderiza en 3D con cámaras orbit

**Recomendación: Opción A.** El Civ V 2D ya comunica todo lo necesario y Three.js infla el bundle sin retorno de valor visible hoy.

### 4.2 Panels huérfanos — auditar y conectar

Para cada uno de estos panels, verificar si están conectados al flujo real o solo se renderizan:

| Panel | Archivo | ¿Integrado? | Acción |
|-------|---------|-------------|--------|
| Timeline | `src/ui/timelinePanel.ts` | verificar | Conectar a eventos de `bridge.ts` o eliminar |
| Replay | `src/ui/replayPanel.ts` | verificar | Conectar a `event_store.py GET /events/history` o eliminar |
| Approval | `src/ui/approvalPanel.ts` | verificar | Conectar al workflow de comandos `medium/high` risk o eliminar |

**Proceso para cada uno:**
1. `grep -r "timelinePanel\|replayPanel\|approvalPanel" src/main.ts src/bridge.ts` — si no aparece, el panel es huérfano
2. Si huérfano: eliminar el archivo y su export en `src/ui/index.ts`
3. Si conectado pero roto: añadir test que lo verifique

### 4.3 `debug_rooms.ts` en raíz

```bash
# Verificar si alguien lo importa
grep -r "debug_rooms" src/
# Si no: rm debug_rooms.ts
```

---

## Fase 5 — Propuesta de valor visible

**Problema:** después de ver el repo completo, no es obvio qué valor concreto recibe el usuario al abrir RepoCiv vs abrir VS Code.

Esto no es un problema de código — es un problema de producto. Pero hay cambios técnicos que lo hacen más evidente.

### 5.1 Pantalla de inicio con valor inmediato

Al cargar, el usuario debe ver en 5 segundos:
- El mapa hex de sus repos con **datos reales** (no mock)
- Al menos una métrica visible por repo (commits hoy, archivos modificados, tests failing)
- Un agente ya posicionado (no "spawna manualmente")

**Cambios técnicos:**
- `src/map.ts`: si `/api/repos` falla, mostrar error explícito en lugar de mundo vacío silencioso
- `src/main.ts`: spawn automático de DAVI en el primer repo detectado (no esperar evento de bridge)
- `src/ui/hud.ts`: mostrar un número real en cada recurso al arrancar

### 5.2 Un flujo completo que funcione sin configuración

El flujo "dorado" que debe funcionar sin tocar nada:

```
1. npm run dev
2. Mapa carga con repos reales de ~/.hermes/workspace/repos/
3. Click en un repo → entrar a local view (RimWorld)
4. DAVI camina automáticamente al archivo más prioritario
5. El panel de chat muestra actividad (real o demo)
```

Identificar dónde se rompe este flujo hoy y arreglarlo. Cada paso que requiere configuración manual o falla silenciosamente es una pérdida de valor.

---

## Resumen ejecutivo

| Fase | Impacto | Esfuerzo | Archivos principales |
|------|---------|----------|---------------------|
| 1 — SSE transport | 🔴 Bloqueante para prod | Medio | `bridge.py`, `src/bridge.ts` |
| 2 — Partir bridge.py | 🟠 Mantenibilidad | Medio | `bridge.py` → 3 módulos nuevos |
| 3 — Tests integración | 🟠 Confianza en cambios | Medio | 2 archivos de test nuevos |
| 4 — Cerrar features | 🟡 Claridad + bundle size | Bajo | `renderer3d.ts`, panels huérfanos |
| 5 — Valor visible | 🟡 Producto | Bajo-Medio | `map.ts`, `main.ts`, `hud.ts` |

**Orden recomendado:** 1 → 4 → 3 → 2 → 5

La Fase 4 va antes de 3 porque no tiene sentido escribir tests de integración para features que vamos a eliminar.

---

## Lo que este plan NO incluye

- Reescribir lo que funciona (hex math, A\*, priority scoring, fatigue system — todo eso está bien)
- Añadir features nuevas (Frostpunk, multi-player, etc.)
- Cambiar la UI visual (el estilo Civ V es una decisión de producto, no un bug)
- Migrar a un framework de UI (la arquitectura vanilla TS funciona para este scope)

El objetivo es llegar a **8/10**: mismo código, transporte que funciona en producción, tests que cubren el pipeline, y features que o funcionan o no están.
