# Evidencia: Claude Code y Codex en la ciudad donde trabajan

**Fecha**: 2026-09-24
**Rama**: `fix/ext-agent-work-repo` (sigue a `2026-09-24-ext-agent-work-repo.md`)
**Método**: diagnóstico con sesiones reales, TDD, dos `codex exec` reales
lanzados desde `~`, gate completo.

## Síntomas reportados

1. Sesiones nuevas de Codex que solo aparecían al recargar la página.
2. Codex y Claude Code junto a la capital, no en la ciudad de su repo.
3. Lo mismo con Claude Code.

## Causas

- **2 y 3:** los dos se lanzaron desde `~`. Suvadu reporta `cwd=/home/gris96`
  para la sesión **y** para cada comando, así que el tracker no tenía de dónde
  sacar el repo. Donde de verdad trabajaban lo decían sus transcripts:
  `claude-91fe7dcc` en `neural-creature-arena`, con `cd` y 38 líneas con ese
  `cwd`; `codex-01a0d5a8` en `clase-transcripciones`, con
  `workdir:"…/clase-transcripciones"` en cada `exec_command`.
- **Codex 0.156** escribe las opciones como `"workdir":"…"`, con la clave entre
  comillas, y un `codex exec` corto hace todo en **una** llamada: 1 mención, por
  debajo del mínimo de 3.
- **1:** los eventos del mapa son fire-and-forget. En headless el WS nunca
  autenticó: `onopen` llegaba después de los 5 s del servidor, porque el hilo
  principal estaba ocupado con el mapa 3D por software. El cliente caía a SSE, y
  el chequeo de salud lo recreaba cada ~15 s. Un evento que caía en ese hueco se
  perdía hasta la siguiente reconexión o recarga. En el navegador real del
  usuario el WS sí autentica (conexión establecida y persistente), así que ahí
  la causa exacta no quedó reproducida. La re-sincronización periódica lo cubre
  igual.

## Fix

| Pieza | Qué hace |
|---|---|
| `server/transcript_work.py` | Últimas 60 tool calls del transcript nativo. Claude: `cwd` por línea, `file_path`/`path`, rutas absolutas de Bash. Codex: `workdir` (con o sin comillas), rutas de cada `cmd`, cabeceras de `apply_patch`. Nunca contenidos, cuerpos de parche, salidas ni prompts |
| `SuvaduSource` | Pega esas carpetas como `work_dirs`. Relee el transcript solo si cambia `(mtime, size)` |
| tracker | Con el `cwd` fuera de todo repo, **1 mención** basta. Contra un `cwd` dentro de un repo siguen haciendo falta 3. Un cambio de ciudad emite `unit_relocate` |
| frontend | `unit_relocate` hace **caminar** la unidad (`GameState.walkUnitTo`; un `unit_state` en camino espera la llegada). La réplica del snapshot corre también **cada 10 s** y no emite nada si todo coincide |

## Verificación

- TDD: todos los tests nuevos en rojo primero (extractor, comillas, 1 mención,
  memo del transcript, relocate en el tracker; schema, caminata, estado en
  camino, réplica sin ruido y poll periódico en el frontend).
- Sesiones reales, con tracker local: `claude-91fe7dcc` → neural-creature-arena,
  `codex-01a0d5a8` → clase-transcripciones, `codex-01a0d5c0` → cdaily (antes,
  capital).
- **E2E real:** `codex exec -s read-only` desde `~` sobre `ACTIVE/adw-canvas`. El
  tracker lo ubicó en **adw-canvas**, y el usuario lo vio aparecer junto a esa
  ciudad en su navegador (no en la capital).
- Gate `scripts/check.sh`: tsc, eslint, prettier, vitest (1023), build, ruff y
  budgets en verde. pytest: 1181 passed y los mismos 24 fallos preexistentes de
  `main` (3121d1b).

## Límites

- Cursor y OpenCode siguen ubicados por su `cwd`.
- La unidad aparece en el anillo alrededor de la ciudad
  (`pickDetachmentHex`), no sobre la casilla de la ciudad.
- Correr el gate reescribe `coverage/`, y el watcher de Vite recarga la página
  abierta. No es parte de este fix.
