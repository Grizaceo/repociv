// ─── RepoCiv — Pending Tracker Panel (Fase F) ─────────────────────────────────
// Side panel listing all active items from PENDING_TRACKER.md.
// Shows: [ID] Title — State emoji — Priority, grouped by priority.
// Click expands detail. Form inline to add. "✓ Resolver" per item.
// Polls every 5s while open.
import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';

const POLL_MS = 5_000;

// ─── Types ────────────────────────────────────────────────────────────────────
export interface PendingItem {
  id: string;
  title: string;
  priority: string;  // ALTA | MEDIA | BAJA
  state: string;     // 🔵 | 🟡 | 🟢 | 🟴
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
  } catch {
    // Ignore — will refresh on next poll
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
      // Remove from local state immediately
      _items = _items.filter((it) => it.id !== id);
      if (_expandedId === id) _expandedId = null;
      if (_visible) _render();
    }
  } catch {
    // Ignore — will refresh on next poll
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function _render(): void {
  const panel = _getOrCreate();
  const body = panel.querySelector<HTMLElement>('.pending-body')!;

  if (_offline) {
    body.innerHTML = '<div class="pending-offline">⚠ Bridge offline — sin datos</div>';
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
      <div class="pending-group-header">${_esc(pri)}</div>
      ${items.map((it) => _renderItem(it)).join('')}
    </div>`;
  }

  html += _renderForm();
  body.innerHTML = html;

  // Wire interactions
  body.querySelectorAll<HTMLElement>('.pending-item-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      // Don't toggle if clicking resolve button
      if ((e.target as HTMLElement).closest('.btn-resolve')) return;
      const id = row.dataset['id'] ?? '';
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

  _wireForm(body);
}

function _renderItem(item: PendingItem): string {
  const isExpanded = _expandedId === item.id;
  const detailHtml = isExpanded && item.detail
    ? `<div class="pending-detail">${_esc(item.detail).replace(/\n/g, '<br>')}</div>`
    : '';
  const stateEmoji = item.state || '🔵';

  return `
    <div class="pending-item ${isExpanded ? 'expanded' : ''}" data-id="${_esc(item.id)}">
      <div class="pending-item-row" data-id="${_esc(item.id)}">
        <span class="pending-id">[${_esc(item.id)}]</span>
        <span class="pending-title">${_esc(item.title)}</span>
        <span class="pending-state" title="${_esc(item.stateText)}">${stateEmoji}</span>
        <button class="btn-resolve" data-id="${_esc(item.id)}" title="Marcar como resuelto" aria-label="Resolver ${_esc(item.title)}">✓</button>
      </div>
      ${detailHtml}
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
  const select = body.querySelector<HTMLSelectElement>("#pending-new-priority");

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
