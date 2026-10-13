// Git observations, not edit attribution. Rendered by the Activity panel's existing poll.
import * as v from 'valibot';

const count = v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0));
const time = v.nullable(count);
const entrySchema = v.object({
  repoPath: v.string(),
  repoName: v.string(),
  worktreePath: v.string(),
  branch: v.string(),
  detached: v.boolean(),
  head: v.string(),
  state: v.picklist(['dirty', 'clean', 'unavailable']),
  stagedCount: count,
  unstagedCount: count,
  untrackedCount: count,
  conflictCount: count,
  changedCount: count,
  files: v.array(v.object({ path: v.string(), index: v.string(), worktree: v.string() })),
  firstObservedAtMs: time,
  lastObservedAtMs: time,
  ageMs: time,
  relatedSessions: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      status: v.string(),
      lastActivityAtMs: time,
    }),
  ),
  error: v.optional(v.string()),
});
const snapshotSchema = v.object({
  available: v.boolean(),
  sampledAtMs: count,
  entries: v.array(entrySchema),
  errors: v.array(v.string()),
  persistenceError: v.optional(v.string()),
});
export type PendingWorkEntry = v.InferOutput<typeof entrySchema>;
export type PendingWorkSnapshot = v.InferOutput<typeof snapshotSchema>;

export function parsePendingWork(raw: unknown): PendingWorkSnapshot {
  const parsed = v.safeParse(snapshotSchema, raw);
  if (!parsed.success) throw new Error('Respuesta de trabajo pendiente inválida');
  if (!parsed.output.available) throw new Error('Inventario de trabajo pendiente no disponible');
  return parsed.output;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function age(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (!minutes) return 'menos de 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}
function date(ms: number): string {
  return new Date(ms).toLocaleString('es-CL');
}
function order(a: PendingWorkEntry, b: PendingWorkEntry): number {
  const priority = (entry: PendingWorkEntry) =>
    entry.state === 'dirty' ? (entry.conflictCount ? 0 : 1) : 2;
  return (
    priority(a) - priority(b) ||
    (a.firstObservedAtMs ?? Number.MAX_SAFE_INTEGER) -
      (b.firstObservedAtMs ?? Number.MAX_SAFE_INTEGER) ||
    a.worktreePath.localeCompare(b.worktreePath)
  );
}
function card(entry: PendingWorkEntry): string {
  const id = esc(`${entry.worktreePath}:${entry.branch}:${entry.detached}`);
  const branch = entry.detached
    ? `HEAD separado · ${entry.head.slice(0, 12) || 'sin commit'}`
    : entry.branch || 'rama sin nombre';
  return `<article class="pending-work-card" data-worktree="${esc(entry.worktreePath)}">
    <h4>${esc(entry.repoName)} <span>${esc(branch)}</span></h4>
    <code class="pending-work-path">${esc(entry.worktreePath)}</code>
    ${
      entry.state === 'unavailable'
        ? `<p role="status" class="pending-work-warning">Estado Git no disponible: ${esc(entry.error || 'No se pudo observar')}</p>`
        : `<p>${entry.changedCount} archivos con cambios · ${entry.stagedCount} staged · ${entry.unstagedCount} sin stage · ${entry.untrackedCount} nuevos${entry.conflictCount ? ` · <strong>${entry.conflictCount} conflictos</strong>` : ''}</p>`
    }
    ${entry.state !== 'clean' ? `<p class="pending-work-age">${entry.firstObservedAtMs === null ? 'Antigüedad observada no disponible' : `${entry.state === 'unavailable' ? 'Último episodio conocido' : 'Observado con cambios'} desde ${esc(date(entry.firstObservedAtMs))}${entry.ageMs === null ? '' : ` · ${age(entry.ageMs)}`}${entry.state === 'unavailable' ? ' — no confirma el estado actual' : ''}`}</p>` : ''}
    <details data-detail-id="pending-sessions:${id}"><summary data-focus-id="pending-sessions:${id}">Sesiones relacionadas · ${entry.relatedSessions.length} — no acredita autoría</summary>
      ${entry.relatedSessions.length ? `<ul>${entry.relatedSessions.map((session) => `<li>${esc(session.name || session.id)} · ${esc(session.status || 'estado no disponible')}${session.lastActivityAtMs === null ? '' : ` · última actividad ${esc(date(session.lastActivityAtMs))}`}<code>${esc(session.id)}</code></li>`).join('')}</ul>` : '<p>Sin sesiones relacionadas en el registro disponible; esto no prueba inactividad.</p>'}
    </details>
    <details data-detail-id="pending-files:${id}"><summary data-focus-id="pending-files:${id}">Archivos · ${entry.files.length}${entry.files.length < entry.changedCount ? ` de ${entry.changedCount} — lista limitada` : ''}</summary>
      <p>Estado Git: índice / worktree. Staged y sin stage pueden contar el mismo archivo.</p>
      <ul class="pending-work-files">${entry.files.map((file) => `<li><code>${esc(file.index)}${esc(file.worktree)}</code> <code>${esc(file.path)}</code></li>`).join('')}</ul>
    </details>
  </article>`;
}

export function renderPendingWork(data: PendingWorkSnapshot | null, fetchError: string): string {
  const heading = '<h3>Trabajo pendiente · Git</h3>';
  const warning = fetchError
    ? `<p role="status" class="pending-work-warning">⚠ Inventario pendiente no disponible${data ? ' — datos anteriores posiblemente desactualizados' : ''}: ${esc(fetchError)}</p>`
    : '';
  if (!data)
    return `<section class="pending-work" aria-label="Trabajo pendiente">${heading}${warning || '<p role="status">Cargando trabajo pendiente…</p>'}</section>`;
  const pending = data.entries.filter((entry) => entry.state !== 'clean').sort(order);
  const clean = data.entries.filter((entry) => entry.state === 'clean');
  const dirtyCount = pending.filter((entry) => entry.state === 'dirty').length;
  const unavailableCount = pending.length - dirtyCount;
  return `<section class="pending-work" aria-label="Trabajo pendiente">${heading}${warning}
    <p class="pending-work-summary">${dirtyCount} worktrees con cambios · ${clean.length} limpios · ${unavailableCount} no disponibles · ${data.entries.length} observados</p>
    <p class="activity-note">Antigüedad observada, no edad real de los cambios. Muestreo al abrir este panel; no cubre ramas sin worktree ni cambios entre muestras. Sesiones relacionadas ≠ autores.</p>
    <p class="activity-note">Última muestra: ${esc(date(data.sampledAtMs))}.</p>
    ${data.persistenceError ? `<p role="status" class="pending-work-warning">⚠ Persistencia: ${esc(data.persistenceError)}. La antigüedad podría no conservarse al reiniciar.</p>` : ''}
    ${data.errors.map((error) => `<p role="status" class="pending-work-warning">⚠ ${esc(error)}</p>`).join('')}
    ${pending.map(card).join('')}
    ${!dirtyCount && !unavailableCount && !data.errors.length ? '<p>Sin cambios sin commit en los worktrees observados.</p>' : ''}
    ${clean.length ? `<details data-detail-id="pending-clean"><summary data-focus-id="pending-clean">Worktrees limpios · ${clean.length}</summary>${clean.map(card).join('')}</details>` : ''}
  </section>`;
}
