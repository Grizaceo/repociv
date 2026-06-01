// ─── RepoCiv — Approval Panel (Sprint B / Fase 3) ─────────────────────────────
// Shows commands waiting_approval so the user can approve or reject them.
// Badge in the top bar shows pending count.
// Polls /approvals every 3 seconds when bridge is online.

import { approveCommand, rejectCommand } from '../commandBus.ts';
import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';
import { renderEmptyState, clearEmptyState } from './emptyStates.ts';

const POLL_MS = 3_000;

interface ApprovalItem {
  id: string;
  type: string;
  target: string;
  risk: string;
  payload: Record<string, unknown>;
  created_by: string;
  created_at: number;
}

let _panel: HTMLElement | null = null;
let _badge: HTMLElement | null = null;
let _pollTimer = 0;
let _visible = false;
let _items: ApprovalItem[] = [];

// ─── Public API ───────────────────────────────────────────────────────────────
export function openApprovalPanel() {
  _visible = true;
  showPanel(_getOrCreate());
  _render();
}

export function closeApprovalPanel() {
  _visible = false;
  if (_panel) hidePanel(_panel);
}

export function isApprovalPanelOpen(): boolean {
  return _visible;
}

export function toggleApprovalPanel() {
  if (_visible) closeApprovalPanel();
  else openApprovalPanel();
}

export function startApprovalPolling() {
  _stopPolling();
  _fetchApprovals();
  _pollTimer = window.setInterval(_fetchApprovals, POLL_MS);
}

export function stopApprovalPolling() {
  _stopPolling();
}

// ─── Polling ──────────────────────────────────────────────────────────────────
function _stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = 0;
  }
}

async function _fetchApprovals() {
  try {
    const res = await fetch(bridgeUrl('/approvals'), { headers: bridgeHeaders() });
    if (!res.ok) return;
    _items = (await res.json()) as ApprovalItem[];
    _updateBadge(_items.length);
    if (_visible) _render();
  } catch {
    // bridge offline
  }
}

// ─── Badge ────────────────────────────────────────────────────────────────────
function _updateBadge(count: number) {
  const b = _getBadge();
  b.textContent = count > 0 ? String(count) : '';
  b.classList.toggle('approval-badge-active', count > 0);
  b.title =
    count > 0 ? `${count} aprobación${count > 1 ? 'es' : ''} pendiente${count > 1 ? 's' : ''}` : '';
}

function _getBadge(): HTMLElement {
  if (_badge) return _badge;
  const btn = document.getElementById('btn-approvals');
  if (btn) {
    _badge = btn.querySelector<HTMLElement>('.approval-badge') ?? _createBadge(btn);
  } else {
    _badge = document.createElement('span');
  }
  return _badge;
}

function _createBadge(parent: HTMLElement): HTMLElement {
  const b = document.createElement('span');
  b.className = 'approval-badge';
  parent.appendChild(b);
  return b;
}

// ─── Confirm state ────────────────────────────────────────────────────────────
const _confirming: Set<string> = new Set();

// ─── Render ───────────────────────────────────────────────────────────────────
function _render() {
  const panel = _getOrCreate();
  const list = panel.querySelector<HTMLElement>('.ap-list')!;

  clearEmptyState(list);
  if (_items.length === 0) {
    renderEmptyState(list, 'approvals');
    return;
  }

  list.innerHTML = _items
    .map((item) => {
      const age = Math.round(Date.now() / 1000 - item.created_at);
      const ageStr = age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;
      const riskLabel = _riskLabel(item.risk);
      const payloadJson = JSON.stringify(item.payload ?? {});
      const payloadPreview = payloadJson === '{}' ? '' : payloadJson.slice(0, 80);
      const payloadFull = payloadJson.length > 80 && payloadJson !== '{}';
      const isConfirming = _confirming.has(item.id);
      const needsConfirm = item.risk === 'destructive' || item.risk === 'high';

      return `
      <div class="ap-item" data-id="${_esc(item.id)}">
        <div class="ap-item-header">
          <span class="ap-type">${_esc(item.type)}</span>
          <span class="ap-risk" data-risk="${_esc(item.risk)}" title="Riesgo">${riskLabel}</span>
          <span class="ap-age">${ageStr}</span>
        </div>
        <div class="ap-target" title="${_esc(item.target)}">${_esc(item.target.slice(0, 50))}</div>
        ${payloadPreview ? `<div class="ap-payload-expand" data-id="${_esc(item.id)}" title="Ver payload completo">${_esc(payloadPreview)}${payloadFull ? ' …' : ''}</div>` : ''}
        <div class="ap-actions">
          <button class="ap-approve${isConfirming ? ' confirming' : ''}" data-id="${_esc(item.id)}" data-needs-confirm="${needsConfirm}" aria-label="Aprobar comando ${_esc(item.id)}">${isConfirming ? '¿Confirmar?' : '✔ Aprobar'}</button>
          <button class="ap-reject"  data-id="${_esc(item.id)}" aria-label="Rechazar comando ${_esc(item.id)}">✗ Rechazar</button>
        </div>
      </div>
    `;
    })
    .join('');

  list.querySelectorAll<HTMLElement>('.ap-payload-expand').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset['id']!;
      const item = _items.find((i) => i.id === id);
      if (!item) return;
      const full = document.createElement('pre');
      full.className = 'ap-payload-full';
      full.textContent = JSON.stringify(item.payload, null, 2);
      el.replaceWith(full);
    });
  });

  list.querySelectorAll<HTMLButtonElement>('.ap-approve').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset['id']!;
      const needsConfirm = btn.dataset['needsConfirm'] === 'true';
      if (needsConfirm && !_confirming.has(id)) {
        _confirming.add(id);
        _render();
        return;
      }
      _confirming.delete(id);
      btn.disabled = true;
      await approveCommand(id);
      await _fetchApprovals();
    });
  });

  list.querySelectorAll<HTMLButtonElement>('.ap-reject').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset['id']!;
      _confirming.delete(id);
      btn.disabled = true;
      await rejectCommand(id);
      await _fetchApprovals();
    });
  });
}

function _riskLabel(risk: string): string {
  if (risk === 'destructive') return '☠ DESTRUCTIVO';
  if (risk === 'high') return '⚠ ALTO';
  if (risk === 'medium') return '◆ MEDIO';
  return '● BAJO';
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  _panel = ensurePanel(
    'approval-panel',
    'ap-panel hidden',
    `
    <div class="ap-header">
      <span class="ap-title">⚠ APROBACIONES PENDIENTES</span>
      <button id="ap-close" title="Cerrar [A]" aria-label="Cerrar panel de aprobaciones">✕</button>
    </div>
    <div class="ap-list"></div>
  `,
  );
  bindPanelAction(_panel, '#ap-close', closeApprovalPanel);
  return _panel;
}

function _esc(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
