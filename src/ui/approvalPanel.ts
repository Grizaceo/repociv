// ─── RepoCiv — Approval Panel (Sprint B / Fase 3) ─────────────────────────────
// Shows commands waiting_approval so the user can approve or reject them.
// Badge in the top bar shows pending count.
// Polls /approvals every 3 seconds when bridge is online.

import { approveCommand, rejectCommand } from '../commandBus.ts';
import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';
import { renderEmptyState, clearEmptyState } from './emptyStates.ts';
import { registerPoll, type PollUnregister } from './pollScheduler.ts';
import { reconcileApprovalCards } from './approvalCards.ts';
import { signalApproval } from './payoffs.ts';
import { logEvent } from './hud.ts';

const POLL_MS = 3_000;

export interface ApprovalItem {
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
let _stopPoll: PollUnregister | null = null;
let _visible = false;
let _items: ApprovalItem[] = [];
const _listeners = new Set<(items: readonly ApprovalItem[]) => void>();

/** Ids already surfaced — the fanfare rings only on first sighting. */
const _seenApprovalIds = new Set<string>();

/** Returns the ids not seen before and marks every listed id as seen. */
export function diffNewApprovalIds(ids: string[]): string[] {
  const fresh = ids.filter((id) => !_seenApprovalIds.has(id));
  for (const id of ids) _seenApprovalIds.add(id);
  return fresh;
}

/** Ring the one-shot fanfare when the list carries previously unseen ids. */
export function noteApprovalFanfare(items: readonly { id: string }[]): void {
  if (diffNewApprovalIds(items.map((i) => i.id)).length > 0) signalApproval();
}

/** Tests only — forget seen ids so the diff starts clean. */
export function resetApprovalTrackingForTests(): void {
  _seenApprovalIds.clear();
}

/** Who asked for this approval: the unit/session in the payload, else created_by. */
export function approvalRequesterLabel(item: ApprovalItem): string {
  const unit = item.payload?.['unit'];
  if (typeof unit === 'string' && unit) return unit;
  return item.created_by || 'desconocido';
}

/** Reference the "Ir al chat" button navigates to: unit, session or requester. */
export function approvalChatRef(item: ApprovalItem): string {
  const p = item.payload ?? {};
  for (const key of ['unit', 'sessionId', 'session', 'harnessId'] as const) {
    const v = p[key];
    if (typeof v === 'string' && v) return v;
  }
  return item.created_by || '';
}

export interface ApprovalPanelDeps {
  /** Navigate to the chat/map position of `ref`. True when the agent was found. */
  gotoChat: (ref: string) => boolean;
}

let _deps: ApprovalPanelDeps | null = null;

/** Wire navigation so "Ir al chat" reuses the existing session/unit flows. */
export function bindApprovalPanel(deps: ApprovalPanelDeps): void {
  _deps = deps;
}

/** Share the existing approval poll; consumers must not add a second fetch loop. */
export function subscribeApprovals(listener: (items: readonly ApprovalItem[]) => void): () => void {
  _listeners.add(listener);
  listener(_items);
  return () => {
    _listeners.delete(listener);
  };
}

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
  _stopPoll = registerPoll('approvals', () => void _fetchApprovals(), POLL_MS);
}

// ─── Polling ──────────────────────────────────────────────────────────────────
function _stopPolling() {
  if (_stopPoll) {
    _stopPoll();
    _stopPoll = null;
  }
}

async function _fetchApprovals() {
  try {
    const res = await fetch(bridgeUrl('/approvals'), { headers: bridgeHeaders() });
    if (!res.ok) return;
    _items = (await res.json()) as ApprovalItem[];
    // One-shot fanfare per newly arrived approval id (not per render/poll).
    noteApprovalFanfare(_items);
    reconcileApprovalCards(new Set(_items.map((item) => item.id)));
    for (const listener of _listeners) listener(_items);
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
      const requester = approvalRequesterLabel(item);
      // Relevant payload context next to the requester: session/harness names.
      const contextBits = (['sessionId', 'session', 'harness', 'harnessId', 'city'] as const)
        .map((key) => {
          const v = item.payload?.[key];
          return typeof v === 'string' && v && v !== requester ? `${key}: ${v}` : null;
        })
        .filter((bit): bit is string => bit !== null);

      return `
      <div class="ap-item" data-id="${_esc(item.id)}">
        <div class="ap-item-header">
          <span class="ap-type">${_esc(item.type)}</span>
          <span class="ap-risk" data-risk="${_esc(item.risk)}" title="Riesgo">${riskLabel}</span>
          <span class="ap-age">${ageStr}</span>
        </div>
        <div class="ap-target" title="${_esc(item.target)}">${_esc(item.target.slice(0, 50))}</div>
        <div class="ap-requester">por ${_esc(requester)}${contextBits.length ? ` · ${_esc(contextBits.join(' · '))}` : ''}</div>
        ${payloadPreview ? `<div class="ap-payload-expand" data-id="${_esc(item.id)}" title="Ver payload completo">${_esc(payloadPreview)}${payloadFull ? ' …' : ''}</div>` : ''}
        <div class="ap-actions">
          <button class="ap-goto" data-id="${_esc(item.id)}" title="Ir al chat de ${_esc(requester)}">💬 Ir al chat</button>
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

  list.querySelectorAll<HTMLButtonElement>('.ap-goto').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset['id']!;
      const item = _items.find((i) => i.id === id);
      if (!item) return;
      const located = _deps?.gotoChat(approvalChatRef(item)) ?? false;
      if (!located) {
        logEvent('No se pudo localizar al agente de esta aprobación', 'warn');
      }
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
