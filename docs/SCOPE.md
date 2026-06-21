# RepoCiv — Scope (alpha)

> **Una página. Esta es la regla.**
> Si una propuesta nueva no encaja con lo que dice este documento, no entra al
> trunk. Si entra al trunk igual, este documento queda desactualizado y deja
> de ser la fuente de verdad. Mantenerlo honesto es más importante que
> mantenerlo aspiracional.

---

## Qué es RepoCiv hoy

Un dashboard hexagonal estilo Civilization V que **un usuario alpha de un solo asiento**
corre localmente para coordinar sus propios agentes sobre los repos
en `~/.hermes/workspace/repos/`. Los agentes shipped (built-in) son WORKER
y SCOUT; el resto se enrutan por harness (OPENCLAW, CLAUDE, CODEX, CURSOR)
o se registran como perfil personal del usuario.

Por debajo del juego hay un Agent OS real (Tensor Context, FrugalGPT Router,
Swarm Engine, World Model, Security Harness 3-capas, SICA, Docker isolation).
La razón de tener tanta infraestructura "industrial" siendo un solo usuario
es **deliberada**: el alpha-test sirve precisamente para descubrir cuáles de
esas capas aportan valor real y cuáles se destilan o se borran después.

Versión: **v2.0 — congelada en scope hasta que el dogfooding diga otra cosa.**

---

## Definición de "done" para esta etapa

> **Done = funciona para el workflow diario del usuario alpha y se siente
> mejor que no usarlo. NO = paridad feature-by-feature con AgentCraft o
> con cualquier otro producto.**

Métricas concretas para considerar el alpha "exitoso":

- El usuario alpha abre RepoCiv ≥ 5 días por semana de forma espontánea (sin recordatorio).
- Al menos 3 de los 21 paneles de UI se invocan habitualmente. Los demás
  son candidatos a poda (ver §"Roadmap de poda" abajo).
- El bridge se mantiene corriendo como systemd unit por ≥ 7 días sin
  intervención manual.
- Los endpoints `GET /improve/proposals` muestran al menos una propuesta
  útil que el usuario aplica a mano por mes.

---

## Lo que **sí** está en scope ahora

- Mejorar lo que **ya** se usa (renderer, hex grid, fatiga, priority matrix,
  task orchestrator, security harness, container runtime).
- Cerrar bugs y deudas técnicas que aparezcan durante el dogfooding.
- Mejoras visuales menores (assets, animaciones, tooltips) que hagan el
  alpha-test más placentero — pero sin reescribir capas grandes.
- **Los DOS renderers son trunk oficial.** El Canvas 2D (`flat`) es el modo
  por defecto y canónico; el WebGL/Three.js (`webgl`) es opt-in por
  `?renderer=webgl` o hotkey `3`. Decisión del owner (2026-06): lo oficial no
  es "2D o 3D" sino **poder alternar entre ambos sin fricción**. El invariante
  de switching está cubierto por un test no-GPU (`src/three/renderMode.test.ts`,
  máquina de estados de persistencia/migración) y por el e2e informativo
  `e2e/render-mode-parity.spec.ts` (boot real, requiere GPU). Three.js carga
  lazy: nunca entra al bundle eager del modo 2D (chunk `vendor-three`).
- Documentar lo que se aprende del uso real en `docs/implementation_plan.md`
  o en un futuro `docs/DOGFOODING_NOTES.md`.

## Lo que **sí pero en branch paralela** (no toca trunk)

> Branch paralela = no afecta el alpha-test diario. Se mergea solo cuando
> está estable Y aporta valor demostrado.

> **Nota (2026-06):** `feat/3d-renderer` ya **no** es branch paralela — el
> render 3D se integró a `main` y es oficial (ver arriba). El Canvas 2D dejó
> de ser el único canónico; ahora la regla es paridad de switching, no
> "2D-only hasta paridad funcional".

- **`feat/multi-device-mobile`** — el celular como segundo cliente vía
  PWA o app liviana. Útil porque el usuario alpha va a probar desde el
  teléfono, así que tiene sentido empezar a probar el contacto entre
  devices. Empieza por: serve-over-Tailscale + un cliente móvil
  mínimo (read-only) que se conecte al bridge local.
- **`feat/eventos-binarios`** o cualquier optimización de transporte
  que no sea bloqueante para el flujo diario.

## Lo que **no** está en scope (mover a v3.0 o no hacer)

Listado heredado del `implementation_plan.md` §10 + ajustes de esta etapa:

- ❌ Multi-tenant / multi-usuario (más de un usuario operando el mismo dashboard)
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
   *Implementado (plan A2/D3):* `src/ui/analytics.ts` registra `trackPanelOpen` /
   `trackHotkey`; `getPanelUsageReport()` (sobre la lista canónica `KNOWN_PANELS`)
   ordena de menos a más usado y se muestra en la **Ficha de la Capital →
   "candidatos a poda (0 = nunca abierto)"**. Tras 4-8 semanas, leer ese reporte
   para ejecutar esta poda.

2. **Telemetría de endpoints del bridge** — qué rutas se llaman desde el
   frontend. Endpoints muertos → borrar.

3. **Audit de módulos del backend** — `self_improve.py`, `world_model.py`,
   `swarm_engine.py`, `tensor_context.py` son los candidatos a evaluar.
   Si la telemetría del Ledger no muestra impacto medible (tokens ahorrados,
   accuracy mejorada), se mueven a `experimental/` o se borran.

El objetivo de la poda **no** es achicar por achicar — es bajar la
superficie de mantenimiento a lo que efectivamente se usa.

---

## Política de release

- **Mientras alpha:** no hay tags, no hay release notes, todo va a `main`.
- **Cuando el usuario alpha lo use diario y prefiera RepoCiv a no
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
- ¿Acabo de usar RepoCiv y encontré fricción o valor? → registrar en
  `docs/DOGFOODING_NOTES.md`. El aprendizaje de uso real alimenta este SCOPE.
