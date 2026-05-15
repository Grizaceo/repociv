# RepoCiv Fix Plan — Próxima Sesión
> Generado 2026-05-13 por gstack audit + shellcheck
> Base commit: d6b350e (main limpio, eslint verde)

## Estado de partida
- `main` está limpio: tsc, eslint (max-warnings=0), vitest (314 tests), pytest (544 tests), vite build pasan.
- Shellcheck instalado en `/tmp/shellcheck-stable/shellcheck` (pendiente: mover a PATH o install permanente).

---

## Fase 1: Shellcheck (5 min)

Archivo: `scripts/backup-events.sh`
- L41: `EXCESS=$(ls -t "$BACKUP_DIR"...` → reemplazar `ls -t` por `find + sort` o silenciar SC2012 con `# shellcheck disable=SC2012` si el contexto es controlado.
- L48: `$(ls "$BACKUP_DIR"... | wc -l)` → igual, `find` + `wc -l` o disable.

Archivo: `scripts/dev-start.sh`
- L117: `for i in $(seq 1 20); do` → `i` no se usa en el loop (es un retry/sleep). Reemplazar por `for _ in $(seq 1 20)` o usar `i` en un echo de intento.

Archivo: `scripts/dev-stop.sh`
- L7: `REPO_ROOT` se setea pero nunca se usa. Eliminar línea o usarla en un path absoluto si estaba pensada.

---

## Fase 2: Dead exports / code cleanup con knip (15–30 min)

Contexto: knip no está instalado. Opciones:
- **A)** `npm install -D knip`, correr `npx knip`, revisar reporte export por export.
- **B)** Revisión manual: buscar exports en `src/` que ningún otro archivo importe.

Candidatos a revisar (por tamaño sin referencias externas obvias):
- `src/ui/chat.ts` — 799 líneas. Tiene muchas funciones internas; verificar si alguna está exportada sin uso fuera.
- `src/bridgeEnv.ts`, `src/commandBus.ts`, `src/manualLayout.ts` — archivos pequeños, verificar referencias.
- `server/` — Python no tiene knip. Revisar con `grep` si funciones públicas de módulos gordos (`task_orchestrator.py`, `bridge.py`) se usan fuera.

---

## Fase 3: Calidad estructural gstack (10 min, opcional)

- Crear `CLAUDE.md` en raíz con skill routing rules (copiar template del skill `gstack-review`).
- Inicializar `.gstack/qa-reports/` con baseline para futuros `/qa-only`.
- Considerar agregar `shellcheck` al pre-commit si se arreglan los scripts.

---

## Orden recomendado de ejecución

1. Fix shellcheck (3 archivos, 4 líneas) → commit `chore(scripts): pasa shellcheck limpio`.
2. Instalar knip → correr `npx knip` → revisar dead exports → fix → commit `chore(deps): limpia dead exports`.
3. Opcional: `CLAUDE.md` + skill routing → commit `docs: agrega skill routing para gstack`.

---

## Notas
- No tocar lógica de negocio. Solo estilo, lint y cleanup.
- Si knip reporta falsos positivos (ej: exports usados por reflexión o eval), documentar en `knip.json` en vez de borrar.
- Shellcheck path temporal: `/tmp/shellcheck-stable/shellcheck`. Para sesiones futuras, verificar si existe; si no, re-download.
