// ─── RepoCiv — Task Panel (Sprint C3) ────────────────────────────────────────
// Side panel listing all active and recent tasks from the task orchestrator.
// Shows: repo | issue | phase | progress | age, with colour-coding by phase.
// Polls every 3s while open; provides a Cancel button per task.
import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';

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

// ─── Public API ───────────────────────────────────────────────────────────────
export function openTaskPanel(): void {
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

async function _fetch(): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/tasks'), { headers: bridgeHeaders() });
    if (!res.ok) {
      _offline = true;
      if (_visible) _render();
      return;
    }
    _tasks = (await res.json()) as Task[];
    _offline = false;
    if (_visible) _render();
  } catch {
    _offline = true;
    if (_visible) _render();
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

// ─── Render ───────────────────────────────────────────────────────────────────
function _render(): void {
  const panel = _getOrCreate();
  const body = panel.querySelector<HTMLElement>('.task-body')!;

  if (_offline) {
    body.innerHTML = '<div class="task-offline">⚠ Bridge offline — sin datos</div>';
    return;
  }

  if (_tasks.length === 0) {
    body.innerHTML = '<div class="task-empty">Sin tareas registradas</div>';
    return;
  }

  body.innerHTML = `
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
  `;

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
      <td class="task-issue" title="${_esc(t.issueId)}">${_esc(t.issueId)}</td>
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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  _panel = ensurePanel(
    'task-panel',
    'task-panel hidden',
    `
    <div class="task-header">
      <span class="task-title">📋 TAREAS</span>
      <button id="task-close" title="Cerrar panel de tareas" aria-label="Cerrar panel de tareas">✕</button>
    </div>
    <div class="task-body"></div>
    `,
  );
  bindPanelAction(_panel, '#task-close', closeTaskPanel);
  return _panel;
}
