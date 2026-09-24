# P3 — La selección compartida manda sobre el caché local

Fecha: 2026-09-24 · Rama: `feat/ext-agent-map-p2-p3` · Base: `a7494fe`

## Contexto

Había dos orígenes de verdad para «qué repos son ciudades»:

- `state.json` (bridge, `GET /api/repo-selections`): la que usa `suvadu_tracker.py`
  para resolver la ciudad de cada agente externo.
- `localStorage` del navegador (`loadSelectedRepoPaths`): caché por pestaña.

## Síntoma

Una pestaña con caché viejo mostraba un mundo distinto al que ve el bridge:
agentes con `cityId: repo:…` para repos que en ese navegador no eran ciudades
caían off-map (parqueados en la capital). Casos vivos (2026-09-24):
`ext-hermes-bc700a85` → `lexo-case-writer`, `ext-hermes-2c92f8f9` →
`lean-kernel-challenge`, `~/.hermes/profiles/lexo-alpha`, `~/.hermes`.

## Mecanismo

`generateWorld` (`src/map.ts`) ahora consulta **primero** `/api/repo-selections`:

1. Si hay selección compartida (`selectedRepoPaths.length > 0`), esa manda:
   se espeja al caché y se filtran los repos contra ella.
2. Si el bridge no responde o no hay selecciones → camino anterior
   (caché local → `/api/repos/selected`), como fallback offline.

Así el mapa del navegador coincide con la resolución del bridge, que es la
que decide dónde aparece cada agente.

## TDD

- **Rojo por la razón correcta:** el test invertido
  (`prefers shared backend selection (state.json) over the client-side cache`)
  falló porque el lector jamás llamaba a `/api/repo-selections`
  (`Number of calls: 7`, ninguna a la ruta nueva).
- **Fix del lector** → `map.test.ts` 14/14 · suite completa 98 archivos /
  1015 tests verde.
- **Gate completo** `scripts/check.sh`: la primera corrida falló en
  `tsc --noEmit` por un narrowing en L1009 (`Set<string> | null`); se
  corrigió con un `const sharedPaths` local. Segunda corrida:
  **All checks green · GATE_RC=0** (vitest + eslint + prettier + build +
  ruff + pytest).

## Verificación

- `npx vitest run src/map.test.ts src/externalAgents.test.ts` → 44 verdes.
- `gate-p3b.log`: `All checks green.` / `GATE_RC=0` (2026-09-24).
