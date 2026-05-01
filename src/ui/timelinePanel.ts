// ─── RepoCiv — Timeline / Chronicle Panel (Sprint B / Fase 2) ─────────────────
// Polls /events from the bridge and renders them as a scrollable timeline.
// Hotkey: F10

import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';

const POLL_INTERVAL_MS = 5_000;

interface BridgeEvent {
  id: string;
  commandId: string;
  type: string;
  timestamp: number;
  actor: string;
  data: Record<string, unknown>;
}

let _panel: HTMLElement | null = null;
let _pollTimer = 0;
let _lastTs = 0;
let _events: BridgeEvent[] = [];
let _visible = false;

// ─── Public API ───────────────────────────────────────────────────────────────
export function openTimelinePanel() {
  _visible = true;
  showPanel(_getOrCreate());
  _render();
  _startPolling();
}

export function closeTimelinePanel() {
  _visible = false;
  if (_panel) hidePanel(_panel);
  _stopPolling();
}

export function isTimelinePanelOpen(): boolean {
  return _visible;
}

export function toggleTimelinePanel() {
  if (_visible) closeTimelinePanel();
  else openTimelinePanel();
}

// ─── Polling ──────────────────────────────────────────────────────────────────
function _startPolling() {
  _stopPolling();
  _fetchEvents();
  _pollTimer = window.setInterval(_fetchEvents, POLL_INTERVAL_MS);
}

function _stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = 0;
  }
}

async function _fetchEvents() {
  try {
    const res = await fetch(bridgeUrl(`/events?since=${_lastTs}`), { headers: bridgeHeaders() });
    if (!res.ok) return;
    const fresh = (await res.json()) as BridgeEvent[];
    if (fresh.length === 0) return;
    _events = [..._events, ...fresh].slice(-200);
    _lastTs = Math.max(...fresh.map((e) => e.timestamp));
    if (_visible) _render();
  } catch {
    // bridge offline — panel shows stale data
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function _render() {
  const panel = _getOrCreate();
  const list = panel.querySelector<HTMLElement>('.tl-list')!;
  const sorted = [..._events].sort((a, b) => b.timestamp - a.timestamp);

  if (sorted.length === 0) {
    list.innerHTML = '<div class="tl-empty">No hay eventos. Lanza una misión para empezar.</div>';
    return;
  }

  list.innerHTML = sorted
    .map((evt) => {
      const time = new Date(evt.timestamp * 1000).toLocaleTimeString('es-CL', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const [dot, color] = _eventStyle(evt.type);
      const detail = _eventDetail(evt);
      return `
      <div class="tl-entry" data-cmd="${_esc(evt.commandId)}">
        <span class="tl-dot" style="background:${color}" title="${_esc(evt.type)}">${dot}</span>
        <div class="tl-body">
          <span class="tl-type">${_esc(_formatType(evt.type))}</span>
          ${detail ? `<span class="tl-detail">${detail}</span>` : ''}
          <span class="tl-cmd-id">${_esc(evt.commandId.slice(0, 8))}</span>
        </div>
        <span class="tl-time">${time}</span>
      </div>
    `;
    })
    .join('');
}

function _eventStyle(type: string): [string, string] {
  if (type === 'CommandCompleted') return ['✓', '#5b9b5b'];
  if (type === 'CommandFailed') return ['✗', '#d45b5b'];
  if (type === 'CommandStarted') return ['▶', '#5b9bd5'];
  if (type === 'CommandQueued') return ['⏳', '#c8a84b'];
  if (type === 'CommandCreated') return ['○', '#888'];
  if (type === 'CommandWaitingApproval') return ['⚠', '#e8a040'];
  if (type === 'CommandApproved') return ['✔', '#4b9b6b'];
  if (type === 'CommandRejected') return ['✗', '#c04040'];
  if (type === 'AgentOutputChunk') return ['»', '#667'];
  return ['·', '#555'];
}

function _formatType(type: string): string {
  return type.replace(/([A-Z])/g, ' $1').trim();
}

function _eventDetail(evt: BridgeEvent): string {
  const d = evt.data;
  if (evt.type === 'CommandCreated') {
    const t = (d['type'] as string) ?? '';
    const tgt = (d['target'] as string) ?? '';
    return `${_esc(t)} → ${_esc(tgt.slice(0, 30))}`;
  }
  if (evt.type === 'CommandFailed' || evt.type === 'CommandCompleted') {
    const r = ((d['error'] ?? d['result'] ?? '') as string).slice(0, 60);
    return r ? _esc(r) : '';
  }
  if (evt.type === 'AgentOutputChunk') return ''; // skip chunky output
  return '';
}

// ─── Replay ───────────────────────────────────────────────────────────────────
async function _replayLast() {
  const last = [..._events]
    .filter((e) => e.type === 'CommandCreated')
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!last) return;

  const body = JSON.stringify({
    type: last.data['type'],
    target: last.data['target'],
    payload: last.data['payload'] ?? {},
    created_by: 'replay',
  });
  try {
    await fetch(bridgeUrl('/commands'), { method: 'POST', headers: bridgeHeaders({ 'Content-Type': 'application/json' }), body });
    _render();
  } catch {
    // ignore
  }
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  _panel = ensurePanel(
    'timeline-panel',
    'tl-panel hidden',
    `
    <div class="tl-header">
      <span class="tl-title">CRÓNICA — Event Timeline</span>
      <div class="tl-header-actions">
        <button id="tl-replay" title="Repetir última misión" aria-label="Repetir última misión">↺ Replay</button>
        <button id="tl-close" title="Cerrar [F10]" aria-label="Cerrar crónica de eventos">✕</button>
      </div>
    </div>
    <div class="tl-list"></div>
    <div class="tl-footer"><span id="tl-count">0 eventos</span></div>
  `,
  );
  bindPanelAction(_panel, '#tl-close', closeTimelinePanel);
  bindPanelAction(_panel, '#tl-replay', _replayLast);
  return _panel;
}

function _esc(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
