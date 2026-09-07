// ─── RepoCiv — Hermes Kanban Panel ───────────────────────────────────────────
// Native read-only view of the Hermes kanban (SQLite stores read by the
// bridge). Columns mirror the canonical BOARD_COLUMNS; mutations stay in
// `hermes kanban ...` / the Hermes dashboard.
import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';
import { trackPanelOpen } from './analytics.ts';

const POLL_MS = 8000;

const COLUMN_LABELS: Record<string, string> = {
  triage: 'Triage',
  todo: 'Por hacer',
  scheduled: 'Programado',
  ready: 'Listo',
  running: 'En curso',
  blocked: 'Bloqueado',
  review: 'Revisión',
  done: 'Hecho',
};

interface KanbanTask {
  id: string;
  title: string;
  status: string;
  assignee: string;
  priority: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  last_failure_error: string | null;
  consecutive_failures: number;
}

interface KanbanBoard {
  slug: string;
  name: string;
  active: boolean;
  available: boolean;
  columns: Record<string, KanbanTask[]>;
}

interface KanbanBoardMeta {
  slug: string;
  name: string;
  counts: Record<string, number>;
}

let _panel: HTMLElement | null = null;
let _visible = false;
let _timer: number | null = null;
let _board: KanbanBoard | null = null;
let _boards: KanbanBoardMeta[] = [];
let _selectedSlug = '';
let _error = '';

// ─── Public API ───────────────────────────────────────────────────────────────
export function openKanbanPanel(): void {
  if (!_visible) trackPanelOpen('kanban');
  _visible = true;
  showPanel(_getOrCreate());
  void _loadBoards();
  void _fetch();
  _startPolling();
}

export function closeKanbanPanel(): void {
  _visible = false;
  _stopPolling();
  if (_panel) hidePanel(_panel);
}

export function isKanbanPanelOpen(): boolean {
  return _visible;
}

export function toggleKanbanPanel(): void {
  if (_visible) closeKanbanPanel();
  else openKanbanPanel();
}

// ─── Data ─────────────────────────────────────────────────────────────────────
async function _loadBoards(): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/api/kanban/boards'), { headers: bridgeHeaders() });
    if (!res.ok) return;
    const data = (await res.json()) as { boards: KanbanBoardMeta[] };
    _boards = data.boards ?? [];
    _render();
  } catch {
    /* keep last known boards */
  }
}

async function _fetch(): Promise<void> {
  try {
    const qs = _selectedSlug ? `?board=${encodeURIComponent(_selectedSlug)}` : '';
    const res = await fetch(bridgeUrl(`/api/kanban${qs}`), { headers: bridgeHeaders() });
    if (!res.ok) {
      _error = `HTTP ${res.status}`;
      _render();
      return;
    }
    _error = '';
    _board = (await res.json()) as KanbanBoard;
    _render();
  } catch (err) {
    _error = err instanceof Error ? err.message : String(err);
    _render();
  }
}

function _startPolling(): void {
  _stopPolling();
  _timer = window.setInterval(() => {
    void _fetch();
  }, POLL_MS);
}

function _stopPolling(): void {
  if (_timer !== null) {
    window.clearInterval(_timer);
    _timer = null;
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────
function _render(): void {
  const panel = _getOrCreate();
  const body = panel.querySelector<HTMLElement>('.kb-body');
  if (!body) return;

  const board = _board;
  if (!board) {
    body.innerHTML = `<div class="kb-empty">Cargando kanban…</div>`;
    return;
  }
  if (!board.available) {
    body.innerHTML = `<div class="kb-empty">Kanban no disponible — Hermes no tiene boards en ~/.hermes/kanban</div>`;
    return;
  }

  const columns = Object.entries(board.columns)
    .filter(([, tasks]) => tasks.length > 0)
    .map(([status, tasks]) => {
      const label = COLUMN_LABELS[status] ?? status;
      const cards = tasks
        .map((t) => {
          const assignee = t.assignee
            ? `<span class="kb-assignee">${escapeHtml(t.assignee)}</span>`
            : '';
          const prio = t.priority > 0 ? `<span class="kb-prio">${t.priority}</span>` : '';
          const fail =
            t.consecutive_failures > 0
              ? `<span class="kb-fail" title="${escapeHtml(t.last_failure_error ?? '')}">✗${t.consecutive_failures}</span>`
              : '';
          return `
            <div class="kb-card" data-status="${escapeHtml(status)}">
              <div class="kb-card-title">${escapeHtml(t.title)}</div>
              <div class="kb-card-meta">${assignee}${prio}${fail}</div>
            </div>
          `;
        })
        .join('');
      return `
        <div class="kb-column" data-status="${escapeHtml(status)}">
          <div class="kb-column-head">
            <span class="kb-column-label">${escapeHtml(label)}</span>
            <span class="kb-column-count">${tasks.length}</span>
          </div>
          <div class="kb-column-body">${cards}</div>
        </div>
      `;
    })
    .join('');

  const boardSelect = _boards
    .map(
      (b) =>
        `<option value="${escapeHtml(b.slug)}" ${b.slug === board.slug ? 'selected' : ''}>${escapeHtml(b.name)} (${_countTotal(b.counts)})</option>`,
    )
    .join('');

  body.innerHTML = `
    <div class="kb-toolbar">
      <select class="kb-board-select" aria-label="Seleccionar board">
        ${boardSelect}
      </select>
      <span class="kb-board-name">${escapeHtml(board.name)}${board.active ? ' · activo' : ''}</span>
      ${_error ? `<span class="kb-error">⚠ ${escapeHtml(_error)}</span>` : ''}
    </div>
    <div class="kb-columns">${columns || '<div class="kb-empty">Sin tareas en este board</div>'}</div>
  `;

  const select = body.querySelector<HTMLSelectElement>('.kb-board-select');
  select?.addEventListener('change', () => {
    _selectedSlug = select.value;
    void _fetch();
  });
}

function _countTotal(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

// ─── DOM ─────────────────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  _panel = ensurePanel(
    'kanban-panel',
    'kb-panel hidden',
    `
    <div class="kb-header">
      <span class="kb-title">📋 KANBAN — Hermes</span>
      <button id="kb-x" title="Cerrar [F6]" aria-label="Cerrar panel kanban">✕</button>
    </div>
    <div class="kb-body"></div>
  `,
  );
  bindPanelAction(_panel, '#kb-x', closeKanbanPanel);
  return _panel;
}

function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
