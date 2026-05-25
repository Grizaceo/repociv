// ─── RepoCiv — Task Assignment Panel (frontend-only) ─────────────────────────
// Hotkey: J — lets the player assign a task focus to each local agent.
// Follows the panelShell.ts pattern.

import type { LocalUnit, AgentTask } from '../types.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';

const POLL_MS = 250;

const TASK_OPTIONS: { value: AgentTask; label: string }[] = [
  { value: 'explore', label: 'Explorar' },
  { value: 'plan', label: 'Planear' },
  { value: 'debug', label: 'Debug' },
  { value: 'code', label: 'Code' },
  { value: 'adversarial_review', label: 'Adversarial Review' },
];

const STATUS_ICON: Record<string, string> = {
  idle_in_room: '◌',
  walking_to_workbench: '→',
  walking_to_room: '→',
  working_on_file: '⚙',
  resting: '☾',
};

// ─── Module state ─────────────────────────────────────────────────────────────
let _panel: HTMLElement | null = null;
let _visible = false;
let _timer = 0;
let _getUnits: (() => LocalUnit[]) | null = null;
let _setTask: ((unitId: string, task: AgentTask | null) => void) | null = null;
let _lastSnapshot = '';

// ─── Public API ───────────────────────────────────────────────────────────────
export function openTaskAssignPanel(
  getUnits: () => LocalUnit[],
  setTask: (unitId: string, task: AgentTask | null) => void,
): void {
  _getUnits = getUnits;
  _setTask = setTask;
  _visible = true;
  showPanel(_getOrCreate());
  _render();
  _startPolling();
}

export function closeTaskAssignPanel(): void {
  _visible = false;
  _stopPolling();
  if (_panel) hidePanel(_panel);
}

export function isTaskAssignPanelOpen(): boolean {
  return _visible;
}

export function toggleTaskAssignPanel(
  getUnits?: () => LocalUnit[],
  setTask?: (unitId: string, task: AgentTask | null) => void,
): void {
  if (_visible) {
    closeTaskAssignPanel();
  } else {
    if (!getUnits || !setTask) return;
    openTaskAssignPanel(getUnits, setTask);
  }
}

// ─── Polling ──────────────────────────────────────────────────────────────────
function _startPolling(): void {
  _stopPolling();
  _timer = window.setInterval(() => {
    if (_visible) _render();
  }, POLL_MS);
}

function _stopPolling(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = 0;
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function _render(): void {
  const panel = _getOrCreate();
  const body = panel.querySelector<HTMLElement>('.task-assign-body')!;
  const units = _getUnits ? _getUnits() : [];

  // Only rebuild DOM if data changed (compare lightweight snapshot)
  const snapshot = units
    .map((u) => `${u.id}|${u.state}|${u.fatigue}|${u.assignedTask ?? ''}`)
    .join(';');
  if (snapshot === _lastSnapshot) return;
  _lastSnapshot = snapshot;

  if (units.length === 0) {
    body.innerHTML = '<div class="task-assign-empty">Sin agentes en sector</div>';
    return;
  }

  body.innerHTML = units
    .map((u) => {
      const fatiguePct = Math.round((u.fatigue / u.maxFatigue) * 100);
      const icon = STATUS_ICON[u.state] ?? '?';
      const optionsHtml = TASK_OPTIONS.map(
        (opt) =>
          `<option value="${opt.value}" ${u.assignedTask === opt.value ? 'selected' : ''}>${opt.label}</option>`,
      ).join('');

      return `
      <div class="task-assign-row" data-unit-id="${u.id}">
        <div class="task-assign-main">
          <span class="task-assign-icon" style="color:${u.color}">${icon}</span>
          <span class="task-assign-name" style="color:${u.color}">${_esc(u.name)}</span>
          <span class="task-assign-state">${_esc(u.state.replace(/_/g, ' '))}</span>
        </div>
        <div class="task-assign-meta">
          <div class="task-assign-fatigue" title="Fatiga ${fatiguePct}%">
            <div class="task-assign-fatigue-bar" style="width:${fatiguePct}%"></div>
          </div>
          <select class="task-assign-select" data-unit-id="${u.id}">
            <option value="" ${!u.assignedTask ? 'selected' : ''}>— Auto —</option>
            ${optionsHtml}
          </select>
        </div>
      </div>
    `;
    })
    .join('');

  // Wire select handlers
  body.querySelectorAll<HTMLSelectElement>('.task-assign-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const unitId = sel.dataset['unitId'] ?? '';
      const value = sel.value as AgentTask | '';
      if (_setTask) _setTask(unitId, value || null);
      // Update snapshot so next poll doesn't clobber the visual selection
      _lastSnapshot = '';
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  _panel = ensurePanel(
    'task-assign-panel',
    'task-assign-panel hidden',
    `
    <div class="task-assign-header">
      <span class="task-assign-title">ASIGNAR TAREAS</span>
      <button id="task-assign-close" title="Cerrar [J]" aria-label="Cerrar panel de asignación">✕</button>
    </div>
    <div class="task-assign-body"></div>
    `,
  );
  bindPanelAction(_panel, '#task-assign-close', closeTaskAssignPanel);
  return _panel;
}
