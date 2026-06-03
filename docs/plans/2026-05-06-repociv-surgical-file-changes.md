# RepoCiv — Lista quirúrgica de cambios de archivo

> **Propósito:** traducir la auditoría y el plan maestro corregido a cambios concretos de archivos dentro del repo.
>
> **Regla:** esto no es un roadmap abstracto. Cada bloque indica archivo(s), objetivo, cambio esperado, prueba y criterio de done.

---

## Lote 0 — Estado base verificado

### Confirmado antes de tocar nada
- `server/` tests: **466 passed, 4 skipped**
- `npm test`: **279 passed**
- `npm run check`: **falla** por TypeScript
- errores actuales en:
  - `src/map.ts`
  - `src/ui/constructionPanel.ts`

---

# Lote 1 — Reparar trunk y volverlo chequeable

## 1. `src/map.ts`

### Problema
La lógica del repo capital (`gris`) tiene narrowing insuficiente y rompe `tsc`:
- `grisRepo` posiblemente `undefined`
- acceso inseguro a `cityRepos[0]`

### Cambio esperado
Refactorizar la sección de capitalización para que:
1. el resultado de `splice()` se valide explícitamente
2. el acceso a `cityRepos[0]` solo ocurra con guard real
3. no existan mutaciones sobre referencias potencialmente `undefined`

### Patrón sugerido
- usar variable intermedia validada (`const grisRepo = ...; if (grisRepo) { ... }`)
- evitar confiar en inferencia posterior a `splice`
- si `cityRepos.length === 0`, salir de la rama sin mutar

### Pruebas
```bash
npm run check
npm test
```

### Done
- no quedan errores TS asociados a `grisRepo` / `cityRepos[0]`

---

## 2. `src/ui/constructionPanel.ts`

### Problemas
- variables no usadas:
  - `_placingNewCity`
  - `tileLabel`
  - `preview`
- callback de colocación usa `selectedRepo` con riesgo de `null`

### Cambio esperado
1. eliminar las variables realmente muertas o volverlas útiles de forma explícita
2. antes de crear `_onPickTileCb`, capturar un snapshot seguro:
   - `const repoToPlace = selectedRepo; if (!repoToPlace) return;`
3. dentro del callback usar `repoToPlace`, no `selectedRepo`
4. si `tileLabel` y `preview` estaban pensados para feedback UX, o bien:
   - reconectar su uso real, o
   - sacarlos del DOM y del código para no dejar promesas falsas

### Pruebas
```bash
npm run check
npm test
```

### Done
- no quedan errores TS por `selectedRepo is possibly null`
- no quedan `TS6133` por variables no usadas

---

## 3. `test_canrun.cjs`, `test_dialog.cjs`, `test_encoded_v2.cjs`, `test_psfile.cjs`

### Problema
Archivos sueltos no trackeados ensucian el repo.

### Cambio esperado
Elegir una de estas tres rutas y dejarla explícita:
1. borrar archivos si fueron descartables de diagnóstico
2. moverlos a `scripts/diagnostics/` si siguen siendo útiles
3. agregarlos a `.gitignore` si deben vivir localmente

### Pruebas
```bash
git status --short --branch
```

### Done
- working tree sin basura accidental

---

# Lote 2 — Alinear documentación con estado real

## 4. `docs/implementation_plan.md`

### Problema
El documento sobredescribe madurez/cierre respecto del código real.

### Cambio esperado
Agregar una sección visible cerca del inicio:

## Estado real al 2026-05-06
- build/trunk status
- operativo vs parcial vs experimental
- deudas abiertas

### Marcar explícitamente como pendientes reales
- `validation_contract`
- `validator lane`
- enforcement real de modelo por rol
- Mission Control semántico unificado

### Done
- el doc deja de implicar que todo “missions-like” ya existe

---

## 5. `execplan/repociv-harness-control-plane.md`

### Problema
El execplan quedó parcialmente desfasado: varios milestones aparecen pendientes aunque ya existen en código.

### Cambio esperado
Actualizar estas secciones:
- `Progress`
- `Surprises & Discoveries`
- `Outcomes & Retrospective`

### En particular
Mover a completado/evidenciado lo que ya existe:
- `shared/harness-registry.json`
- `src/harnessRegistry.ts`
- `server/harness_registry.py`
- `src/ui/harnessPanel.ts`
- `src/ui/recoveryPanel.ts`
- endpoints `/harnesses` y `/harnesses/<id>/recovery-command`

### Done
- el execplan refleja el repo real, no el estado previo a implementación

---

## 6. `docs/DOGFOODING_NOTES.md` (nuevo)

### Problema
`docs/SCOPE.md` exige aprendizaje por uso real, pero no existe registro vivo de ese uso.

### Crear archivo con plantilla mínima
```md
# RepoCiv — Dogfooding Notes

## YYYY-MM-DD
- Flujo probado:
- Paneles usados:
- Qué sí aportó valor:
- Qué no aportó valor:
- Fricción encontrada:
- Error o bug observado:
- Decisión tomada:
- Follow-up:
```

### Done
- existe un lugar canónico para registrar aprendizaje de uso diario

---

# Lote 3 — Introducir Validation Contract MVP

## 7. `server/workspace_issue.py`

### Objetivo
Agregar soporte a un nuevo artefacto por issue:
- `validation_contract.json` o `validation_contract.md`

### Cambio esperado
Agregar helpers equivalentes a spec/plan:
- `read_validation_contract(...)`
- `write_validation_contract(...)`
- path helper interno

### Contrato mínimo sugerido
```json
{
  "goal": "",
  "deliverables": [],
  "must_pass_checks": [],
  "behaviour_checks": [],
  "forbidden_changes": [],
  "evidence_required": [],
  "done_definition": "",
  "autoGenerated": false
}
```

### Tests a crear
- `server/test_workspace_issue.py` o nuevo `server/test_validation_contract.py`

### Done
- el workspace issue soporta contrato como ciudadano de primera clase

---

## 8. `server/task_orchestrator.py`

### Objetivo
Cambiar el orden semántico de la misión.

### Cambio esperado
Antes de entrar a `planned` / `executing`, asegurar que existe `validation_contract`.

### Reglas propuestas
1. si falta contrato, generarlo en modo mínimo desde spec
2. marcar `autoGenerated: true`
3. si checkpoints están activos, bloquear para revisión humana tras generar contrato
4. persistir referencia al contract en `state.json`

### Estado adicional sugerido
En `state.json`:
- `validationContractPresent: true|false`
- `validationContractAutoGenerated: true|false`
- `validationVerdict: null|pass|fail|needs-human-review`

### Tests a crear
- task sin contract → genera fallback
- contract presente → no regenera
- checkpoint posterior a contract se respeta

### Done
- toda misión pasa por contrato antes de cierre

---

# Lote 4 — Crear Validator Lane real

## 9. `server/validator.py` (nuevo)

### Objetivo
Crear rol de validación explícito.

### API mínima sugerida
```python
def validate_issue(repo: str, issue_id: str) -> dict[str, Any]:
    ...
```

### Salida mínima sugerida
```json
{
  "verdict": "pass|fail|needs-human-review",
  "technical_checks": [...],
  "behaviour_checks": [...],
  "summary": "",
  "evidence": [...],
  "followups": [...]
}
```

### Done
- existe un módulo de validación explícito y testeable

---

## 10. `server/task_orchestrator.py`

### Objetivo
Insertar fase de validator entre ejecución y completitud.

### Cambio esperado
Flujo nuevo:
1. spec
2. contract
3. plan
4. execute
5. validate
6. complete / fail / blocked

### Reglas
- no marcar `complete` hasta `validator pass`
- si `validator fail`, guardar artifact y dejar fase explícita
- si `needs-human-review`, escribir sentinel + checkpoint

### Fases sugeridas
Puedes:
- extender `server/phases.py`, o
- mantener strings actuales pero agregar `validating`, `failed_by_validation`

### Tests a crear
- worker ok + validator pass → complete
- worker ok + validator fail → failed_by_validation
- worker ok + validator needs-human-review → blocked

### Done
- “terminó el worker” deja de equivaler a “misión terminada”

---

## 11. `server/repo_config.py`

### Objetivo
Aprovechar el whitelist existente para checks técnicos del validator.

### Cambio esperado
Permitir que el validator consulte comandos configurables/seguros para:
- tests
- lint
- build

No hace falta reventar el diseño actual; basta con documentar y usar los hooks/whitelist existentes de forma más sistemática.

### Done
- validator técnico puede apoyarse en comandos ya autorizados

---

# Lote 5 — Handoffs canónicos

## 12. `server/workspace_issue.py`

### Objetivo
Agregar soporte a artifacts de handoff estructurado.

### Cambio esperado
Helpers nuevos, por ejemplo:
- `write_handoff(repo, issue_id, phase_or_step, payload)`
- `read_latest_handoff(repo, issue_id)`

### Payload mínimo
```json
{
  "role": "SCOUT|WORKER|VALIDATOR|DAVI",
  "completed_work": [],
  "commands_run": [],
  "files_changed": [],
  "tests_run": [],
  "open_risks": [],
  "known_failures": [],
  "recommended_next_role": "",
  "recommended_next_action": ""
}
```

### Done
- el siguiente rol puede leer handoff estructurado sin depender del context window

---

## 13. `server/step_executor.py`

### Objetivo
Hacer que el mission builder pueda incluir handoffs, no solo artifacts planos.

### Cambio esperado
En `build_step_mission(...)`:
- priorizar contract + latest handoff + relevant artifacts
- no solo “últimos N outputs”

### Done
- el contexto del siguiente paso es más semántico y menos accidental

---

# Lote 6 — Mission Control semántico

## 14. `src/ui/taskPanel.ts`

### Objetivo
Pasar de lista de tareas a vista más cercana a “misiones”.

### Cambio esperado
Agregar columnas o detalle expandible para:
- `checkpointGate`
- `validationVerdict`
- `blocked reason`
- `lastError`

### Necesidad backend
Probablemente habrá que enriquecer `/tasks` desde `server/task_orchestrator.py`.

### Done
- el panel muestra por qué una misión está bloqueada o validada

---

## 15. `server/task_orchestrator.py`

### Objetivo
Enriquecer `list_tasks()` y `get_task_status()`.

### Agregar campos sugeridos
- `checkpointGate`
- `validationVerdict`
- `validationSummary`
- `lastHandoffRole`
- `lastHandoffAt`

### Done
- el frontend no necesita cazar artifacts a ciegas para entender una misión

---

## 16. `src/ui/observabilityPanel.ts`

### Objetivo
Que los fallos recientes no sean solo errores, sino estados operacionales entendibles.

### Cambio esperado
Para cada failure relevante:
- mostrar si vino de ejecución o de validación
- linkear recovery si aplica
- mostrar harness cuando corresponda

### Done
- un fallo dice más que “CommandFailed”

---

## 17. `src/ui/timelinePanel.ts`

### Objetivo
Volver visible la narrativa de misión.

### Cambio esperado
Agregar soporte visual para eventos del tipo:
- `ValidationStarted`
- `ValidationPassed`
- `ValidationFailed`
- `HandoffWritten`
- `MissionBlockedByValidation`

### Done
- la crónica cuenta la historia completa de la misión, no solo ejecución cruda

---

# Lote 7 — Enforcement real de modelo por rol

## 18. `server/model_router.py`

### Problema
El routing existe, pero hoy es más conceptual que ejecutivamente vinculante.

### Cambio esperado
Asegurar que el retorno del router termine reflejado en:
- dispatch real
- artifacts/state
- métricas

### Done
- el modelo elegido por rol deja rastro real

---

## 19. `server/step_executor.py`

### Objetivo
Persistir en artifacts o state:
- `model`
- `tier`
- `reason`
- `fallback_chain`

### Done
- una misión puede auditarse también por su decisión de modelo

---

## 20. `server/agent_runner.py` y/o adapters relevantes

### Objetivo
Verificar si el modelo elegido realmente se aplica al runtime efectivo.

### Cambio esperado
Si hoy no se inyecta de verdad, abrir ese camino con un contrato claro en meta/payload.

### Done
- “model-per-role” deja de ser solo intención documentada

---

# Lote 8 — Dogfooding y poda

## 21. `docs/SCOPE.md`

### Cambio esperado
Agregar referencia explícita a `docs/DOGFOODING_NOTES.md` como fuente operacional de aprendizaje.

---

## 22. `docs/README.md`

### Cambio esperado
Agregar el nuevo documento al mapa de docs activos.

---

## 23. `docs/DOGFOODING_NOTES.md`

### Objetivo continuo
Durante 4–8 semanas, registrar:
- paneles realmente usados
- endpoints realmente valiosos
- módulos que no aportan

### Resultado esperado
Base de evidencia para poda post-dogfooding de:
- Replay
- Observability
- Quest Board
- Recovery
- Harness
- Timeline
- o cualquier otro panel si no aporta

---

# Orden recomendado de ejecución

## Ola 1 — Desbloqueo inmediato
1. `src/map.ts`
2. `src/ui/constructionPanel.ts`
3. limpieza de archivos sueltos
4. `npm run check`
5. `npm run test:e2e`

## Ola 2 — Honestidad documental
6. `docs/implementation_plan.md`
7. `execplan/repociv-harness-control-plane.md`
8. `docs/DOGFOODING_NOTES.md`
9. `docs/README.md`
10. `docs/SCOPE.md`

## Ola 3 — Misión con contrato
11. `server/workspace_issue.py`
12. `server/task_orchestrator.py`
13. tests asociados

## Ola 4 — Validator lane
14. `server/validator.py`
15. `server/task_orchestrator.py`
16. `server/repo_config.py`
17. tests asociados

## Ola 5 — Mission Control
18. `server/task_orchestrator.py`
19. `src/ui/taskPanel.ts`
20. `src/ui/observabilityPanel.ts`
21. `src/ui/timelinePanel.ts`

## Ola 6 — Modelo por rol real
22. `server/model_router.py`
23. `server/step_executor.py`
24. `server/agent_runner.py`

---

# Comandos de verificación por lote

```bash
cd <repo-root>

# base
python3 -m pytest server/ -q
npm test

# trunk healthy
npm run check
npm run test:e2e:list
npm run test:e2e

# hygiene
git status --short --branch
```

---

# Criterio final de éxito

Este archivo queda cumplido cuando RepoCiv:
1. compila y chequea limpio,
2. deja de sobredeclarar madurez en docs,
3. tiene `validation_contract` por misión,
4. tiene `validator lane` real,
5. muestra estado semántico de misión en UI,
6. y usa el dogfooding como criterio de crecimiento, no solo intuición.
