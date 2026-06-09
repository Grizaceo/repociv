// ─── RepoCiv — Live Log Panel (Sprint D3) ────────────────────────────────────
// Side panel showing the last N lines of events.jsonl in real time.
// Polls every 2s while open; table columns: timestamp | repo | event_type | message.
// Filter <select> by event type; "Clear" button resets local view buffer.
import { bridgeUrl } from '../bridgeEnv.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';
import { escapeHtml } from './escapeHtml.ts';

export const POLL_MS = 2_000;

export const COLUMN_HEADERS = ['Timestamp', 'Repo', 'Tipo', 'Mensaje'] as const;

// ─── Types ────────────────────────────────────────────────────────────────────
export interface LogEvent {
  id?: string;
  commandId?: string;
  type: string;
  timestamp: number;
  actor?: string;
  data?: Record<string, unknown>;
}

// ─── Pure helpers (exported for testing) ─────────────────────────────────────

export function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function filterByType(events: LogEvent[], type: string): LogEvent[] {
  if (!type) return events;
  return events.filter((e) => e.type === type);
}

export function buildLogRow(e: LogEvent): string {
  const ts = formatTimestamp(e.timestamp);
  const data = e.data ?? {};
  const repo = String(data['repo'] ?? '—');
  const msg = String(data['result'] ?? data['error'] ?? data['text'] ?? e.actor ?? '—');
  return `<tr>
    <td class="log-ts">${ts}</td>
    <td class="log-repo">${escapeHtml(repo)}</td>
    <td class="log-type">${escapeHtml(e.type)}</td>
    <td class="log-msg">${escapeHtml(msg)}</td>
  </tr>`;
}

export function buildBodyHTML(events: LogEvent[] | null): string {
  if (events === null) {
    return '<div class="log-offline">⚠ Bridge offline — sin datos</div>';
  }
  if (events.length === 0) {
    return '<div class="log-empty">Sin eventos registrados</div>';
  }
  return `
    <table class="log-table" aria-label="Log en vivo">
      <thead>
        <tr>${COLUMN_HEADERS.map((h) => `<th>${h}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${events.map((e) => buildLogRow(e)).join('')}
      </tbody>
    </table>
  `;
}

// ─── Module state ─────────────────────────────────────────────────────────────
let _panel: HTMLElement | null = null;
let _timer = 0;
let _visible = false;
let _collapsed = false;
let _buffer: LogEvent[] = [];
let _offline = false;
let _filter = '';

// Exposed for testing
export function getLocalBuffer(): LogEvent[] {
  return _buffer;
}

export function clearLocalBuffer(): void {
  _buffer = [];
  if (_visible) _render();
}

// ─── Public API ────────────────────────────────────────────
export function toggleLogCollapse(): void {
  if (!_panel) return;
  _collapsed = !_collapsed;
  _panel.classList.toggle('collapsed', _collapsed);
  const toggleBtn = _panel.querySelector<HTMLButtonElement>('.log-toggle');
  if (toggleBtn) toggleBtn.textContent = _collapsed ? '▸' : '▾';
}

export function openLogPanel(): void {
  _visible = true;
  showPanel(_getOrCreate());
  void _fetch();
  _startPolling();
}

export function closeLogPanel(): void {
  _visible = false;
  _stopPolling();
  if (_panel) hidePanel(_panel);
}

export function isLogPanelOpen(): boolean {
  return _visible;
}

export function toggleLogPanel(): void {
  if (_visible) closeLogPanel();
  else openLogPanel();
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

// ─── Data fetch ───────────────────────────────────────────────────────────────
async function _fetch(): Promise<void> {
  try {
    const typeParam = _filter ? `&type=${encodeURIComponent(_filter)}` : '';
    const res = await fetch(bridgeUrl(`/log?n=100${typeParam}`));
    if (!res.ok) {
      _offline = true;
      if (_visible) _render();
      return;
    }
    _buffer = (await res.json()) as LogEvent[];
    _offline = false;
    if (_visible) _render();
  } catch {
    _offline = true;
    if (_visible) _render();
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function _render(): void {
  const panel = _getOrCreate();
  const body = panel.querySelector<HTMLElement>('.log-body')!;
  body.innerHTML = buildBodyHTML(_offline ? null : _buffer);
}

// ─── Panel creation ───────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  _panel = ensurePanel(
    'log-panel',
    'panel log-panel hidden',
    `<div class="panel-header">
      <span class="panel-title">📜 Log en vivo</span>
      <div class="log-controls">
        <button class="log-toggle" aria-label="Colapsar / desplegar" title="Colapsar / desplegar">▾</button>
        <select class="log-filter" aria-label="Filtrar por tipo">
          <option value="">Todos</option>
          <option value="CommandCreated">CommandCreated</option>
          <option value="CommandQueued">CommandQueued</option>
          <option value="CommandStarted">CommandStarted</option>
          <option value="CommandCompleted">CommandCompleted</option>
          <option value="CommandFailed">CommandFailed</option>
          <option value="AgentOutputChunk">AgentOutputChunk</option>
          <option value="CommandRejected">CommandRejected</option>
        </select>
        <button class="log-clear" aria-label="Limpiar vista">Clear</button>
        <button class="log-close" aria-label="Cerrar panel">✕</button>
      </div>
    </div>
    <div class="log-body"></div>`,
  );
  bindPanelAction(_panel, '.log-close', closeLogPanel);
  bindPanelAction(_panel, '.log-toggle', toggleLogCollapse);
  _panel.querySelector('.log-clear')?.addEventListener('click', () => {
    clearLocalBuffer();
  });
  _panel.querySelector('.log-filter')?.addEventListener('change', (e) => {
    _filter = (e.target as HTMLSelectElement).value;
    void _fetch();
  });
  return _panel;
}
