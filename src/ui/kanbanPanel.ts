// ─── RepoCiv — Hermes Kanban Panel ───────────────────────────────────────────
// Shared Hermes boards: task reading via SQLite; explicit project-board creation
// through the native CLI. Task mutations stay in Hermes.
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
let _creating = false;

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
    body.innerHTML = `<div class="kb-empty">${_error ? `No se pudo cargar Kanban: ${escapeHtml(_error)}` : 'Cargando kanban…'}</div>`;
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
      <button id="kb-new" type="button" aria-expanded="false" aria-controls="kb-create-form">Nuevo tablero</button>
      <button id="kb-x" title="Cerrar [F6]" aria-label="Cerrar panel kanban">✕</button>
    </div>
    <form id="kb-create-form" hidden>
      <label>Nombre del tablero <input name="name" required maxlength="120" autocomplete="off"></label>
      <label>ID del tablero <input name="slug" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]{0,63}" placeholder="mi-proyecto" autocomplete="off"></label>
      <label>Ruta del proyecto <input name="project_path" required placeholder="/home/usuario/repos/mi-proyecto" autocomplete="off"></label>
      <p>Crea un tablero compartido con Hermes. No inicia agentes ni cambia su tablero activo.</p>
      <button type="submit">Crear tablero</button>
      <button id="kb-create-cancel" type="button">Cancelar</button>
    </form>
    <div id="kb-create-message" role="status" aria-live="polite"></div>
    <div class="kb-body"></div>
  `,
  );
  bindPanelAction(_panel, '#kb-x', closeKanbanPanel);
  const form = _panel.querySelector<HTMLFormElement>('#kb-create-form')!;
  const toggle = _panel.querySelector<HTMLButtonElement>('#kb-new')!;
  const message = _panel.querySelector<HTMLElement>('#kb-create-message')!;
  const setForm = (open: boolean) => {
    form.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) form.querySelector<HTMLInputElement>('input')?.focus();
    else toggle.focus();
  };
  toggle.addEventListener('click', () => {
    if (!_creating) setForm(form.hidden);
  });
  bindPanelAction(_panel, '#kb-create-cancel', () => {
    if (!_creating) setForm(false);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (_creating || !form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    _creating = true;
    form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((el) => {
      el.disabled = true;
    });
    toggle.disabled = true;
    message.textContent = 'Creando tablero…';
    try {
      const res = await fetch(bridgeUrl('/api/kanban/boards'), {
        method: 'POST',
        headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(data),
      });
      const result = (await res.json()) as { board?: KanbanBoard; error?: string };
      if (!res.ok || !result.board) throw new Error(result.error || `HTTP ${res.status}`);
      _selectedSlug = result.board.slug;
      _board = result.board;
      _error = '';
      message.textContent = `Tablero «${result.board.name}» creado en Hermes.`;
      form.reset();
      setForm(false);
      await _loadBoards();
      await _fetch();
    } catch (err) {
      message.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      _creating = false;
      toggle.disabled = false;
      form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((el) => {
        el.disabled = false;
      });
      if (form.hidden) toggle.focus();
    }
  });
  return _panel;
}

function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
