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
  activityEvents,
  activitySelection,
  eventKey,
  processKey,
  selectActivity,
  setActivityProcesses,
  subscribeActivity,
  markActivityInventoryUnavailable,
} from './activityCorrelation.ts';

const POLL_MS = 3_000;

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

let _fetching = false;
async function _fetch(loadHistory = true): Promise<void> {
  if (_fetching) return;
  _fetching = true;
  try {
    await _fetchProcesses();
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
    body.innerHTML = html;
    return true;
  };

  const focusKey = (document.activeElement as HTMLElement | null)?.dataset['focusId'];
  const restore = () => {
    if (focusKey)
      Array.from(body.querySelectorAll<HTMLButtonElement>('[data-activity]'))
        .find((b) => b.dataset['focusId'] === focusKey)
        ?.focus({ preventScroll: true });
  };
  // Strings from the bridge are escaped; process identifiers/counts are numeric.
  const processes = `<section class="agent-process-list"><h3>Procesos de agentes (${_processes.length})</h3>
    <p>Usuario local · agentes reconocidos y todos sus descendientes. Estado del SO, no progreso de tareas.</p>
    ${_processError ? `<div role="status">⚠ ${_esc(_processError)} — los datos anteriores pueden estar desactualizados</div>` : ''}
    ${_unreadable ? `<p>${_unreadable} procesos no legibles o terminados durante el muestreo</p>` : ''}
    <table class="task-table" aria-label="Procesos relacionados con agentes"><thead><tr><th>PID</th><th>PPID</th><th>Agente</th><th>Proceso</th><th>Estado SO</th><th>Vínculo</th></tr></thead><tbody>
    ${_processes.map((p) => `<tr data-process-pid="${p.pid}"><td>${_processButton(p)}</td><td>${p.ppid}</td><td>${_esc(p.family)}</td><td>${_esc(p.name)}</td><td>${_esc(p.state)}</td><td>${p.role === 'agent' ? 'Agente' : `Descendiente de ${p.rootPid}`}</td></tr>`).join('')}
    </tbody></table>${!_processes.length && !_processError ? '<p>Sin procesos de agentes detectados</p>' : ''}</section>`;
  const context = _activityContext();
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
      <span class="task-title">📋 ACTIVIDAD · TAREAS ACTIVAS</span>
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
  });
  bindPanelAction(_panel, '#task-close', closeTaskPanel);
  return _panel;
}

function _activityButton(key: string, label: string, focusId = key): string {
  return `<button data-focus-id="${_esc(focusId)}" data-activity="${_esc(key)}" aria-pressed="${activitySelection() === key}" style="--activity-color:${activityColor(key)}">⬡ ${_esc(label)}</button>`;
}
function _processButton(p: AgentProcess): string {
  const key = processKey(p);
  return key
    ? _activityButton(key, `PID ${p.pid} · ${key}`, `pid:${p.processIdentity}`)
    : `<button data-focus-id="pid:${_esc(p.processIdentity || String(p.pid))}" data-activity="process:${_esc(p.processIdentity || `unknown-${p.pid}`)}">PID ${p.pid} · sin correlación</button>`;
}
function _activityContext(): string {
  const selected = activitySelection();
  const keys = [
    ...new Set(
      activityEvents()
        .map((e) => eventKey(e))
        .filter(Boolean),
    ),
  ];
  return `<div class="activity-context" role="status">${_esc(selected || 'Todas las ejecuciones')}</div><p>Kanban ≠ ejecución del orquestador ≠ sesión de agente ≠ proceso del SO. run: identifica un comando, no necesariamente una ejecución del orquestador. Los tableros y sesiones siguen en sus paneles; sin vínculo explícito, sin correlación.</p><details><summary>Comandos y ejecuciones registrados en la Crónica</summary>${keys.map((k) => _activityButton(k, k, `history:${k}`)).join(' ')}</details>`;
}
export async function refreshTaskInventory(): Promise<void> {
  await _fetch(false);
}

registerActivityPanel('tasks', {
  open: openTaskPanel,
  close: closeTaskPanel,
  refresh: refreshTaskInventory,
});
