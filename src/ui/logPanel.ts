// ─── RepoCiv — Live Log Panel (Sprint D3) ────────────────────────────────────
// Side panel showing the last N lines of events.jsonl in real time.
// Polls every 2s while open; table columns: timestamp | repo | event_type | message.
// Filter <select> by event type; "Clear" button resets local view buffer.
import { bridgeUrl, bridgeHeaders } from '../bridgeEnv.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';
import {
  activityColor,
  activityPanels,
  projectActivityMetadata,
  mergeActivityPages,
  registerActivityPanel,
  activitySelection,
  eventKey,
  confirmedOutcome,
  processesFor,
  selectActivity,
  setActivityEvents,
  subscribeActivity,
  activityInventoryWarning,
} from './activityCorrelation.ts';

import { activityTitle, presentActivities } from './activityPresentation.ts';

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
let _legacyBridge = false;
let _historyBefore: number | null = null;
let _hasOlder = false;
let _lastRendered = '';

// Exposed for testing
export function getLocalBuffer(): LogEvent[] {
  return _buffer;
}

export function clearLocalBuffer(): void {
  _buffer = [];
  if (_visible) _render();
}

// ─── Public API ────────────────────────────────────────────
function toggleLogCollapse(): void {
  if (!_panel) return;
  _collapsed = !_collapsed;
  _panel.classList.toggle('collapsed', _collapsed);
  const toggleBtn = _panel.querySelector<HTMLButtonElement>('.log-toggle');
  if (toggleBtn) toggleBtn.textContent = _collapsed ? '▸' : '▾';
}

export function openLogPanel(): void {
  activityPanels.tasks?.close();
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
let _fetching = false;
async function _fetch(loadInventory = true): Promise<void> {
  if (_fetching) return;
  _fetching = true;
  try {
    const res = await fetch(bridgeUrl('/log?n=500&metadata=1&paged=1'), {
      headers: bridgeHeaders(),
    });
    if (!res.ok) {
      _offline = true;
      if (_visible) _render();
      return;
    }
    const payload = (await res.json()) as
      LogEvent[] | { events: LogEvent[]; before: number; more: boolean };
    const raw = Array.isArray(payload) ? payload : payload.events;
    if (!Array.isArray(payload) && _historyBefore === null) {
      _historyBefore = payload.before;
      _hasOlder = payload.more;
    }
    _legacyBridge = raw.some((e) => 'actor' in e);
    _buffer = mergeActivityPages(
      _buffer,
      raw.filter((e) => e.type !== 'AgentOutputChunk').map(projectActivityMetadata),
    );
    _offline = false;
    setActivityEvents(_buffer);
    if (_visible && loadInventory) await activityPanels.tasks?.refresh();
    if (_visible) _render();
  } catch {
    _offline = true;
    if (_visible) _render();
  } finally {
    _fetching = false;
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function _render(): void {
  const panel = _getOrCreate();
  const body = panel.querySelector<HTMLElement>('.log-body')!;
  const selected = activitySelection();
  const rows = filterByType(_buffer, _filter).filter((e) => !selected || eventKey(e) === selected);
  const associated = selected ? processesFor(selected) : [];
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset['focusId'];
  const names = new Map(presentActivities().map((a) => [a.commandId, a.title]));
  const html = `<div class="activity-context" role="status">${escapeHtml(activityTitle(selected))} · ${associated.length} procesos en el último inventario</div>
    <details data-detail-id="history-contract"><summary data-focus-id="history-contract">Alcance de la evidencia y del historial</summary><p>${_legacyBridge ? 'Bridge anterior: ventana histórica limitada; los nuevos vínculos requieren actualizar el bridge.' : 'Historia canónica paginada: hasta 500 metadatos / 256 KiB por consulta. La vista no acredita una historia completa; carga páginas anteriores para buscar vínculos.'} Un comando completado no valida una tarea. Sin proceso no significa éxito.</p>
    <p>run: identifica un comando; sólo TaskRunLinked acredita su pertenencia al orquestador. Procesos e historia son muestras independientes, no una fotografía atómica.</p></details>
    ${_hasOlder ? '<button class="activity-older" data-focus-id="older">Cargar historia anterior</button>' : ''}
    ${_offline ? '<p role="status">⚠ Bridge offline — vista anterior, posiblemente desactualizada</p>' : ''}
    ${activityInventoryWarning() ? `<p role="status">⚠ ${escapeHtml(activityInventoryWarning())}</p>` : ''}
    <div class="activity-processes">${associated.map((p) => `<span>PID ${p.pid} ← PPID ${p.ppid} · raíz ${p.rootPid}</span>`).join(' · ')}</div>
    ${
      rows.length
        ? `<table class="log-table" aria-label="Crónica correlacionada"><thead><tr><th>Hora</th><th>Evento</th><th>Identidad / resultado</th></tr></thead><tbody>${rows
            .map((e, index) => {
              const key = eventKey(e);
              return `<tr><td>${formatTimestamp(e.timestamp)}</td><td>${escapeHtml(e.type)}</td><td>${key ? `<button data-focus-id="${escapeHtml(e.id || `${e.type}:${e.timestamp}:${index}`)}" data-activity="${escapeHtml(key)}" aria-pressed="${key === selected}" style="--activity-color:${activityColor(key)}">⬡ ${escapeHtml(names.get(e.commandId || String(e.data?.['commandId'] ?? e.data?.['runId'] ?? '')) || activityTitle(key))}</button>` : 'sin correlación'}<br>${escapeHtml(confirmedOutcome(e))}<details data-detail-id="event:${escapeHtml(e.id || String(index))}"><summary data-focus-id="event:${escapeHtml(e.id || String(index))}">Identificadores</summary><code>${escapeHtml(key)}</code><br>Comando: ${escapeHtml(e.commandId || String(e.data?.['commandId'] ?? 'Sin comando vinculado'))}</details></td></tr>`;
            })
            .join('')}</tbody></table>`
        : '<p>Sin eventos para esta selección en la ventana disponible; no demuestra ausencia de historial.</p>'
    }`;
  if (html === _lastRendered) return;
  _lastRendered = html;
  const open = new Set(
    Array.from(body.querySelectorAll<HTMLDetailsElement>('details[open]')).map(
      (d) => d.dataset['detailId'],
    ),
  );
  const scroll = body.scrollTop;
  body.innerHTML = html;
  body.querySelectorAll<HTMLDetailsElement>('details').forEach((d) => {
    d.open = open.has(d.dataset['detailId']);
  });
  body.scrollTop = scroll;
  if (focusKey)
    Array.from(body.querySelectorAll<HTMLElement>('[data-focus-id]'))
      .find((e) => e.dataset['focusId'] === focusKey)
      ?.focus({ preventScroll: true });
  body.querySelector<HTMLButtonElement>('.activity-older')?.addEventListener('click', () => {
    void _fetchOlder();
  });
  body.querySelectorAll<HTMLButtonElement>('[data-activity]').forEach((btn) => {
    btn.onclick = () => selectActivity(btn.dataset['activity'] ?? '');
    if (focusKey === btn.dataset['focusId']) btn.focus({ preventScroll: true });
  });
}

// ─── Panel creation ───────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  _panel = ensurePanel(
    'log-panel',
    'panel log-panel hidden',
    `<div class="panel-header">
      <span class="panel-title">📜 ACTIVIDAD · CRÓNICA</span>
      <div class="log-controls">
        <button class="log-toggle" aria-label="Colapsar / desplegar" title="Colapsar / desplegar">▾</button>
        <select class="log-filter" aria-label="Filtrar por tipo">
          <option value="">Todos</option>
          <option value="CommandCreated">CommandCreated</option>
          <option value="CommandQueued">CommandQueued</option>
          <option value="CommandStarted">CommandStarted</option>
          <option value="CommandCompleted">CommandCompleted</option>
          <option value="CommandFailed">CommandFailed</option>
          <option value="ProcessBound">Proceso vinculado</option><option value="TaskRunLinked">Ejecución vinculada</option><option value="TaskPhaseRecorded">Fase del orquestador</option><option value="CommandCancelled">CommandCancelled</option>
          <option value="CommandRejected">CommandRejected</option>
        </select>
        <button class="log-clear" aria-label="Limpiar vista">Clear</button>
        <button class="log-close" aria-label="Cerrar panel">✕</button>
      </div>
    </div>
    <nav class="activity-nav" aria-label="Actividad"><button class="activity-tasks">Actividad de la selección</button><button class="activity-reset">Todas las ejecuciones</button></nav>
    <div class="log-body"></div>`,
  );
  subscribeActivity(() => {
    if (_visible) _render();
  });
  bindPanelAction(_panel, '.activity-tasks', () => {
    closeLogPanel();
    activityPanels.tasks?.open();
  });
  bindPanelAction(_panel, '.activity-reset', () => selectActivity(''));
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

export async function refreshActivityHistory(): Promise<void> {
  await _fetch(false);
}

registerActivityPanel('log', {
  open: openLogPanel,
  close: closeLogPanel,
  refresh: refreshActivityHistory,
});

async function _fetchOlder(): Promise<void> {
  if (!_hasOlder || _historyBefore === null) return;
  // A 2s poll can hold _fetching; dropping the click made "Cargar historia
  // anterior" a no-op under load (activity e2e at 1280px).
  while (_fetching) await new Promise((r) => setTimeout(r, 20));
  if (!_hasOlder || _historyBefore === null) return;
  _fetching = true;
  try {
    const response = await fetch(
      bridgeUrl(`/log?n=500&metadata=1&paged=1&before=${_historyBefore}`),
      { headers: bridgeHeaders() },
    );
    if (!response.ok) throw new Error('history unavailable');
    const page = (await response.json()) as { events: LogEvent[]; before: number; more: boolean };
    _buffer = mergeActivityPages(page.events.map(projectActivityMetadata), _buffer);
    _historyBefore = page.before;
    _hasOlder = page.more;
    _offline = false;
    setActivityEvents(_buffer);
  } catch {
    _offline = true;
  } finally {
    _fetching = false;
    if (_visible) _render();
  }
}
