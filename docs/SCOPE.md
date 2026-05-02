# RepoCiv — Scope (alpha)

> **Una página. Esta es la regla.**
> Si una propuesta nueva no encaja con lo que dice este documento, no entra al
> trunk. Si entra al trunk igual, este documento queda desactualizado y deja
> de ser la fuente de verdad. Mantenerlo honesto es más importante que
> mantenerlo aspiracional.

---

## Qué es RepoCiv hoy

Un dashboard hexagonal estilo Civilization V que **Cristóbal usa como alpha
tester de un solo asiento**, corriendo local en una RTX 4060, para coordinar
sus propios agentes (DAVI, LEXO, WORKER, SCOUT, OPENCLAW) sobre los repos
en `~/.hermes/workspace/repos/`.

Por debajo del juego hay un Agent OS real (Tensor Context, FrugalGPT Router,
Swarm Engine, World Model, Security Harness 3-capas, SICA, Docker isolation).
La razón de tener tanta infraestructura "industrial" siendo un solo usuario
es **deliberada**: el alpha-test sirve precisamente para descubrir cuáles de
esas capas aportan valor real y cuáles se destilan o se borran después.

Versión: **v2.0 — congelada en scope hasta que el dogfooding diga otra cosa.**

---

## Definición de "done" para esta etapa

> **Done = funciona para Cristóbal en su workflow diario y se siente
> mejor que no usarlo. NO = paridad feature-by-feature con AgentCraft o
> con cualquier otro producto.**

Métricas concretas para considerar el alpha "exitoso":

- Cristóbal abre RepoCiv ≥ 5 días por semana de forma espontánea (sin recordatorio).
- Al menos 3 de los 21 paneles de UI se invocan habitualmente. Los demás
  son candidatos a poda (ver §"Roadmap de poda" abajo).
- El bridge se mantiene corriendo como systemd unit por ≥ 7 días sin
  intervención manual.
- Los endpoints `GET /improve/proposals` muestran al menos una propuesta
  útil que Cristóbal aplica a mano por mes.

---

## Lo que **sí** está en scope ahora

- Mejorar lo que **ya** se usa (renderer, hex grid, fatiga, priority matrix,
  task orchestrator, security harness, container runtime).
- Cerrar bugs y deudas técnicas que aparezcan durante el dogfooding.
- Mejoras visuales menores (assets, animaciones, tooltips) que hagan el
  alpha-test más placentero — pero sin reescribir capas grandes.
- Documentar lo que se aprende del uso real en `docs/implementation_plan.md`
  o en un futuro `docs/DOGFOODING_NOTES.md`.

## Lo que **sí pero en branch paralela** (no toca trunk)

> Branch paralela = no afecta el alpha-test diario. Se mergea solo cuando
> está estable Y aporta valor demostrado.

- **`feat/3d-renderer`** — explorar Three.js / WebGL como render alternativo.
  Branch independiente, puede romperse libremente. El Canvas 2D sigue
  siendo el render canónico hasta que el 3D demuestre paridad funcional
  (no solo estética).
- **`feat/multi-device-mobile`** — el celular como segundo cliente vía
  PWA o app liviana. Útil porque Cristóbal va a alpha-testear desde el
  teléfono, así que tiene sentido empezar a probar el contacto entre
  devices. Empieza por: serve-over-Tailscale + un cliente móvil
  mínimo (read-only) que se conecte al bridge local.
- **`feat/eventos-binarios`** o cualquier optimización de transporte
  que no sea bloqueante para el flujo diario.

## Lo que **no** está en scope (mover a v3.0 o no hacer)

Listado heredado del `implementation_plan.md` §10 + ajustes de esta etapa:

- ❌ Multi-tenant / multi-usuario (alguien que no sea Cristóbal usándolo)
- ❌ Alliance Hall / multiplayer en tiempo real
- ❌ Race skins / achievements / sistema de logros
- ❌ Voice input / TTS
- ❌ Mesh networking P2P (`AUDIT_DELTA_ADDENDUM.md` §B)
- ❌ eBPF / Linux Landlock / LD_PRELOAD (`AUDIT_DELTA_ADDENDUM.md` §A) —
  excelentes para producción multi-tenant, sobredimensionados para single-user
- ❌ Economic Survival Model con créditos por agente (`AUDIT_DELTA_ADDENDUM.md` §C)
- ❌ SICA con apply automático (queda dormido, accesible solo por GET)
- ❌ Cualquier feature nueva que no responda a un dolor observado durante el
  dogfooding

---

## Roadmap de poda (post-dogfooding)

Tras 4-8 semanas de uso real, ejecutar este audit:

1. **Telemetría de paneles** — registrar qué hotkeys se usan y cuáles paneles
   se abren. Cualquier panel con 0 invocaciones en 4 semanas → candidato a borrar.
   Sospechosos iniciales: Replay, Observability, Quest Board, Recovery, Harness,
   Timeline (todos juntos pueden ser 2/3 de la superficie de UI).

2. **Telemetría de endpoints del bridge** — qué rutas se llaman desde el
   frontend. Endpoints muertos → borrar.

3. **Audit de módulos del backend** — `self_improve.py`, `world_model.py`,
   `swarm_engine.py`, `tensor_context.py` son los candidatos a evaluar.
   Si la telemetría del Ledger no muestra impacto medible (tokens ahorrados,
   accuracy mejorada), se mueven a `experimental/` o se borran.

El objetivo de la poda **no** es achicar por achicar — es bajar la
superficie de mantenimiento a lo que efectivamente Cristóbal usa.

---

## Política de release

- **Mientras alpha:** no hay tags, no hay release notes, todo va a `main`.
- **Cuando Cristóbal sienta que lo usa diario y prefiere RepoCiv a no
  usarlo:** se hace `v0.2.0 alpha` y se publica el repo. Antes no.
- **Multi-device decente:** condición necesaria para considerar `v1.0`.
- **Multi-usuario:** explícitamente fuera de cualquier roadmap por ahora.

---

## Para volver a este documento

- ¿Estoy a punto de empezar una feature grande? → re-leer este SCOPE.
- ¿Acabo de aceptar un PR/cambio que rompe el SCOPE? → actualizar este
  SCOPE inmediatamente. No vivir en la mentira.
- ¿El SCOPE empieza a sentirse aspiracional y desfasado del código? → el
  problema no es el código, es que el SCOPE necesita revisión honesta.
