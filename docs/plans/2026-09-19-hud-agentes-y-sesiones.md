# Rehacer la barra de agentes y el alta de sesiones

Prompt de arranque para la próxima sesión. Estado al 2026-09-19, rama
`feat/agent-liveness-state` (4 commits, sin push).

---

## El pedido

Dos cosas, en palabras del usuario:

1. **«Que la barra de abajo a la izquierda con los bots sea la de F8.»** El panel
   de agentes (F8) ya es la vista buena: unifica los agentes externos (Claude
   Code, Codex, Cursor vía Suvadu; Hermes vía sus `state.db`) *y* las unidades
   propias de RepoCiv, con estado, ubicación y chat. La barra de abajo solo
   muestra las unidades propias y duplica el concepto.
2. **«Hay que rehacer cómo seleccionar y crear una sesión nueva desde RepoCiv,
   porque la barra de abajo a la izquierda nunca me funcionó mucho.»** Esto es lo
   importante: no es mover una lista de lugar, es que el flujo de *elegir con qué
   agente hablar* y el de *abrir una sesión nueva* nunca funcionaron. Tratalo
   como rediseño, no como refactor.

## Dónde está cada cosa

**La barra de abajo a la izquierda** es `#command-bar`, en `index.html:195-227`:

- `#hero-bar-slots` — los «bots». Lo dibuja `renderHeroBar()`
  (`src/ui/panel.ts:131`), que solo ve unidades propias y no efímeras.
  Se re-dibuja desde `src/main.ts:1262`, `src/ui/hudWiring/spawn.ts:32` y
  `src/ui/hudWiring/hotkeys.ts:124`.
- `.hero-bar-spawn` — el alta: `#profile-launchers` y `#spawn-new-profile`
  (Profile Studio, `src/ui/agentProfileStrip.ts`), `#spawn-botmode`, y los
  `.spawn-btn[data-type]` (MAIN/WORKER/SCOUT/OPENCLAW/CLAUDE/CODEX/PRAETORIAN)
  que llaman a `spawnAgent()` en `src/ui/hudWiring/spawn.ts`.
- Atajos: `1-9` selecciona y `Tab` cicla (`src/ui/hudWiring/hotkeys.ts:190`);
  `Ctrl+Q/Shift+W/E/O/C/X/G` spawnean (`hotkeys.ts:153-187`).
- `src/ui/heroBarUnits.ts` decide qué unidades entran en la barra.

**El panel F8** es `src/ui/agentsPanel.ts` (+ `src/externalAgents.ts` para datos
y tipos, `src/styles/panels/agents-panel.css`). Secciones: Activos, Últimas 24 h,
Cron/Gateway plegables, y «Unidades RepoCiv». Abre con `#btn-agents`
(`index.html:67`), F8 (`hotkeys.ts:346`) o la paleta (`commands.ts:88`).

## Qué NO romper

- **Seleccionar una unidad del mapa sigue siendo el camino principal.**
  `selectHero()` (`src/ui/hudWiring/spawn.ts:21`) sincroniza panel de unidad,
  cámara y chat. Cualquier lista nueva tiene que entrar por ahí.
- **Las reglas de sesiones externas ya establecidas** (fases 1-3 de esta rama):
  una sesión con proceso vivo es de solo lectura, `⏎ Retomar` da el comando, y
  responder corre *un turno* reanudando la sesión. Ver `docs/EXTERNAL_AGENTS.md`.
- La barra de abajo a la derecha (log + minimapa) y `#unit-panel` son otra cosa;
  no entran en este trabajo salvo que estorben.

## El hueco abierto que conviene mirar antes

`docs/EXTERNAL_AGENTS.md` → **«Pendiente: escribirle a una sesión activa»**. Es
la prioridad real del usuario y puede cambiar el diseño de esta pantalla: si las
sesiones activas pasan a ser chateables (API del gateway de Hermes en `:8742`, o
un multiplexor con tmux), la lista deja de ser «leer» y pasa a ser «entrar».
Leelo antes de decidir la forma.

## Cómo encarar

Antes de escribir código, plan y preguntas. Hay al menos tres decisiones que son
del usuario, no tuyas:

- ¿La barra de abajo **desaparece** y F8 queda como única vista, o se convierte
  en una tira compacta que abre F8? (¿Qué pasa con `1-9` y `Tab`?)
- «Sesión nueva» hoy mezcla tres ideas: *spawnear una unidad* en el mapa,
  *elegir un perfil* (Profile Studio) y *abrir un chat*. ¿Cuál de las tres es la
  que el usuario quiere que sea el botón «nueva sesión»?
- ¿Sigue teniendo sentido que un agente sea una unidad en un hexágono, o la
  sesión pasa a ser lo primario y la unidad su representación?

Pedile al usuario que elija esas tres antes de tocar nada.

## Convenciones de este repo

- `npm start` (no `npm run dev`), y el bridge en Python necesita reinicio a mano
  tras cambios; `scripts/dev-start.sh` atrapa `EXIT` y se lleva a Vite con él.
- Un commit chico por fase, en español, con el porqué en el cuerpo. Sin push sin
  preguntar.
- `npx tsc --noEmit`, `npx vitest run`, `.venv/bin/pytest server`,
  `npx eslint src --ext .ts,.tsx --max-warnings=0`, `.venv/bin/ruff check server/`.
