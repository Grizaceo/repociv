// ─── RepoCiv — Pending Tracker Panel (Fase F) ─────────────────────────────────
// Side panel listing all active items from PENDING_TRACKER.md.
// State + types: src/ui/pendingPanel/state.ts
// HTML templates: src/ui/pendingPanel/templates.ts
// Aqui: API calls (CRUD vs bridge), render orchestration, lifecycle.
import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';
import {
  type PendingItem,
  POLL_MS,
  STATE_OPTIONS,
  getPanel,
  setPanel,
  getTimer,
  setTimer,
  getVisible,
  setVisible,
  getItems,
  setItems,
  getOffline,
  setOffline,
  getExpandedId,
  setExpandedId,
  getEditingId,
  setEditingId,
} from './pendingPanel/state.ts';
import { renderItem, renderForm, escapeHtml } from './pendingPanel/templates.ts';
import { renderEmptyState, clearEmptyState } from './emptyStates.ts';

export type { PendingItem } from './pendingPanel/state.ts';

// ─── Public API ───────────────────────────────────────────────────────────────
export function openPendingPanel(): void {
  setVisible(true);
  showPanel(_getOrCreate());
  void _fetch();
  _startPolling();
}

export function closePendingPanel(): void {
  setVisible(false);
  _stopPolling();
  setExpandedId(null);
  setEditingId(null);
  const panel = getPanel();
  if (panel) hidePanel(panel);
}

export function isPendingPanelOpen(): boolean {
  return getVisible();
}

export function togglePendingPanel(): void {
  if (getVisible()) closePendingPanel();
  else openPendingPanel();
}

// ─── Polling ──────────────────────────────────────────────────────────────────
function _startPolling(): void {
  _stopPolling();
  setTimer(
    window.setInterval(() => {
      void _fetch();
    }, POLL_MS),
  );
}

function _stopPolling(): void {
  const t = getTimer();
  if (t) {
    clearInterval(t);
    setTimer(0);
  }
}

// ─── API calls ────────────────────────────────────────────────────────────────
async function _fetch(): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/pending'), { headers: bridgeHeaders() });
    if (!res.ok) {
      setOffline(true);
      if (getVisible()) _render();
      return;
    }
    setItems((await res.json()) as PendingItem[]);
    setOffline(false);
    if (getVisible()) _render();
  } catch {
    setOffline(true);
    if (getVisible()) _render();
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
  } catch {
    /* will refresh on next poll */
  }
}

async function _resolveItem(id: string): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/pending/resolve'), {
      method: 'POST',
      headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      setItems(getItems().filter((it) => it.id !== id));
      if (getExpandedId() === id) {
        setExpandedId(null);
        setEditingId(null);
      }
      if (getVisible()) _render();
    }
  } catch {
    /* will refresh on next poll */
  }
}

async function _editItem(
  id: string,
  title: string,
  priority: string,
  detail: string,
): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/pending/edit'), {
      method: 'POST',
      headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title, priority, detail }),
    });
    if (res.ok) void _fetch();
  } catch {
    /* will refresh on next poll */
  }
}

async function _deleteItem(id: string): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/pending/delete'), {
      method: 'POST',
      headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      setItems(getItems().filter((it) => it.id !== id));
      if (getExpandedId() === id) {
        setExpandedId(null);
        setEditingId(null);
      }
      if (getVisible()) _render();
    }
  } catch {
    /* will refresh on next poll */
  }
}

async function _changeState(id: string, state: string): Promise<void> {
  try {
    const res = await fetch(bridgeUrl('/pending/state'), {
      method: 'POST',
      headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, state }),
    });
    if (res.ok) {
      const item = getItems().find((it) => it.id === id);
      if (item) {
        item.state = state;
        const opt = STATE_OPTIONS.find((o) => o.value === state);
        item.stateText = opt ? opt.label : state;
      }
      if (getVisible()) _render();
    }
  } catch {
    /* will refresh on next poll */
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function _render(): void {
  const panel = _getOrCreate();
  const body = panel.querySelector<HTMLElement>('.pending-body')!;

  if (getOffline()) {
    body.innerHTML = '<div class="pending-offline">⚠ Bridge offline — reintentando...</div>';
    return;
  }

  const items = getItems();
  clearEmptyState(body);
  if (items.length === 0) {
    renderEmptyState(body, 'pending');
    body.insertAdjacentHTML('beforeend', renderForm());
    _wireForm(body);
    return;
  }

  // Group by priority: ALTA first, then MEDIA, then BAJA
  const order = ['ALTA', 'MEDIA', 'BAJA'];
  const groups: Record<string, PendingItem[]> = {};
  for (const item of items) {
    const key = item.priority || 'MEDIA';
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  let html = '';
  for (const pri of order) {
    const list = groups[pri];
    if (!list || list.length === 0) continue;
    html += `<div class="pending-group">
      <div class="pending-group-header">${escapeHtml(pri)} (${list.length})</div>
      ${list.map((it) => renderItem(it)).join('')}
    </div>`;
  }

  html += renderForm();
  body.innerHTML = html;

  // Wire interactions
  body.querySelectorAll<HTMLElement>('.pending-item-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (
        (e.target as HTMLElement).closest(
          '.btn-resolve, .btn-edit, .btn-delete, .btn-state, .pending-state-select',
        )
      )
        return;
      const id = row.dataset['id'] ?? '';
      if (getEditingId() === id) return; // Don't collapse while editing
      setExpandedId(getExpandedId() === id ? null : id);
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
        setEditingId(getEditingId() === id ? null : id);
        setExpandedId(id);
        _render();
      }
    });
  });

  body.querySelectorAll<HTMLButtonElement>('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset['id'] ?? '';
      const item = getItems().find((it) => it.id === id);
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
        setEditingId(null);
      }
    });
  });

  _wireForm(body);
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
      setEditingId(null);
      _render();
    });
  });
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  const existing = getPanel();
  if (existing) return existing;
  const panel = ensurePanel(
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
  bindPanelAction(panel, '#pending-close', closePendingPanel);
  setPanel(panel);
  return panel;
}
