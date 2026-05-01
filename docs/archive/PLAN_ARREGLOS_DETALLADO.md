# Plan Detallado de Arreglos — RepoCiv

**Fecha:** 2026-04-30  
**Estado actual:** 191 tests TS ✅ | 193 tests Python ✅  
**Metodología:** Inspección manual de código, no audit doc stale

> Cada arreglo incluye: archivo exacto, línea(s) afectadas, cambio preciso, y test de verificación.

---

## Audit de Estado Real (Antes de Arreglar)

### ✅ Audit items YA resueltos (NO tocar)

| Item | Estado | Evidencia |
|---|---|---|
| `tileKey()` duplicada | RESUELTO | Todos los archivos importan desde `types.ts` |
| `UNIT_TYPE_COLOR` vs `UNIT_COLORS` | RESUELTO | Solo existe `UNIT_COLORS` en codebase |
| `HEX_SIZE_LOCAL` unused | RESUELTO | No existe en `renderer.ts` |
| `updateUnits` ignora `_dt` | RESUELTO | Usa `scale = dt / TICK_MS` desde línea 97 |
| Demo mode retorna success fake | RESUELTO | `startDemo()` solo loguea pulsos, no emite game events |
| Validación valibot en `bridge.ts` | RESUELTO | `parseBridgeEvent()` llamado antes de `handleBridgeEvent()` |
| Config hardcodeada sin `.env` | RESUELTO | `_load_dotenv()` en Python, `import.meta.env` en TS |
| Tests = 0 | RESUELTO | 191 TS + 193 Python pasando |

---

## Bugs Confirmados (código revisado hoy)

### BUG-01 — PENDING_TRACKER parser estrecho

**Archivo:** `server/bridge.py`  
**Línea:** 334  
**Severidad:** MEDIO — causa que tareas marcadas con `*` o `+` no aparezcan en el UI

**Código actual:**
```python
m = re.match(r"^\s*-\s*\[\s*\]\s*(.+)", line)
```

**Problema:** Solo detecta listas con bullet `-`. El formato Markdown estándar también permite `*` y `+`. Tampoco detecta tareas completadas `[x]` para filtrarlas.

**Fix:**
```python
# Detecta - [ ], * [ ], + [ ] y descarta - [x], * [x], + [x] (completadas)
m = re.match(r"^\s*[-*+]\s*\[\s*\]\s*(.+)", line)
```

**Test de verificación:**
```python
# Añadir a server/test_bridge_integration.py o nuevo test_pending_parser.py
def test_load_pending_tasks_supports_all_bullet_styles(tmp_path, monkeypatch):
    tracker = tmp_path / "PENDING_TRACKER.md"
    tracker.write_text("- [ ] dash task\n* [ ] asterisk task\n+ [ ] plus task\n- [x] done task\n")
    monkeypatch.setattr(bridge, "PENDING_TRACKER", tracker)
    tasks = bridge.load_pending_tasks()
    titles = [t["title"] for t in tasks]
    assert "dash task" in titles
    assert "asterisk task" in titles
    assert "plus task" in titles
    assert "done task" not in titles  # completadas no deben aparecer
    assert len(tasks) == 3
```

---

### BUG-02 — `_lexo_counter` no persiste entre reinicios

**Archivo:** `server/bridge.py`  
**Líneas:** 387–411  
**Severidad:** MEDIO — al reiniciar bridge, un nuevo proceso LEXO obtiene `LEXO-1` de nuevo, colisionando con cualquier sesión frontend que ya tenga `LEXO-1` mapeado

**Código actual:**
```python
_lexo_spawned: set[str] = set()
_lexo_counter = 0

def detect_lexo() -> None:
    global _lexo_counter
    ...
    _lexo_counter += 1
    unit_id = f"LEXO-{_lexo_counter}"
    send_to_repociv({"type": "unit_spawn", "unit": unit_id, ...
                     "hex": [2, _lexo_counter], ...})
```

**Problema:** 
1. `_lexo_counter` resetea a 0 en cada restart → IDs no únicos entre sesiones.
2. El hex `[2, _lexo_counter]` produce colisiones visuales cuando hay múltiples LEXOs (todos en columna q=2).
3. `_lexo_spawned` también resetea → la guardia de "ya visto este PID" no sobrevive restart.

**Fix:**
```python
# Usar UUID corto (primeros 8 chars) en lugar de contador secuencial
# El PID ya garantiza unicidad dentro de una sesión de bridge

_lexo_spawned: set[str] = set()  # sigue siendo in-memory (guard dentro de sesión)

def detect_lexo() -> None:
    # ELIMINAR: global _lexo_counter
    try:
        result = subprocess.run(["ps", "aux"], capture_output=True, text=True, timeout=5)
        for line in result.stdout.strip().splitlines()[1:]:
            parts = line.split(None, 10)
            if len(parts) < 11:
                continue
            try:
                pid = int(parts[1])
            except ValueError:
                continue
            cmd = parts[10].lower()
            if re.search(r"lexo|hermes.*lexo|lexo.*hermes", cmd):
                pid_key = str(pid)
                if pid_key not in _lexo_spawned:
                    _lexo_spawned.add(pid_key)
                    # UUID corto: estable dentro de la sesión, único entre sesiones
                    unit_id = f"LEXO-{uuid.uuid4().hex[:8]}"
                    # Hex: distribuir en q=2..4 usando hash del pid para evitar colisiones
                    hex_q = 2 + (pid % 3)
                    hex_r = pid % 5
                    send_to_repociv({"type": "unit_spawn", "unit": unit_id, "civ": "gris",
                                     "hex": [hex_q, hex_r], "unitType": "lexo",
                                     "mission": f"Proceso: {parts[10][:40]}"})
                    send_to_repociv({"type": "log", "msg": f"LexO-α detectado (pid {pid})", "level": "success"})
    except Exception:
        pass
```

**Eliminar de `bridge.py`:**
- Línea 388: `_lexo_counter = 0`
- Línea 392: `global _lexo_counter`
- Línea 408: `_lexo_counter += 1`
- Línea 409: `unit_id = f"LEXO-{_lexo_counter}"` → reemplazar por UUID
- Línea 411: `"hex": [2, _lexo_counter]` → reemplazar por hash del PID

**Test de verificación:**
```python
def test_detect_lexo_generates_unique_ids(monkeypatch):
    import re as _re
    sent_events = []
    monkeypatch.setattr(bridge, "send_to_repociv", lambda e: sent_events.append(e))
    
    # Simular ps aux con dos procesos lexo distintos
    fake_ps = "USER PID ... CMD\nuser 1001 ... hermes lexo runner\nuser 1002 ... lexo agent\n"
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: type("R", (), {"stdout": fake_ps, "returncode": 0})())
    
    bridge._lexo_spawned.clear()
    bridge.detect_lexo()
    
    spawn_events = [e for e in sent_events if e.get("type") == "unit_spawn"]
    ids = [e["unit"] for e in spawn_events]
    
    assert len(ids) == 2
    assert ids[0] != ids[1]  # IDs únicos
    assert all(_re.match(r"^LEXO-[0-9a-f]{8}$", uid) for uid in ids)  # formato UUID corto
```

---

### BUG-03 — `.env.example` contiene token parcial real

**Archivo:** `.env.example`  
**Línea:** 4  
**Severidad:** SEGURIDAD — el valor `REPOCIV_TOKEN=REPOCI...ociv` parece un token real parcialmente redactado, no un placeholder claro

**Código actual:**
```
REPOCIV_TOKEN=REPOCI...ociv
```

**Fix:**
```
# Dejar vacío = auth bypass (solo dev local). En producción usar token de 32+ chars.
# Generar con: python3 -c "import secrets; print(secrets.token_hex(32))"
REPOCIV_TOKEN=
```

---

## Mejoras de Robustez (no bugs, pero gaps importantes)

### MEJORA-01 — `load_pending_tasks` no filtra tareas completadas

**Archivo:** `server/bridge.py`  
**Línea:** 334  
**Contexto:** La función ya recibe el fix del BUG-01. Adicionalmente, debería marcar si una tarea tiene prioridad inline (ej: `[HIGH]`, `!` al inicio).

**Fix adicional sobre BUG-01:**
```python
def load_pending_tasks() -> list[dict[str, str]]:
    if not PENDING_TRACKER.exists():
        return []
    try:
        tasks = []
        for line in PENDING_TRACKER.read_text(encoding="utf-8").splitlines():
            # Soporte: - [ ], * [ ], + [ ]  (sin tareas completadas [x])
            m = re.match(r"^\s*[-*+]\s*\[\s*\]\s*(.+)", line)
            if m:
                title = m.group(1).strip()
                priority = "high" if title.startswith("!") or "[HIGH]" in title else "normal"
                tasks.append({"title": title.lstrip("!").strip(), "priority": priority})
        return tasks
    except Exception:
        return []
```

---

### MEJORA-02 — `bridge.test.ts` cubre solo 2 casos

**Archivo:** `src/bridge.test.ts`  
**Estado actual:** 2 tests (SSE connect + reconnect con backoff)  
**Gap:** Sin cobertura de: health check, GPU fetch, approval flow, command send, demo mode trigger

**Tests a añadir:**

```typescript
// En src/bridge.test.ts — añadir después de los tests existentes

describe('checkHealth', () => {
  it('llama setBridgeStatus(true) cuando /health responde ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, openclaw: false }) });
    vi.stubGlobal('fetch', fetchMock);
    const bridge = new BridgeEvents(makeState() as unknown as GameState);
    const setBridgeStatusSpy = vi.spyOn(uiModule, 'setBridgeStatus');
    await (bridge as unknown as { checkHealth: () => Promise<void> }).checkHealth();
    expect(setBridgeStatusSpy).toHaveBeenCalledWith(true, 'hermes');
    vi.unstubAllGlobals();
  });

  it('llama setBridgeStatus(false) cuando /health falla', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const bridge = new BridgeEvents(makeState() as unknown as GameState);
    const setBridgeStatusSpy = vi.spyOn(uiModule, 'setBridgeStatus');
    await (bridge as unknown as { checkHealth: () => Promise<void> }).checkHealth();
    expect(setBridgeStatusSpy).toHaveBeenCalledWith(false);
    vi.unstubAllGlobals();
  });
});

describe('handleBridgeEvent — unit_spawn', () => {
  it('añade la unidad al estado del juego', () => {
    const state = makeState();
    const bridge = new BridgeEvents(state as unknown as GameState);
    const evt = parseBridgeEvent({
      type: 'unit_spawn', unit: 'WORKER-1', civ: 'gris', hex: [1, 2],
    });
    expect(evt).not.toBeNull();
    bridge.handleBridgeEvent(evt!);
    expect(state.spawned).toContain('WORKER-1');
  });
});

describe('demo mode', () => {
  it('no emite eventos de juego cuando bridge está offline', () => {
    vi.useFakeTimers();
    const state = makeState();
    const bridge = new BridgeEvents(state as unknown as GameState);
    // Forzar modo offline → demo
    for (let i = 0; i < 15; i++) {
      (bridge as unknown as { onBridgeOffline: () => void }).onBridgeOffline();
    }
    vi.advanceTimersByTime(35_000);
    // Juego no debe tener unidades spawneadas por el demo
    expect(state.spawned).toHaveLength(0);
    vi.useRealTimers();
  });
});
```

---

### MEJORA-03 — Falta `test_pending_parser.py` dedicado

**Archivo nuevo:** `server/test_pending_parser.py`

```python
"""Tests dedicados al parser de PENDING_TRACKER.md."""
import pytest
from unittest.mock import patch
from pathlib import Path
from server import bridge


def _make_tracker(tmp_path: Path, content: str) -> Path:
    p = tmp_path / "PENDING_TRACKER.md"
    p.write_text(content, encoding="utf-8")
    return p


def test_dash_bullet(tmp_path):
    p = _make_tracker(tmp_path, "- [ ] tarea uno\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert tasks == [{"title": "tarea uno", "priority": "normal"}]


def test_asterisk_bullet(tmp_path):
    p = _make_tracker(tmp_path, "* [ ] tarea dos\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert len(tasks) == 1
    assert tasks[0]["title"] == "tarea dos"


def test_plus_bullet(tmp_path):
    p = _make_tracker(tmp_path, "+ [ ] tarea tres\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert len(tasks) == 1


def test_completed_task_excluded(tmp_path):
    p = _make_tracker(tmp_path, "- [x] ya hecho\n- [ ] pendiente\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    titles = [t["title"] for t in tasks]
    assert "pendiente" in titles
    assert "ya hecho" not in titles


def test_uppercase_X_excluded(tmp_path):
    p = _make_tracker(tmp_path, "- [X] también hecho\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert len(tasks) == 0


def test_high_priority_marker(tmp_path):
    p = _make_tracker(tmp_path, "- [ ] ! urgente ahora\n- [ ] normal\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    priorities = {t["title"]: t["priority"] for t in tasks}
    assert priorities.get("urgente ahora") == "high"
    assert priorities.get("normal") == "normal"


def test_high_bracket_priority(tmp_path):
    p = _make_tracker(tmp_path, "- [ ] [HIGH] revisar auth\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert tasks[0]["priority"] == "high"


def test_missing_file_returns_empty(tmp_path):
    with patch.object(bridge, "PENDING_TRACKER", tmp_path / "no_existe.md"):
        tasks = bridge.load_pending_tasks()
    assert tasks == []


def test_empty_file_returns_empty(tmp_path):
    p = _make_tracker(tmp_path, "")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert tasks == []


def test_mixed_bullets_all_detected(tmp_path):
    content = "- [ ] uno\n* [ ] dos\n+ [ ] tres\n- [x] skip\n# Header\nsome text\n"
    p = _make_tracker(tmp_path, content)
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert len(tasks) == 3
```

---

### MEJORA-04 — `_lexo_spawned` debería ser persistido en disco entre sesiones

**Archivo:** `server/bridge.py`  
**Contexto:** Aunque el BUG-02 se arregla usando UUID, sería ideal persistir `_lexo_spawned` para no re-spawner el mismo PID si el bridge se reinicia rápidamente mientras el proceso sigue vivo.

**Archivo de persistencia:** `CONFIG_DIR / "lexo-spawned.json"`

```python
# En bridge.py — después de la línea donde se define CONFIG_DIR

_LEXO_SPAWNED_FILE = CONFIG_DIR / "lexo-spawned.json"

def _load_lexo_spawned() -> set[str]:
    """Cargar PIDs vistos en sesiones anteriores para evitar re-spawn."""
    if not _LEXO_SPAWNED_FILE.exists():
        return set()
    try:
        data = json.loads(_LEXO_SPAWNED_FILE.read_text())
        return set(data) if isinstance(data, list) else set()
    except Exception:
        return set()

def _save_lexo_spawned(spawned: set[str]) -> None:
    try:
        _LEXO_SPAWNED_FILE.write_text(json.dumps(sorted(spawned)), encoding="utf-8")
    except Exception:
        pass

_lexo_spawned: set[str] = _load_lexo_spawned()
```

Y en `detect_lexo()`, añadir después de `_lexo_spawned.add(pid_key)`:
```python
_save_lexo_spawned(_lexo_spawned)
```

---

### MEJORA-05 — `append_pending_task` sin protección de duplicados

**Archivo:** `server/bridge.py`  
**Línea:** 345  
**Problema:** Si se llama dos veces con el mismo título, crea duplicados en el archivo.

**Fix:**
```python
def append_pending_task(title: str, description: str = "") -> None:
    try:
        existing = PENDING_TRACKER.read_text(encoding="utf-8") if PENDING_TRACKER.exists() else ""
        # Guard: no duplicar si el título ya existe como pendiente
        if re.search(re.escape(title), existing):
            return
        entry = f"\n- [ ] {title}"
        if description:
            entry += f"\n  {description}"
        PENDING_TRACKER.write_text(existing.rstrip() + entry + "\n", encoding="utf-8")
    except Exception as e:
        print(f"[bridge] No pude escribir PENDING_TRACKER: {e}")
```

---

### MEJORA-06 — `bridgeSchema.ts` no cubre el tipo `log`

**Archivo:** `src/bridgeSchema.ts`  
**Problema:** El tipo `log` es emitido por bridge.py en muchos lugares pero no está en el schema de valibot. Si llega un evento `log` al frontend, `parseBridgeEvent` devuelve `null` y se descarta con warning, perdiendo mensajes de estado.

**Fix en `src/bridgeSchema.ts`:** Añadir schema `log` al array `Schemas`:
```typescript
v.object({
  type: v.literal('log'),
  msg: v.string(),
  level: v.optional(LogLevel),
}),
```

Y añadir el tipo en `src/types.ts`:
```typescript
// En el union BridgeEvent:
| { type: 'log'; msg: string; level?: 'info' | 'warn' | 'success' }
```

**Test a añadir en `src/bridgeSchema.test.ts`:**
```typescript
it('acepta evento log', () => {
  const evt = parseBridgeEvent({ type: 'log', msg: 'hola', level: 'info' });
  expect(evt).not.toBeNull();
  expect(evt?.type).toBe('log');
});

it('acepta log sin level', () => {
  expect(parseBridgeEvent({ type: 'log', msg: 'hola' })).not.toBeNull();
});
```

---

### MEJORA-07 — `BridgeEvents.handleBridgeEvent` no maneja tipo `log`

**Archivo:** `src/bridge.ts`  
**Problema:** Aunque se arregle el schema (MEJORA-06), `handleBridgeEvent` no tiene un case para `log`. Al recibir un `log` del backend, el switch no lo procesa y el mensaje se pierde silenciosamente.

**Fix en `src/bridge.ts`:**
Buscar el `switch (evt.type)` en `handleBridgeEvent` y añadir el case:
```typescript
case 'log': {
  logEvent(evt.msg, (evt as { type: 'log'; msg: string; level?: string }).level as 'info' | 'warn' | 'success' ?? 'info');
  break;
}
```

---

### MEJORA-08 — Rate limiter en-memoria se resetea al reiniciar

**Archivo:** `server/bridge.py`  
**Líneas:** 100–112  
**Problema:** `_rate_buckets` es in-memory. Si el bridge se reinicia bajo ataque, el rate limiter empieza desde cero. No es crítico en localhost pero vale documentarlo.

**Acción:** Sin cambio de código — añadir comentario explícito:
```python
# Nota: este rate limiter es in-memory y no persiste entre reinicios.
# Para entornos expuestos a internet, usar un rate limiter basado en Redis o disco.
_rate_buckets: dict[str, list[float]] = {}
```

---

## Resumen de Cambios Ordenados por Prioridad

| # | ID | Archivo | Cambio | Esfuerzo | Impacto |
|---|---|---|---|---|---|
| 1 | BUG-01 | `server/bridge.py:334` | Regex `[-*+]` + filtrar `[x]` | 2 líneas | MEDIO — parser correcto |
| 2 | MEJORA-06 | `src/bridgeSchema.ts` | Añadir schema `log` | 5 líneas | ALTO — eventos log dejan de perderse |
| 3 | MEJORA-07 | `src/bridge.ts` | Case `log` en switch | 3 líneas | ALTO — mensajes bridge visibles |
| 4 | BUG-03 | `.env.example:4` | Reemplazar token redactado | 2 líneas | SEGURIDAD |
| 5 | MEJORA-01 | `server/bridge.py:334` | Campo `priority` en tasks | 4 líneas | BAJO — mejora UI |
| 6 | BUG-02 | `server/bridge.py:388–411` | UUID en lugar de counter | 8 líneas | MEDIO — IDs únicos entre reinicios |
| 7 | MEJORA-04 | `server/bridge.py` | Persistir `_lexo_spawned` | 15 líneas | BAJO — evita re-spawn tras restart |
| 8 | MEJORA-05 | `server/bridge.py:345` | Guard anti-duplicados | 3 líneas | BAJO — PENDING_TRACKER limpio |
| 9 | MEJORA-02 | `src/bridge.test.ts` | 3 tests nuevos | 40 líneas | MEDIO — cobertura bridge |
| 10 | MEJORA-03 | `server/test_pending_parser.py` (nuevo) | 10 tests parser | 80 líneas | ALTO — regresión parser |

**Esfuerzo total estimado:** ~3–4 horas de desarrollo + tests

---

## Criterios de Aceptación por Arreglo

```
BUG-01: pytest server/test_pending_parser.py → 10/10 pasan
BUG-02: no aparecen IDs duplicados en logs tras 3 reinicios consecutivos
BUG-03: grep "REPOCI" .env.example → sin resultados
MEJORA-06+07: bridge.py emite log → frontend muestra en log panel (visible en UI)
MEJORA-02: npm test → ≥ 194 tests (191 actuales + 3 nuevos)
MEJORA-03: pytest server/test_pending_parser.py → 10/10 pasan
```

---

## Cómo Verificar Todo de Una Vez

```bash
# Python
python3 -m pytest server/ -v 2>&1 | tail -5
# Debe decir: X passed donde X >= 203 (193 actuales + 10 nuevos)

# TypeScript
npm run test 2>&1 | tail -5
# Debe decir: Tests 194 passed (191 + 3 nuevos)

# Seguridad
grep "REPOCI" .env.example
# Debe retornar vacío

# Integridad de IDs LEXO
python3 -c "
import re
ids = ['LEXO-' + __import__('uuid').uuid4().hex[:8] for _ in range(10)]
assert len(set(ids)) == 10, 'IDs no únicos!'
assert all(re.match(r'LEXO-[0-9a-f]{8}', uid) for uid in ids)
print('IDs LEXO OK:', ids[:3], '...')
"
```
