// ─── RepoCiv — Pending Tracker Panel (Fase F) ─────────────────────────────────
// Side panel listing all active items from PENDING_TRACKER.md.
// Shows: [ID] Title — State emoji — Priority, grouped by priority.
// Click expands detail. Inline edit form. State changer. Delete button.
// "✓ Resolver" moves to HECHO. Polls every 5s while open.
import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';

const POLL_MS = 5_000;

// ─── Types ────────────────────────────────────────────────────────────────────
export interface PendingItem {
  id: string;
  title: string;
  priority: string;  // ALTA | MEDIA | BAJA
  state: string;     // 🔵 | 🟡 | 🟢 | 🔴
  stateText: string;
  detail: string;
}

// ─── State ─────────────────────────────────────────────────────────────────────
let _panel: HTMLElement | null = null;
let _timer = 0;
let _visible = false;
let _items: PendingItem[] = [];
let _offline = false;
let _expandedId: string | null = null;
let _editingId: string | null = null;

const STATE_OPTIONS = [
  { value: '🔵', label: '🔵 registrada' },
  { value: '🟡', label: '🟡 en progreso' },
  { value: '🟢', label: '🟢 operativo' },
  { value: '🔴', label: '🔴 descartada' },
];

// ─── Public API ───────────────────────────────────────────────────────────────
export function openPendingPanel(): void {
  _visible = true;
  showPanel(_getOrCreate());
  void _fetch();
  _startPolling();
}

export function closePendingPanel(): void {
  _visible = false;
  _stopPolling();
  _expandedId = null;
  _editingId = null;
  if (_panel) hidePanel(_panel);
}

export function isPendingPanelOpen(): boolean {
  return _visible;
}

export function togglePendingPanel(): void {
  if (_visible) closePendingPanel();
  else openPendingPanel();
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

// ─── API calls ────────────────────────────────────────────────────────────────
async function _fetch(): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/pending'), { headers: bridgeHeaders() });
    if (!res.ok) {
      _offline = true;
      if (_visible) _render();
      return;
    }
    _items = (await res.json()) as PendingItem[];
    _offline = false;
    if (_visible) _render();
  } catch {
    _offline = true;
    if (_visible) _render();
  }
}

async function _addItem(title: string, priority: string): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/pending/add'), {
      method: 'POST',
      headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, priority }),
    });
    if (res.ok) void _fetch();
  } catch { /* will refresh on next poll */ }
}

async function _resolveItem(id: string): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/pending/resolve'), {
      method: 'POST',
      headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      _items = _items.filter((it) => it.id !== id);
      if (_expandedId === id) { _expandedId = null; _editingId = null; }
      if (_visible) _render();
    }
  } catch { /* will refresh on next poll */ }
}

async function _editItem(id: string, title: string, priority: string, detail: string): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/pending/edit'), {
      method: 'POST',
      headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title, priority, detail }),
    });
    if (res.ok) void _fetch();
  } catch { /* will refresh on next poll */ }
}

async function _deleteItem(id: string): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/pending/delete'), {
      method: 'POST',
      headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      _items = _items.filter((it) => it.id !== id);
      if (_expandedId === id) { _expandedId = null; _editingId = null; }
      if (_visible) _render();
    }
  } catch { /* will refresh on next poll */ }
}

async function _changeState(id: string, state: string): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/pending/state'), {
      method: 'POST',
      headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, state }),
    });
    if (res.ok) {
      const item = _items.find((it) => it.id === id);
      if (item) {
        item.state = state;
        const opt = STATE_OPTIONS.find((o) => o.value === state);
        item.stateText = opt ? opt.label : state;
      }
      if (_visible) _render();
    }
  } catch { /* will refresh on next poll */ }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function _render(): void {
  const panel = _getOrCreate();
  const body = panel.querySelector<HTMLElement>('.pending-body')!;

  if (_offline) {
    body.innerHTML = '<div class="pending-offline">⚠ Bridge offline — reintentando...</div>';
    return;
  }

  if (_items.length === 0) {
    body.innerHTML = `
      <div class="pending-empty">Sin pendientes activos ✓</div>
      ${_renderForm()}
    `;
    _wireForm(body);
    return;
  }

  // Group by priority: ALTA first, then MEDIA, then BAJA
  const order = ['ALTA', 'MEDIA', 'BAJA'];
  const groups: Record<string, PendingItem[]> = {};
  for (const item of _items) {
    const key = item.priority || 'MEDIA';
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  let html = '';
  for (const pri of order) {
    const items = groups[pri];
    if (!items || items.length === 0) continue;
    html += `<div class="pending-group">
      <div class="pending-group-header">${_esc(pri)} (${items.length})</div>
      ${items.map((it) => _renderItem(it)).join('')}
    </div>`;
  }

  html += _renderForm();
  body.innerHTML = html;

  // Wire interactions
  body.querySelectorAll<HTMLElement>('.pending-item-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.btn-resolve, .btn-edit, .btn-delete, .btn-state, .pending-state-select')) return;
      const id = row.dataset['id'] ?? '';
      if (_editingId === id) return; // Don't collapse while editing
      _expandedId = _expandedId === id ? null : id;
      _render();
    });
  });

  body.querySelectorAll<HTMLButtonElement>('.btn-resolve').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset['id'] ?? '';
      if (id) void _resolveItem(id);
    });
  });

  body.querySelectorAll<HTMLButtonElement>('.btn-edit').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset['id'] ?? '';
      if (id) {
        _editingId = _editingId === id ? null : id;
        _expandedId = id;
        _render();
      }
    });
  });

  body.querySelectorAll<HTMLButtonElement>('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset['id'] ?? '';
      const item = _items.find((it) => it.id === id);
      if (id && item && confirm(`¿Eliminar "${item.title}" del tracker?`)) {
        void _deleteItem(id);
      }
    });
  });

  body.querySelectorAll<HTMLSelectElement>('.pending-state-select').forEach((sel) => {
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', () => {
      const id = sel.dataset['id'] ?? '';
      const state = sel.value;
      if (id && state) void _changeState(id, state);
    });
  });

  // Wire edit forms
  body.querySelectorAll<HTMLFormElement>('.pending-edit-form').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = form.dataset['id'] ?? '';
      const title = (form.querySelector('.edit-title') as HTMLInputElement)?.value.trim();
      const priority = (form.querySelector('.edit-priority') as HTMLSelectElement)?.value;
      const detail = (form.querySelector('.edit-detail') as HTMLTextAreaElement)?.value.trim();
      if (id && title) {
        void _editItem(id, title, priority, detail);
        _editingId = null;
      }
    });
  });

  _wireForm(body);
}

function _renderItem(item: PendingItem): string {
  const isExpanded = _expandedId === item.id;
  const isEditing = _editingId === item.id;
  // Detail section
  let detailHtml = '';
  if (isExpanded && item.detail) {
    detailHtml = `<div class="pending-detail">${_esc(item.detail).replace(/\n/g, '<br>')}</div>`;
  }

  // Edit form
  let editHtml = '';
  if (isEditing) {
    editHtml = `
      <div class="pending-edit">
        <form class="pending-edit-form" data-id="${_esc(item.id)}">
          <div class="edit-row">
            <label class="edit-label">Título</label>
            <input type="text" class="edit-title" value="${_esc(item.title)}" required />
          </div>
          <div class="edit-row">
            <label class="edit-label">Prioridad</label>
            <select class="edit-priority">
              <option value="ALTA" ${item.priority === 'ALTA' ? 'selected' : ''}>ALTA</option>
              <option value="MEDIA" ${item.priority === 'MEDIA' ? 'selected' : ''}>MEDIA</option>
              <option value="BAJA" ${item.priority === 'BAJA' ? 'selected' : ''}>BAJA</option>
            </select>
          </div>
          <div class="edit-row">
            <label class="edit-label">Detalle</label>
            <textarea class="edit-detail" rows="4">${_esc(item.detail)}</textarea>
          </div>
          <div class="edit-actions">
            <button type="submit" class="btn-save-edit">💾 Guardar</button>
            <button type="button" class="btn-cancel-edit" data-action="cancel-edit" data-id="${_esc(item.id)}">✕ Cancelar</button>
          </div>
        </form>
      </div>
    `;
  }

  // State selector
  const stateOptions = STATE_OPTIONS.map(
    (o) => `<option value="${o.value}" ${item.state === o.value ? 'selected' : ''}>${o.label}</option>`
  ).join('');

  return `
    <div class="pending-item ${isExpanded ? 'expanded' : ''} ${isEditing ? 'editing' : ''}" data-id="${_esc(item.id)}">
      <div class="pending-item-row" data-id="${_esc(item.id)}">
        <span class="pending-id">[${_esc(item.id)}]</span>
        <span class="pending-title">${_esc(item.title)}</span>
        <select class="pending-state-select" data-id="${_esc(item.id)}" title="Cambiar estado">
          ${stateOptions}
        </select>
        <button class="btn-edit" data-id="${_esc(item.id)}" title="Editar pendiente" aria-label="Editar ${_esc(item.title)}">✎</button>
        <button class="btn-resolve" data-id="${_esc(item.id)}" title="Marcar como resuelto (mover a HECHO)" aria-label="Resolver ${_esc(item.title)}">✓</button>
        <button class="btn-delete" data-id="${_esc(item.id)}" title="Eliminar pendiente" aria-label="Eliminar ${_esc(item.title)}">✕</button>
      </div>
      ${detailHtml}
      ${editHtml}
    </div>
  `;
}

function _renderForm(): string {
  return `
    <div class="pending-form">
      <div class="pending-form-title">+ Agregar pendiente</div>
      <div class="pending-form-row">
        <input type="text" class="pending-form-input" id="pending-new-title" placeholder="Título del pendiente..." autocomplete="off" />
        <select class="pending-form-select" id="pending-new-priority">
          <option value="ALTA">ALTA</option>
          <option value="MEDIA" selected>MEDIA</option>
          <option value="BAJA">BAJA</option>
        </select>
        <button class="pending-form-btn" id="pending-btn-add">Agregar</button>
      </div>
    </div>
  `;
}

function _wireForm(body: HTMLElement): void {
  const addBtn = body.querySelector<HTMLButtonElement>('#pending-btn-add');
  const input = body.querySelector<HTMLInputElement>('#pending-new-title');
  const select = body.querySelector<HTMLSelectElement>('#pending-new-priority');

  if (!addBtn || !input || !select) return;

  const doAdd = () => {
    const title = input.value.trim();
    const priority = select.value;
    if (!title) return;
    input.value = '';
    void _addItem(title, priority);
  };

  addBtn.addEventListener('click', doAdd);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doAdd();
  });

  // Cancel edit buttons
  body.querySelectorAll<HTMLButtonElement>('[data-action="cancel-edit"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _editingId = null;
      _render();
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  _panel = ensurePanel(
    'pending-panel',
    'pending-panel hidden',
    `
    <div class="pending-header">
      <span class="pending-title">📋 PENDIENTES</span>
      <button id="pending-close" title="Cerrar panel de pendientes" aria-label="Cerrar panel de pendientes">✕</button>
    </div>
    <div class="pending-body"></div>
    `,
  );
  bindPanelAction(_panel, '#pending-close', closePendingPanel);
  return _panel;
}
