// ─── RepoCiv — Agents panel (F8) ─────────────────────────────────────────────
// Every agent in one list, whether or not its repo is a city on this map:
//   · Activos      — external sessions (Claude Code, Codex, Cursor…) seen by
//                    Suvadu in the tracker window; they also stand on the map.
//   · Últimas 24 h — the same sessions once they go quiet (chat still readable).
//   · RepoCiv      — this dashboard's own units (click → their usual chat).
// Clicking an external session opens its chat (read-only, from Suvadu) and
// puts the camera on its unit — or on its city, when the repo is on the map.
import type { GameState } from '../game.ts';
import type { Axial } from '../hex.ts';
import type { Unit } from '../types.ts';
import {
  agentLabel,
  chatMessagesHtml,
  fetchExternalChat,
  fetchExternalSessions,
  formatTokens,
  isExternalAgentUnit,
  partitionSessions,
  placeOnMap,
  relativeTime,
  shortModel,
  type ExternalChat,
  type ExternalSessionRow,
  type MapPlace,
} from '../externalAgents.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';
import { escapeHtml } from './escapeHtml.ts';

const LIST_POLL_MS = 10_000;
const CHAT_POLL_MS = 15_000;

export interface AgentsPanelDeps {
  state: GameState;
  /** Center the camera on a hex and flash it (renderer.focusOnCoord + flash). */
  locate: (coord: Axial) => void;
  /** Select one of RepoCiv's own units — opens its regular chat/unit panel. */
  selectOwnUnit: (unit: Unit) => void;
}

let _deps: AgentsPanelDeps | null = null;
let _panel: HTMLElement | null = null;
let _visible = false;
let _rows: ExternalSessionRow[] | null = [];
let _chatSession: string | null = null;
let _chat: ExternalChat | null = null;
let _chatLoading = false;
let _listTimer = 0;
let _chatTimer = 0;
let _renderedKey = '';
const _refreshed = new Set<string>();

export function bindAgentsPanel(deps: AgentsPanelDeps): void {
  _deps = deps;
}

export function isAgentsPanelOpen(): boolean {
  return _visible;
}

export function openAgentsPanel(): void {
  _visible = true;
  showPanel(_getOrCreate());
  _render();
  void _loadList();
  _stopTimers();
  _listTimer = window.setInterval(() => void _loadList(), LIST_POLL_MS);
}

export function closeAgentsPanel(): void {
  _visible = false;
  _stopTimers();
  _chatSession = null;
  _chat = null;
  if (_panel) hidePanel(_panel);
}

export function toggleAgentsPanel(): void {
  if (_visible) closeAgentsPanel();
  else openAgentsPanel();
}

/** Open the chat of an external agent, by Suvadu session id or by its ext-* unit id. */
export function openExternalAgentChat(ref: string): void {
  if (!_visible) openAgentsPanel();
  const byUnit = isExternalAgentUnit(ref);
  const pick = (rows: ExternalSessionRow[] | null) =>
    rows?.find((r) => (byUnit ? r.unit === ref : r.sessionId === ref));
  const row = pick(_rows);
  if (row) {
    _openChat(row);
    return;
  }
  // Not listed yet (panel just opened): load, then retry once.
  void _loadList().then(() => {
    const again = pick(_rows);
    if (again) _openChat(again);
  });
}

// ─── Data ────────────────────────────────────────────────────────────────────
async function _loadList(): Promise<void> {
  _rows = await fetchExternalSessions();
  if (!_visible || _chatSession !== null) return;
  // Rebuild only when something changed (a rebuild drops hover/focus and a
  // click landing mid-rebuild); otherwise just tick the "hace …" labels.
  const key = _listKey();
  if (key === _renderedKey) _tickAgo();
  else _render();
}

/** The list's structure: which cards, in which state and place. Clock and
 *  counters are left out — they tick in place (_tickAgo). */
function _listKey(): string {
  const sessions = _rows?.map((r) => [r.sessionId, r.state, r.model, r.cityId, r.subagent]);
  const units = (_deps?.state.getAllUnits() ?? [])
    .filter((u) => !u.ephemeral)
    .map((u) => `${u.id}:${u.state}`);
  return JSON.stringify([sessions ?? null, units, _deps?.state.world.cities.length ?? 0]);
}

function _statsText(row: ExternalSessionRow): string {
  return [`${row.commandCount} cmd`, formatTokens(row.totalTokens)].filter(Boolean).join(' · ');
}

function _tickAgo(): void {
  const now = Date.now();
  _panel?.querySelectorAll<HTMLElement>('.agents-card').forEach((card) => {
    const row = _rows?.find((r) => r.sessionId === card.dataset['session']);
    if (!row) return;
    const ago = card.querySelector<HTMLElement>('.agents-ago');
    if (ago) ago.textContent = relativeTime(row.lastActivityAt, now);
    const stats = card.querySelector<HTMLElement>('.agents-stats');
    if (stats) stats.textContent = _statsText(row);
  });
}

async function _loadChat(refresh: boolean): Promise<void> {
  const sessionId = _chatSession;
  if (!sessionId) return;
  _chatLoading = true;
  _renderChat();
  const chat = await fetchExternalChat(sessionId, { refresh });
  if (_chatSession !== sessionId) return; // user moved on
  const firstLoad = (_chat?.messages.length ?? 0) === 0;
  _chatLoading = false;
  if (chat) _chat = chat;
  _renderChat(firstLoad);
}

function _openChat(row: ExternalSessionRow): void {
  _chatSession = row.sessionId;
  _chat = { session: row, messages: [], hasMore: false, available: false };
  _locate(row);
  // Suvadu re-imports a transcript only on prompt/stop: pull it now for a live
  // session (once per session per panel lifetime; ↻ does it on demand).
  const refresh = (row.active || !row.imported) && !_refreshed.has(row.sessionId);
  if (refresh) _refreshed.add(row.sessionId);
  void _loadChat(refresh);
  window.clearInterval(_chatTimer);
  _chatTimer = window.setInterval(() => void _loadChat(false), CHAT_POLL_MS);
}

function _backToList(): void {
  _chatSession = null;
  _chat = null;
  _renderedKey = '';
  window.clearInterval(_chatTimer);
  _chatTimer = 0;
  _render();
  void _loadList();
}

function _stopTimers(): void {
  window.clearInterval(_listTimer);
  window.clearInterval(_chatTimer);
  _listTimer = 0;
  _chatTimer = 0;
}

function _placeOf(row: ExternalSessionRow): MapPlace {
  return placeOnMap(row, _deps?.state.world.cities ?? []);
}

/** Camera to the agent's unit if it is on the map, else to its city. */
function _locate(row: ExternalSessionRow): void {
  if (!_deps) return;
  const unit = row.unit ? _deps.state.getUnit(row.unit) : undefined;
  const coord = unit?.coord ?? _placeOf(row).city?.coord;
  if (coord) _deps.locate(coord);
}

// ─── Render ──────────────────────────────────────────────────────────────────
function _whereHtml(row: ExternalSessionRow): string {
  const place = _placeOf(row);
  const repo = row.repo || '—';
  if (place.kind === 'city') {
    return `<span class="agents-where agents-where--city" title="Su repo es una ciudad del mapa">📍 ${escapeHtml(place.city.name)}</span>`;
  }
  if (place.kind === 'capital') {
    return `<span class="agents-where agents-where--capital" title="RepoCiv (la capital) o sin repo">🏛 ${escapeHtml(row.repo || 'capital')}</span>`;
  }
  return `<span class="agents-where agents-where--offmap" title="Ese repo no está en el mapa: la unidad espera en la capital">⊘ ${escapeHtml(repo)} · fuera del mapa</span>`;
}

function _cardHtml(row: ExternalSessionRow, now: number): string {
  const model = row.model
    ? `<span class="agents-model">${escapeHtml(shortModel(row.model))}</span>`
    : '';
  const sub = row.subagent ? '<span class="agents-tag">subagente</span>' : '';
  return `<button type="button" class="agents-card agents-card--${escapeHtml(row.state)}" data-session="${escapeHtml(row.sessionId)}">
    <span class="agents-dot" aria-hidden="true"></span>
    <span class="agents-card-main">
      <span class="agents-card-title">${escapeHtml(agentLabel(row.agent))} ${model} ${sub}</span>
      ${_whereHtml(row)}
    </span>
    <span class="agents-card-meta"><span class="agents-ago">${escapeHtml(relativeTime(row.lastActivityAt, now))}</span><br><span class="agents-stats">${escapeHtml(_statsText(row))}</span></span>
  </button>`;
}

function _ownUnitsHtml(): string {
  const units = (_deps?.state.getAllUnits() ?? []).filter((u) => !u.ephemeral);
  if (units.length === 0) return '<div class="agents-empty">Sin unidades propias.</div>';
  return units
    .map(
      (u) => `<button type="button" class="agents-own" data-unit="${escapeHtml(u.id)}">
        <span class="agents-dot agents-dot--${escapeHtml(u.state)}" aria-hidden="true"></span>
        <span>${escapeHtml(u.name)}</span><span class="agents-own-state">${escapeHtml(u.state)}</span>
      </button>`,
    )
    .join('');
}

function _render(): void {
  if (!_panel) return;
  const body = _panel.querySelector<HTMLElement>('.agents-body')!;
  if (_chatSession !== null) {
    _renderChat();
    return;
  }
  _renderedKey = _listKey();
  const now = Date.now();
  let external: string;
  if (_rows === null) {
    external =
      '<div class="agents-empty">⚠ No pude leer los agentes (¿bridge o Suvadu caídos?). Ver <code>/health</code> → externalAgents.</div>';
  } else {
    const { active, recent } = partitionSessions(_rows);
    const list = (rows: ExternalSessionRow[], empty: string) =>
      rows.length
        ? rows.map((r) => _cardHtml(r, now)).join('')
        : `<div class="agents-empty">${empty}</div>`;
    external = `
      <h4 class="agents-section">Activos · ${active.length}</h4>
      ${list(active, 'Ningún agente externo trabajando ahora.')}
      <h4 class="agents-section">Últimas 24 h · ${recent.length}</h4>
      ${list(recent, 'Nada más en las últimas 24 h.')}`;
  }
  body.innerHTML = `${external}
    <h4 class="agents-section">Unidades RepoCiv</h4>
    <div class="agents-own-list">${_ownUnitsHtml()}</div>
    <p class="agents-foot">Externos vía Suvadu · chat de solo lectura.</p>`;
  body.querySelectorAll<HTMLElement>('.agents-card').forEach((el) =>
    el.addEventListener('click', () => {
      const row = _rows?.find((r) => r.sessionId === el.dataset['session']);
      if (row) _openChat(row);
    }),
  );
  body.querySelectorAll<HTMLElement>('.agents-own').forEach((el) =>
    el.addEventListener('click', () => {
      const unit = _deps?.state.getUnit(el.dataset['unit'] ?? '');
      if (unit && _deps) {
        _deps.selectOwnUnit(unit);
        _deps.locate(unit.coord);
      }
    }),
  );
}

function _renderChat(firstLoad = false): void {
  if (!_panel || !_chat) return;
  const body = _panel.querySelector<HTMLElement>('.agents-body')!;
  // Keep the reader's place across the 15 s refresh; follow the tail only when
  // they were already at the bottom (or on first load).
  const prev = body.querySelector<HTMLElement>('.agents-chat-log');
  const prevTop = prev?.scrollTop ?? 0;
  const atBottom = !prev || prev.scrollTop + prev.clientHeight >= prev.scrollHeight - 40;
  const row = _chat.session;
  const status = row.active ? row.state : `inactivo · ${relativeTime(row.lastActivityAt)}`;
  let log: string;
  if (_chat.messages.length > 0) {
    const more = _chat.hasMore
      ? '<div class="agents-empty">… mensajes anteriores no mostrados</div>'
      : '';
    log = more + chatMessagesHtml(_chat.messages, row.agent);
  } else if (_chatLoading) {
    log = '<div class="agents-empty">Cargando chat…</div>';
  } else if (!_chat.available) {
    log = `<div class="agents-empty">Suvadu aún no tiene el transcript de esta sesión (${escapeHtml(_chat.error ?? 'sin datos')}). Se importa al terminar cada turno; probá ↻.</div>`;
  } else {
    log = '<div class="agents-empty">Sin mensajes todavía.</div>';
  }
  const note =
    _chat.refresh && _chat.refresh !== 'ok' && _chat.refresh !== 'throttled'
      ? `<span class="agents-refresh-note">↻ ${escapeHtml(_chat.refresh)}</span>`
      : '';
  body.innerHTML = `
    <div class="agents-chat-head">
      <button type="button" class="agents-back" aria-label="Volver a la lista">←</button>
      <div class="agents-chat-title">
        <strong>${escapeHtml(agentLabel(row.agent))}</strong> ${row.model ? escapeHtml(shortModel(row.model)) : ''}
        <div class="agents-chat-sub">${_whereHtml(row)} · ${escapeHtml(status)} ${note}</div>
      </div>
      <button type="button" class="agents-locate" title="Ubicar en el mapa" aria-label="Ubicar en el mapa">📍</button>
      <button type="button" class="agents-refresh" title="Actualizar (reimporta el transcript)" aria-label="Actualizar">${_chatLoading ? '…' : '↻'}</button>
    </div>
    <div class="agents-chat-log">${log}</div>
    <p class="agents-foot">Solo lectura. Para responder, usá la terminal de ese agente.</p>`;
  bindPanelAction(body, '.agents-back', _backToList);
  bindPanelAction(body, '.agents-locate', () => _locate(row));
  bindPanelAction(body, '.agents-refresh', () => void _loadChat(true));
  const logEl = body.querySelector<HTMLElement>('.agents-chat-log');
  if (logEl) logEl.scrollTop = firstLoad || atBottom ? logEl.scrollHeight : prevTop;
}

function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  _panel = ensurePanel(
    'agents-panel',
    'panel agents-panel hidden',
    `<div class="agents-header">
      <span class="agents-title">🤖 Agentes</span>
      <button class="agents-close" aria-label="Cerrar panel" title="Cerrar [F8]">✕</button>
    </div>
    <div class="agents-body"></div>`,
  );
  bindPanelAction(_panel, '.agents-close', closeAgentsPanel);
  return _panel;
}
