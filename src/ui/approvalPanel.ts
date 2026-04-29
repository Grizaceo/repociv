// ─── RepoCiv — Approval Panel (Sprint B / Fase 3) ─────────────────────────────
// Shows commands waiting_approval so the user can approve or reject them.
// Badge in the top bar shows pending count.
// Polls /approvals every 3 seconds when bridge is online.

import { approveCommand, rejectCommand } from '../commandBus.ts';

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:5274';
const BRIDGE_TOKEN = import.meta.env.VITE_BRIDGE_TOKEN ?? '';
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
  _getOrCreate().classList.remove('hidden');
  _render();
}

export function closeApprovalPanel() {
  _visible = false;
  _panel?.classList.add('hidden');
}

export function isApprovalPanelOpen(): boolean { return _visible; }

export function toggleApprovalPanel() {
  if (_visible) closeApprovalPanel();
  else openApprovalPanel();
}

export function startApprovalPolling() {
  _stopPolling();
  _fetchApprovals();
  _pollTimer = window.setInterval(_fetchApprovals, POLL_MS);
}

export function stopApprovalPolling() { _stopPolling(); }

// ─── Polling ──────────────────────────────────────────────────────────────────
function _stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = 0; }
}

async function _fetchApprovals() {
  const headers: Record<string, string> = {};
  if (BRIDGE_TOKEN) headers['X-RepoCiv-Token'] = BRIDGE_TOKEN;
  try {
    const res = await fetch(`${BRIDGE_URL}/approvals`, { headers });
    if (!res.ok) return;
    _items = await res.json() as ApprovalItem[];
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
  b.title = count > 0 ? `${count} aprobación${count > 1 ? 'es' : ''} pendiente${count > 1 ? 's' : ''}` : '';
}

function _getBadge(): HTMLElement {
  if (_badge) return _badge;
  const btn = document.getElementById('btn-approvals');
  if (btn) { _badge = btn.querySelector<HTMLElement>('.approval-badge') ?? _createBadge(btn); }
  else { _badge = document.createElement('span'); }
  return _badge;
}

function _createBadge(parent: HTMLElement): HTMLElement {
  const b = document.createElement('span');
  b.className = 'approval-badge';
  parent.appendChild(b);
  return b;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function _render() {
  const panel = _getOrCreate();
  const list = panel.querySelector<HTMLElement>('.ap-list')!;

  if (_items.length === 0) {
    list.innerHTML = '<div class="ap-empty">No hay aprobaciones pendientes.</div>';
    return;
  }

  list.innerHTML = _items.map(item => {
    const age = Math.round((Date.now() / 1000) - item.created_at);
    const ageStr = age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;
    const [riskColor, riskLabel] = _riskStyle(item.risk);
    const payloadStr = JSON.stringify(item.payload ?? {}).slice(0, 80);

    return `
      <div class="ap-item" data-id="${_esc(item.id)}">
        <div class="ap-item-header">
          <span class="ap-type">${_esc(item.type)}</span>
          <span class="ap-risk" style="color:${riskColor}" title="Riesgo">${riskLabel}</span>
          <span class="ap-age">${ageStr}</span>
        </div>
        <div class="ap-target" title="${_esc(item.target)}">${_esc(item.target.slice(0, 50))}</div>
        ${payloadStr !== '{}' ? `<div class="ap-payload">${_esc(payloadStr)}</div>` : ''}
        <div class="ap-actions">
          <button class="ap-approve" data-id="${_esc(item.id)}">✔ Aprobar</button>
          <button class="ap-reject"  data-id="${_esc(item.id)}">✗ Rechazar</button>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll<HTMLButtonElement>('.ap-approve').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset['id']!;
      btn.disabled = true;
      await approveCommand(id);
      await _fetchApprovals();
    });
  });

  list.querySelectorAll<HTMLButtonElement>('.ap-reject').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset['id']!;
      btn.disabled = true;
      await rejectCommand(id);
      await _fetchApprovals();
    });
  });
}

function _riskStyle(risk: string): [string, string] {
  if (risk === 'destructive') return ['#d44b4b', '☠ DESTRUCTIVO'];
  if (risk === 'high')        return ['#e8a040', '⚠ ALTO'];
  if (risk === 'medium')      return ['#c8a84b', '◆ MEDIO'];
  return ['#5b9b5b', '● BAJO'];
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  const el = document.createElement('div');
  el.id = 'approval-panel';
  el.className = 'ap-panel hidden';
  el.innerHTML = `
    <div class="ap-header">
      <span class="ap-title">⚠ APROBACIONES PENDIENTES</span>
      <button id="ap-close" title="Cerrar [A]">✕</button>
    </div>
    <div class="ap-list"></div>
  `;
  document.body.appendChild(el);
  el.querySelector('#ap-close')?.addEventListener('click', closeApprovalPanel);
  _panel = el;
  return el;
}

function _esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
