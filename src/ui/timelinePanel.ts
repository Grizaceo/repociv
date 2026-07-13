// RepoCiv — canonical task lifecycle / evidence panel. Hotkey: F10.
import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';
import { bindPanelAction, ensurePanel, hidePanel, showPanel } from './panelShell.ts';
import {
  canCancelLifecycle,
  latestByCommand,
  lifecycleSnapshotEqual,
  lifecycleDetail,
  type LifecycleEvent,
} from './taskTimeline.ts';

const POLL_INTERVAL_MS = 5_000;
let _panel: HTMLElement | null = null;
let _pollTimer = 0;
let _lastTs = 0;
let _events: LifecycleEvent[] = [];
let _visible = false;

export function openTimelinePanel(): void {
  _visible = true;
  showPanel(_getOrCreate());
  _render();
  void _fetchEvents();
  _startPolling();
}

export function closeTimelinePanel(): void {
  _visible = false;
  if (_panel) hidePanel(_panel);
  _stopPolling();
}

export function isTimelinePanelOpen(): boolean {
  return _visible;
}

export function toggleTimelinePanel(): void {
  if (_visible) closeTimelinePanel();
  else openTimelinePanel();
}

function _startPolling(): void {
  _stopPolling();
  _pollTimer = window.setInterval(() => void _fetchEvents(), POLL_INTERVAL_MS);
}

function _stopPolling(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = 0;
  }
}

async function _fetchEvents(): Promise<void> {
  try {
    const res = await fetch(bridgeUrl(`/events?since=${_lastTs}`), { headers: bridgeHeaders() });
    if (!res.ok) return;
    const fresh = (await res.json()) as LifecycleEvent[];
    const seen = new Set(_events.map((event) => event.id));
    const uniqueFresh = fresh.filter((event) => !seen.has(event.id));
    if (uniqueFresh.length === 0) return;
    const merged = [..._events, ...uniqueFresh].slice(-500);
    if (lifecycleSnapshotEqual(_events, merged)) return;
    _events = merged;
    _lastTs = Math.max(...uniqueFresh.map((event) => event.timestamp));
    if (_visible) _render();
  } catch {
    // Keep the last durable snapshot visible while the bridge reconnects.
  }
}

async function _cancelCommand(event: LifecycleEvent): Promise<void> {
  const path =
    event.type === 'CommandWaitingApproval'
      ? `/approvals/${event.commandId}/reject`
      : `/commands/${event.commandId}/cancel`;
  await fetch(bridgeUrl(path), {
    method: 'POST',
    headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
    body: '{}',
  });
  _lastTs = 0;
  _events = [];
  await _fetchEvents();
}

async function _showEvidence(commandId: string, host: HTMLElement): Promise<void> {
  const output = host.querySelector<HTMLElement>('.tl-evidence');
  if (!output) return;
  if (output.dataset['expanded'] === 'true') {
    output.textContent = '';
    output.dataset['expanded'] = 'false';
    return;
  }
  output.dataset['expanded'] = 'true';
  output.textContent = 'Cargando evidencia…';
  try {
    const response = await fetch(bridgeUrl(`/commands/${commandId}/artifacts`), {
      headers: bridgeHeaders(),
    });
    const body = (await response.json()) as Record<string, unknown>;
    const compact = {
      schemaVersion: body['schemaVersion'],
      commandId: body['commandId'],
      terminalEvent: body['terminalEvent'],
      artifactRefs: body['artifactRefs'],
      runState: body['runState'],
    };
    output.textContent = response.ok
      ? JSON.stringify(compact, null, 2)
      : `Error ${response.status}`;
  } catch {
    output.textContent = 'Bridge offline — evidencia no disponible';
  }
}

function _render(): void {
  const panel = _getOrCreate();
  const list = panel.querySelector<HTMLElement>('.tl-list')!;
  const sorted = [...latestByCommand(_events).values()].sort((a, b) => b.timestamp - a.timestamp);

  if (sorted.length === 0) {
    list.innerHTML =
      '<div class="tl-empty">Sin tareas. Selecciona un repo y envía una misión.</div>';
    return;
  }

  list.innerHTML = sorted.map(_row).join('');
  list.querySelectorAll<HTMLElement>('.tl-entry').forEach((row) => {
    const commandId = row.dataset['cmd'] ?? '';
    row.querySelector<HTMLButtonElement>('.tl-evidence-btn')?.addEventListener('click', () => {
      void _showEvidence(commandId, row);
    });
    row.querySelector<HTMLButtonElement>('.tl-cancel-btn')?.addEventListener('click', () => {
      const event = sorted.find((candidate) => candidate.commandId === commandId);
      if (event) void _cancelCommand(event);
    });
  });
}

function _row(event: LifecycleEvent): string {
  const time = new Date(event.timestamp * 1000).toLocaleTimeString('es-CL', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const [dot, color] = _eventStyle(event.type);
  const detail = lifecycleDetail(event);
  const cancel = canCancelLifecycle(event.type)
    ? '<button class="tl-cancel-btn" aria-label="Cancelar tarea">Cancelar</button>'
    : '';
  return `
    <div class="tl-entry" data-cmd="${_esc(event.commandId)}">
      <span class="tl-dot" style="background:${color}" title="${_esc(event.type)}">${dot}</span>
      <div class="tl-body">
        <span class="tl-type">${_esc(_formatType(event.type))}</span>
        ${detail ? `<span class="tl-detail">${_esc(detail)}</span>` : ''}
        <span class="tl-cmd-id">${_esc(event.commandId.slice(0, 12))}</span>
        <pre class="tl-evidence" aria-live="polite"></pre>
      </div>
      <div class="tl-actions">
        <button class="tl-evidence-btn" aria-label="Ver evidencia">Evidencia</button>
        ${cancel}
        <span class="tl-time">${time}</span>
      </div>
    </div>`;
}

function _eventStyle(type: string): [string, string] {
  if (type === 'CommandCompleted') return ['✓', '#5b9b5b'];
  if (type === 'CommandFailed' || type === 'CommandRejected') return ['✗', '#d45b5b'];
  if (type === 'CommandStarted') return ['▶', '#5b9bd5'];
  if (type === 'CommandQueued') return ['⏳', '#c8a84b'];
  if (type === 'CommandWaitingApproval') return ['⚠', '#e8a040'];
  return ['·', '#777'];
}

function _formatType(type: string): string {
  return type
    .replace(/^Command/, '')
    .replace(/([A-Z])/g, ' $1')
    .trim();
}

function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  _panel = ensurePanel(
    'timeline-panel',
    'tl-panel hidden',
    `<div class="tl-header">
      <span class="tl-title">TAREAS — ESTADO Y EVIDENCIA</span>
      <button id="tl-close" title="Cerrar [F10]" aria-label="Cerrar tareas">✕</button>
    </div>
    <div class="tl-list"></div>`,
  );
  bindPanelAction(_panel, '#tl-close', closeTimelinePanel);
  return _panel;
}

function _esc(value: string): string {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}
