# RepoCiv — Plan Maestro Corregido (post-auditoría vs transcripción Missions)

> **Propósito:** corregir la deriva entre visión, código y docs; destrabar el estado actual de pruebas; y llevar RepoCiv desde un control plane fuerte pero incompleto hacia un sistema de misiones con validación real.
>
> **Contexto base verificado:**
> - Backend: `python3 -m pytest server/ -q` → **466 passed, 4 skipped**
> - Frontend unit tests: `npm test` → **279 passed**
> - Integración/check completo: `npm run check` → **falla** por TypeScript en `src/map.ts` y `src/ui/constructionPanel.ts`
> - Estado arquitectónico: RepoCiv ya tiene orquestación serial, workspace por issue, checkpoints, sentinel A2O, artifacts, observability, recovery plane y model routing conceptual; **todavía no** tiene `validation contract` fuerte ni `validator role` de primera clase.

---

## 0. Diagnóstico ejecutivo

### 0.1 Lo que RepoCiv ya es
RepoCiv **ya no es solo una UI bonita**. Tiene:
- `server/task_orchestrator.py` con ciclo real por issue
- `server/workspace_issue.py` con spec/plan/state/output y artifacts
- checkpoints + resume + sentinel `.repociv/status`
- `server/step_executor.py` con separación práctica entre `SCOUT`, `WORKER`, `DAVI`
- `server/model_router.py` con idea de modelo por rol
- `server/bridge.py` con endpoints de tareas, métricas, eventos, harnesses, recovery
- paneles operacionales en frontend (`taskPanel`, `observabilityPanel`, `timelinePanel`, `approvalPanel`, `harnessPanel`, `recoveryPanel`)

### 0.2 Lo que RepoCiv todavía no es
Todavía **no** es el sistema tipo “missions” descrito en la charla porque faltan tres piezas fundacionales:
1. **Validation contract** definido antes de ejecutar
2. **Validator lane** real e independiente del worker
3. **Cierre de misión basado en evidencia**, no solo en “steps terminados”

### 0.3 Tesis de este plan
La prioridad no es expandir más capas “industriales”.
La prioridad es:
1. volver el trunk a estado sano,
2. alinear docs con código,
3. introducir contrato + validación,
4. consolidar un Mission Control de verdad,
5. recién después crecer en paralelismo y sofisticación.

---

## 1. North Star corregida

### 1.1 Definición de “done” corregida para esta etapa
RepoCiv está listo para salir del estado de “pruebas paralizadas” cuando cumpla simultáneamente:
- `npm run check` pasa completo
- `python3 -m pytest server/ -q` sigue verde
- `npm run test:e2e` pasa o queda explícitamente documentado el bloqueo
- existe un **MVP de validation contract** por issue
- existe un **validator flow mínimo** que pueda marcar `pass/fail/needs-human-review`
- la UI permite ver por misión: fase, contrato, progreso, último handoff y último verdict de validación

### 1.2 Regla de crecimiento
Ninguna nueva capa grande entra al trunk si antes no mejora al menos uno de estos ejes:
- confiabilidad de misión
- claridad de estado
- validación basada en evidencia
- dogfooding diario real

---

## 2. Auditoría resumida en buckets

### 2.1 SOBRA
- lenguaje documental que declara “fases cerradas” cuando todavía hay build roto y validación incompleta
- parte del aparato industrial está por delante del flujo principal de valor
- `execplan/repociv-harness-control-plane.md` quedó parcialmente desalineado con lo ya implementado

### 2.2 MERGE
- Mission Control ya existe en piezas, pero fragmentado entre paneles
- los artifacts ya existen, pero sin formato canónico de handoff
- existe role-splitting práctico, pero no el split correcto `orchestrator / worker / validator`

### 2.3 FALTA
- `validation_contract`
- `validator role`
- behavioural validation en el loop principal
- handoff estructurado tipado
- enforcement real del modelo por rol
- mission semantic UI unificada
- notas de dogfooding reales dentro del repo

---

## 3. Roadmap corregido por fases

# Fase A — Destrabar trunk

## Objetivo
Volver RepoCiv a estado compilable, chequeable y mínimamente confiable para seguir trabajando.

## A1. Reparar `npm run check`
**Archivos objetivo:**
- `src/map.ts`
- `src/ui/constructionPanel.ts`

**Problemas ya verificados:**
- `grisRepo` posiblemente `undefined`
- acceso inseguro a capital repo en ordenación/colocación
- variables muertas en panel de construcción
- `selectedRepo` posiblemente `null`

**Acciones:**
1. endurecer narrowing de TypeScript en la lógica del repo capital en `src/map.ts`
2. eliminar variables no usadas (`_placingNewCity`, `tileLabel`, `preview`) o volverlas realmente funcionales
3. capturar `selectedRepo` en una constante validada antes del callback de colocación
4. re-correr `npm run check`

**Gate A1:**
- `npm run check` verde

## A2. Higiene del working tree
**Archivos observados:**
- `test_canrun.cjs`
- `test_dialog.cjs`
- `test_encoded_v2.cjs`
- `test_psfile.cjs`

**Acciones:**
1. decidir si son descartables, utilitarios o fixtures
2. borrarlos, moverlos o ignorarlos explícitamente

**Gate A2:**
- `git status --short` sin basura accidental

## A3. Verificación e2e real
**Archivos relevantes:**
- `playwright.config.ts`
- `e2e/repociv.spec.ts`

**Acciones:**
1. correr `npm run test:e2e:list`
2. correr `npm run test:e2e`
3. si falla, documentar en `docs/DOGFOODING_NOTES.md` el bloqueo y crear issue/plan local

**Gate A3:**
- e2e verde o bloqueo documentado con causa concreta

---

# Fase B — Alinear verdad documental

## Objetivo
Que el repo deje de mentirse respecto de su propio estado.

## B1. Corregir `docs/implementation_plan.md`
**Problema:** sobredeclara cierre y madurez.

**Acciones:**
1. agregar sección `Estado real al 2026-05-06`
2. diferenciar explícitamente:
   - operativo
   - parcial
   - experimental
   - aspiracional
3. marcar como deuda abierta:
   - validator lane
   - validation contract
   - build roto (hasta cerrar Fase A)

## B2. Corregir `execplan/repociv-harness-control-plane.md`
**Problema:** milestones pendientes que en parte ya existen en código.

**Acciones:**
1. actualizar `Progress`
2. mover lo ya implementado a “done” con evidencia
3. dejar solo los huecos reales de harness/recovery

## B3. Crear `docs/DOGFOODING_NOTES.md`
**Formato mínimo:**
- fecha
- flujo usado
- qué paneles sí usaste
- qué paneles no agregaron valor
- fricción encontrada
- decisión / aprendizaje

**Gate B:**
- docs cuentan la misma historia que el código

---

# Fase C — Introducir Validation Contract (MVP)

## Objetivo
Cambiar RepoCiv de “ejecución de steps” a “misión con definición previa de done”.

## C1. Nuevo artefacto por issue
**Crear en workspace issue:**
- `validation_contract.json` o `validation_contract.md`

**Campos mínimos recomendados:**
- `goal`
- `deliverables`
- `must_pass_checks`
- `behaviour_checks`
- `forbidden_changes`
- `evidence_required`
- `done_definition`

## C2. Orden correcto del flujo
Flujo corregido:
1. `spec.md`
2. `validation_contract.*`
3. `plan.md`
4. dispatch de steps
5. validation
6. close

## C3. Fallback honesto
Si no existe contract:
- el orquestador puede generar uno básico
- pero debe marcarlo como `autoGenerated: true`
- y pedir revisión humana en checkpoint

**Gate C:**
- cada misión tiene contrato explícito antes del cierre

---

# Fase D — Validator Lane real

## Objetivo
Separar implementación de verificación.

## D1. Nuevo rol `VALIDATOR`
**No reemplaza** a `SCOUT`. Cumple otra función.

**Responsabilidades:**
- leer `validation_contract`
- leer artifacts y output de worker
- correr checks
- emitir verdict estructurado:
  - `pass`
  - `fail`
  - `needs-human-review`

## D2. Dos capas de validación
### Validator técnico
- lint
- typecheck
- tests
- coherencia de artifacts

### Validator conductual
- smoke/e2e
- flujo funcional del feature
- comportamiento visible esperado

## D3. Cierre condicionado
Modificar el cierre para que:
- `worker finished` != `mission complete`
- `validator pass` sea condición de completitud

**Gate D:**
- una misión puede quedar `failed_by_validation` aunque el worker haya terminado sus steps

---

# Fase E — Handoffs estructurados

## Objetivo
Que los artifacts sirvan como memoria operacional real, no solo como volcado libre.

## E1. Crear formato canónico de handoff
**Archivo sugerido por step o fase:**
- `handoff_<step>.json` o `handoff_<phase>.md`

**Campos mínimos:**
- `completed_work`
- `commands_run`
- `files_changed`
- `tests_run`
- `open_risks`
- `known_failures`
- `recommended_next_role`
- `recommended_next_action`

## E2. Handoff obligatorio antes de avanzar
- SCOUT → WORKER
- WORKER → VALIDATOR
- VALIDATOR → ORCHESTRATOR/HUMAN

**Gate E:**
- no se puede avanzar de fase sin handoff válido

---

# Fase F — Mission Control unificado

## Objetivo
Unificar la experiencia de misión.

## F1. Consolidación visual
No significa borrar paneles, sino crear una vista central por misión que reúna:
- repo
- issue
- fase actual
- contract status
- progress
- último handoff
- validator verdict
- último error
- recovery options
- model chosen per role

## F2. Razón de bloqueo visible
La UI debe distinguir:
- `blocked: post-diagnose`
- `blocked: post-plan`
- `blocked: post-fix`
- `blocked: validator-fail`
- `blocked: needs-human-review`
- `circuit_open`

**Gate F:**
- un humano puede entender el estado de una misión sin abrir archivos a mano

---

# Fase G — Crecimiento correcto

## Objetivo
Expandir solo después de consolidar la misión base.

## G1. Targeted parallelism
Patrón recomendado:
- scouts paralelos de lectura
- síntesis única
- worker único
- validator único o doble (técnico + conductual)

## G2. Enforcement real de modelo por rol
Persistir por step:
- modelo elegido
- tier
- reason
- fallback chain
- resultado

## G3. Auto-mejora solo con evidencia
No subir `self_improve` de categoría hasta que existan:
- validator verdicts
- métricas por misión
- datos comparables de mejora real

---

## 4. Priorización real (orden ejecutable)

### Prioridad 1 — esta semana
1. Fase A completa
2. Fase B mínima
3. abrir `docs/DOGFOODING_NOTES.md`

### Prioridad 2 — siguiente salto arquitectónico
4. Fase C (`validation_contract` MVP)
5. Fase D (`VALIDATOR` MVP)

### Prioridad 3 — consolidación UX/operacional
6. Fase E (handoffs canónicos)
7. Fase F (Mission Control unificado)

### Prioridad 4 — crecimiento
8. Fase G

---

## 5. Comandos de verificación

```bash
cd /home/gris/.hermes/workspace/repos/repociv
python3 -m pytest server/ -q
npm test
npm run check
npm run test:e2e:list
npm run test:e2e
git status --short --branch
```

---

## 6. Criterio de éxito final de este plan

RepoCiv deja de estar “paralizado en pruebas” cuando:
- el trunk está sano,
- el estado documental es honesto,
- existe contrato de validación,
- existe validator lane,
- el cierre de misión depende de evidencia,
- y el dogfooding produce aprendizaje explícito dentro del repo.

---

## 7. Nota final

La dirección correcta para RepoCiv **no** es “más features agentic”.
Es:
- más contrato,
- más verificación,
- más legibilidad de estado,
- menos ambigüedad entre ‘corrió’ y ‘resolvió’.

Esa diferencia es exactamente la línea entre un orquestador prometedor y un sistema de misiones serio.
