// ─── RepoCiv — Task Panel (Sprint C3) ────────────────────────────────────────
// Agent processes (local UID, recognized entrypoints + every descendant) and
// orchestrator tasks, kept distinct. Uses the existing 3s polling while open;
// process metadata never contains argv/env and offers no process kill action.
import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';

import {
  activityColor,
  activityPanels,
  registerActivityPanel,
  activitySelection,
  selectActivity,
  setActivityProcesses,
  subscribeActivity,
  markActivityInventoryUnavailable,
} from './activityCorrelation.ts';

import {
  presentActivities,
  activityTitle,
  type PresentedActivity,
} from './activityPresentation.ts';
import { focusOwnChat } from './agentsPanel.ts';

import { parsePendingWork, renderPendingWork, type PendingWorkSnapshot } from './pendingWork.ts';

const POLL_MS = 3_000;
let _pendingWork: PendingWorkSnapshot | null = null;
let _pendingError = '';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Task {
  key: string;
  repo: string;
  issueId: string;
  phase: string;
  stepCurrent: number | null;
  stepCount: number | null;
  startedAt: string;
  updatedAt: string;
}

// ─── Phase style ─────────────────────────────────────────────────────────────
const _PHASE_COLORS: Record<string, string> = {
  executing: '#4a9ade',
  complete: '#5b9b5b',
  failed: '#d44b4b',
  circuit_open: '#e8a040',
  cancelled: '#888',
  queued: '#9b8b5b',
  planned: '#7a7ade',
  spec: '#9a6ade',
  init: '#aaa',
};

function _phaseColor(phase: string): string {
  return _PHASE_COLORS[phase] ?? '#888';
}

// ─── Module state ─────────────────────────────────────────────────────────────
let _panel: HTMLElement | null = null;
let _timer = 0;
let _visible = false;
let _tasks: Task[] = [];
let _offline = false;
interface AgentProcess {
  pid: number;
  ppid: number;
  rootPid: number;
  name: string;
  state: string;
  family: string;
  role: string;
  processIdentity?: string | null;
}
let _processes: AgentProcess[] = [];
let _processError = '';
let _unreadable = 0;

// ─── Public API ───────────────────────────────────────────────────────────────
export function openTaskPanel(): void {
  activityPanels.log?.close();
  _visible = true;
  showPanel(_getOrCreate());
  void _fetch();
  _startPolling();
}

export function closeTaskPanel(): void {
  _visible = false;
  _stopPolling();
  if (_panel) hidePanel(_panel);
}

export function isTaskPanelOpen(): boolean {
  return _visible;
}

export function toggleTaskPanel(): void {
  if (_visible) closeTaskPanel();
  else openTaskPanel();
}

// ─── Polling ──────────────────────────────────────────────────────────────────
function _startPolling(): void {
  _stopPolling();
  _timer = window.setInterval(() => {
    void _fetch();
  }, POLL_MS);
}

function _stopPolling(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = 0;
  }
}

async function _fetchProcesses(): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/api/agent-processes'), { headers: bridgeHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.available) throw new Error('Inventario no disponible');
    _processes = data.processes;
    _unreadable = data.unreadable;
    _processError = '';
    setActivityProcesses(_processes);
  } catch (err) {
    _processError = err instanceof Error ? err.message : String(err);
    markActivityInventoryUnavailable();
  }
}

async function _fetchPendingWork(): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/api/pending-work'), {
      headers: bridgeHeaders(),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _pendingWork = parsePendingWork(await res.json());
    _pendingError = '';
  } catch (error) {
    _pendingError = error instanceof Error ? error.message : String(error);
  }
}

let _fetching = false;
async function _fetch(loadHistory = true): Promise<void> {
  if (_fetching) return;
  _fetching = true;
  try {
    await Promise.all([_fetchProcesses(), _fetchPendingWork()]);
    try {
      const res = await fetch(bridgeUrl('/tasks'), { headers: bridgeHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      _tasks = (await res.json()) as Task[];
      _offline = false;
    } catch {
      _offline = true;
    }
    if (loadHistory) await activityPanels.log?.refresh();
    if (_visible) _render();
  } finally {
    _fetching = false;
  }
}

async function _cancelTask(key: string): Promise<void> {
  try {
    // Encode key for URL: replace "::" with "/" segment
    const urlKey = encodeURIComponent(key);
    await fetch(bridgeUrl(`/tasks/${urlKey}/cancel`), {
      method: 'POST',
      headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
      body: '{}',
    });
    // Refresh after cancel
    void _fetch();
  } catch {
    // Ignore cancel errors — UI will refresh on next poll
  }
}

let _lastRendered = '';

// ─── Render ───────────────────────────────────────────────────────────────────
function _render(): void {
  const panel = _getOrCreate();
  const body = panel.querySelector<HTMLElement>('.task-body')!;
  const replace = (html: string): boolean => {
    if (html === _lastRendered) return false;
    _lastRendered = html;
    const open = new Set(
      Array.from(body.querySelectorAll<HTMLDetailsElement>('details[open]')).map(
        (d) => d.dataset['detailId'],
      ),
    );
    const scroll = body.scrollTop;
    body.innerHTML = html;
    body.querySelectorAll<HTMLDetailsElement>('details').forEach((d) => {
      d.open = open.has(d.dataset['detailId']);
    });
    body.scrollTop = scroll;
    return true;
  };

  const focusKey = (document.activeElement as HTMLElement | null)?.dataset['focusId'];
  const restore = () => {
    if (focusKey)
      Array.from(body.querySelectorAll<HTMLElement>('[data-focus-id]'))
        .find((b) => b.dataset['focusId'] === focusKey)
        ?.focus({ preventScroll: true });
  };
  const activities = presentActivities(_processes);
  const processes = `<section class="agent-process-list"><h3>Actividades · ${activities.length} grupos / ${_processes.length} procesos</h3>
    ${_processError ? '<p role="status">⚠ Inventario no disponible — datos anteriores posiblemente desactualizados</p>' : ''}
    ${_unreadable ? `<p>${_unreadable} procesos no legibles o terminados durante el muestreo</p>` : ''}
    <div class="activity-list">${activities.map(_activityCard).join('')}</div>
    ${!activities.length ? '<p>Sin actividades en el inventario y la historia cargada</p>' : ''}</section>`;
  const context = renderPendingWork(_pendingWork, _pendingError) + _activityContext();
  if (_offline) {
    replace(context + processes + '<div class="task-offline">⚠ Orquestador no disponible</div>');
    restore();
    return;
  }

  if (_tasks.length === 0) {
    replace(
      context +
        processes +
        '<div class="task-empty">Sin tareas registradas en el orquestador</div>',
    );
    restore();
    return;
  }

  if (
    !replace(
      context +
        processes +
        `
    <h3>Tareas del orquestador</h3>
    <table class="task-table" aria-label="Lista de tareas activas">
      <thead>
        <tr>
          <th>Repo</th>
          <th>Issue</th>
          <th>Fase</th>
          <th>Progreso</th>
          <th>Edad</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${_tasks.map((t) => _taskRow(t)).join('')}
      </tbody>
    </table>
  `,
    )
  )
    return;

  restore();
  // Wire cancel buttons
  body.querySelectorAll<HTMLButtonElement>('.task-btn-cancel').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset['key'] ?? '';
      if (key) void _cancelTask(key);
    });
  });
}

function _taskRow(t: Task): string {
  const color = _phaseColor(t.phase);
  const progress = _progressBar(t.stepCurrent, t.stepCount);
  const age = _age(t.startedAt || t.updatedAt);
  const canCancel = !['complete', 'failed', 'cancelled'].includes(t.phase);

  return `
    <tr class="task-row">
      <td class="task-repo" title="${_esc(t.repo)}">${_esc(t.repo.slice(0, 12))}</td>
      <td class="task-issue" title="${_esc(t.issueId)}">${_activityButton(`task:${t.key}`, t.issueId)}</td>
      <td class="task-phase">
        <span class="task-phase-badge" style="background:${color}22;border-color:${color};color:${color}">${_esc(t.phase)}</span>
      </td>
      <td class="task-progress">${progress}</td>
      <td class="task-age">${_esc(age)}</td>
      <td class="task-actions">
        ${
          canCancel
            ? `<button class="task-btn-cancel" data-key="${_esc(t.key)}" title="Cancelar tarea" aria-label="Cancelar tarea ${_esc(t.issueId)}">✕</button>`
            : ''
        }
      </td>
    </tr>
  `;
}

function _progressBar(current: number | null, total: number | null): string {
  if (current == null || total == null || total === 0) {
    return '<span class="task-progress-na">—</span>';
  }
  const pct = Math.round((current / total) * 100);
  return `
    <div class="task-progress-wrap" title="${current}/${total} (${pct}%)">
      <div class="task-progress-bar" style="width:${pct}%"></div>
      <span class="task-progress-label">${current}/${total}</span>
    </div>
  `;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _age(isoStr: string): string {
  if (!isoStr) return '—';
  try {
    const ms = Date.now() - new Date(isoStr).getTime();
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  } catch {
    return '—';
  }
}

function _esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  _panel = ensurePanel(
    'task-panel',
    'task-panel hidden',
    `
    <div class="task-header">
      <span class="task-title">📋 ACTIVIDAD · EJECUCIONES</span>
      <button id="task-close" title="Cerrar panel de tareas" aria-label="Cerrar panel de tareas">✕</button>
    </div>
    <nav class="activity-nav" aria-label="Actividad"><button class="activity-log">Crónica de la selección</button><button class="activity-reset">Todas las ejecuciones</button></nav>
    <div class="task-body"></div>
    `,
  );
  subscribeActivity(() => {
    if (_visible) _render();
  });
  bindPanelAction(_panel, '.activity-log', () => activityPanels.log?.open());
  bindPanelAction(_panel, '.activity-reset', () => selectActivity(''));
  _panel.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-activity]');
    if (button) selectActivity(button.dataset['activity'] ?? '');
    const chronicle = (e.target as HTMLElement).closest<HTMLElement>('[data-chronicle]');
    if (chronicle) {
      selectActivity(chronicle.dataset['chronicle'] ?? '');
      activityPanels.log?.open();
    }
    const unit = (e.target as HTMLElement).closest<HTMLElement>('[data-unit]');
    if (unit?.dataset['unit']) {
      closeTaskPanel();
      focusOwnChat(unit.dataset['unit']);
    }
  });
  bindPanelAction(_panel, '#task-close', closeTaskPanel);
  return _panel;
}

function _activityButton(key: string, label: string, focusId = key): string {
  return `<button data-focus-id="${_esc(focusId)}" data-activity="${_esc(key)}" aria-pressed="${activitySelection() === key}" style="--activity-color:${activityColor(key)}">⬡ ${_esc(label)}</button>`;
}
function _activityCard(a: PresentedActivity): string {
  const roots = a.processes.filter((p) => !a.processes.some((parent) => parent.pid === p.ppid));
  return `<article class="activity-card" data-run="${_esc(a.id)}" style="--activity-color:${activityColor(a.key)}">
    <div class="activity-card-heading">${_activityButton(a.key, a.title, `card:${a.id}`)}<span class="activity-state">${_esc(a.status)}</span></div>
    <div class="activity-owner">${a.unit ? `Unidad: ${_esc(a.unitName || (a.title === a.unit ? a.unit : 'vinculada'))}` : 'Sin unidad vinculada'} · ${a.agent ? `Agente: ${_esc(a.agent)}` : !a.profile ? 'Propietario desconocido' : 'Agente no registrado'}</div>
    <div class="activity-meta"><span>Harness: ${_esc(a.harness || 'no acreditado')}</span><span>Profile: ${_esc(a.profile || 'desconocido')}</span><span>${a.task ? 'Tarea vinculada' : 'Sin tarea vinculada en la historia cargada'}</span></div>
    ${a.identityWarning ? `<p class="activity-warning">⚠ ${_esc(a.identityWarning)}</p>` : ''}
    ${!a.commandId ? `<p class="activity-note">Familia detectada: ${_esc(a.processes[0]?.family || 'no disponible')}.</p>` : ''}
    <div class="activity-card-actions"><button data-chronicle="${_esc(a.key)}" data-focus-id="chronicle:${_esc(a.id)}">Ver Crónica</button>${a.unit ? `<button data-unit="${_esc(a.unit)}" data-focus-id="unit:${_esc(a.id)}">Ver unidad</button>` : ''}</div>
    <details data-detail-id="processes:${_esc(a.id)}"><summary data-focus-id="expand:${_esc(a.id)}">${a.processes.length} procesos · ${roots.length} raíces observadas${a.processes.length ? ` · ${a.processes.length - roots.length} descendientes` : ' · sin procesos en el último inventario'}</summary>
    <ul class="activity-process-tree">${a.processes.map((p) => `<li data-process-pid="${p.pid}">${_activityButton(a.key, `PID ${p.pid} ← PPID ${p.ppid} · ${p.name}`, `pid:${p.processIdentity || p.pid}`)}<span>Estado SO: ${_esc(p.state)}${roots.includes(p) ? ' · raíz observada' : ' · descendiente'}</span><code>${_esc(p.processIdentity || 'Identidad de proceso no disponible')}</code></li>`).join('')}</ul></details>
    <details data-detail-id="technical:${_esc(a.id)}"><summary data-focus-id="technical:${_esc(a.id)}">Identificadores y evidencia</summary><dl><dt>Selección compartida</dt><dd><code>${_esc(a.key)}</code></dd><dt>Comando / ejecución</dt><dd>${_esc(a.commandId || 'Sin ejecución vinculada')}</dd><dt>Unidad</dt><dd><code>${_esc(a.unit || 'Sin unidad vinculada')}</code></dd><dt>Sesión</dt><dd>Sin enlace canónico a una sesión nativa en esta proyección</dd><dt>Identidad al inicio</dt><dd>${a.registered ? 'Registro canónico del runner' : 'Datos no disponibles en la historia cargada'}</dd><dt>Historia</dt><dd>${a.events.length} eventos cargados · no acredita historia completa</dd></dl>${a.events
      .filter((e) => e.type === 'ExecutionIdentityRecorded')
      .map(
        (e) =>
          `<p class="activity-note">Intento registrado · harness: ${_esc(String(e.data?.['harness'] || 'no disponible'))} · profile: ${_esc(String(e.data?.['profileName'] || 'no registrado'))} · proveedor seleccionado: ${_esc(String(e.data?.['provider'] || 'no registrado'))} · modelo seleccionado: ${_esc(String(e.data?.['model'] || 'no registrado'))}</p>`,
      )
      .join('')}</details>
  </article>`;
}
function _activityContext(): string {
  return `<div class="activity-context" role="status">${_esc(activityTitle(activitySelection()))}</div><p class="activity-note">Identidad registrada al inicio · procesos observados ahora. Un árbol externo no acredita propietario ni trabajo activo. Sin proceso no significa éxito.</p>`;
}
export async function refreshTaskInventory(): Promise<void> {
  await _fetch(false);
}

registerActivityPanel('tasks', {
  open: openTaskPanel,
  close: closeTaskPanel,
  refresh: refreshTaskInventory,
});
