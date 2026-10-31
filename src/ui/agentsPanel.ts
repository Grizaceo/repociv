// ─── RepoCiv — Agents panel (F8) ─────────────────────────────────────────────
// Every agent in one list, whether or not its repo is a city on this map:
//   · Activos      — external sessions (Claude Code, Codex, Cursor… via Suvadu;
//                    Hermes via its state.db) in the tracker window; they also
//                    stand on the map.
//   · Últimas 24 h — the same sessions once they go quiet (chat still readable).
//   · Cron / Gateway — Hermes cron jobs and gateway chats (Telegram…): listed
//                    only, never on the map (collapsed by default).
//   · RepoCiv      — this dashboard's own units (click → their usual chat).
// Clicking an external session opens its chat and puts the camera on its unit
// — or on its city, when the repo is on the map.
//
import type { GameState } from '../game.ts';
import type { Axial } from '../hex.ts';
import type { Unit } from '../types.ts';
import { agentLocation } from './agentLocation.ts';
import {
  formatTokens,
  isExternalAgentUnit,
  partitionSessions,
  placeOnMap,
  relativeTime,
  sessionLabel,
  shortModel,
  stateBadge,
  type ExternalSessionRow,
  type MapPlace,
} from '../externalAgents.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';
import { escapeHtml } from './escapeHtml.ts';
import { initAgentWindow, openAgentWindow } from './agentWindow.ts';
import { createAgentsChat } from './agentsChat.ts';
import type { RepoCivProfile } from '../agentProfile.ts';
import type { CommandResponse } from '../commandSchema.ts';
import { HERDR_AGENT_LABELS, type HerdrLaunchDraft } from './agentSessionStart.ts';
import { openAgentSessionWizard, type SessionStartResult } from './agentSessionWizard.ts';
import { openProfileStudio } from './agentProfileStrip.ts';
import { closeOwnSession } from '../ownSessions.ts';
import {
  refreshExternalSessionDirectory,
  subscribeExternalSessionDirectory,
} from './externalSessionDirectory.ts';

export { composerState, performExternalSend } from './agentsChat.ts';
export type { ComposerState, ExternalSendOutcome } from './agentsChat.ts';

export interface AgentsPanelDeps {
  state: GameState;
  /** Center the camera on a hex and flash it (renderer.focusOnCoord + flash). */
  locate: (coord: Axial) => void;
  /** Select one of RepoCiv's own units — opens its regular chat/unit panel. */
  selectOwnUnit: (unit: Unit) => void;
  /** Submit and materialize a confirmed profile/city/mission session. */
  startSession: (draft: {
    profile: RepoCivProfile;
    cityId: string;
    mission: string;
  }) => Promise<SessionStartResult>;
  startHerdrSession: (draft: HerdrLaunchDraft) => Promise<CommandResponse>;
}

let _deps: AgentsPanelDeps | null = null;
let _panel: HTMLElement | null = null;
let _visible = false;
let _rows: ExternalSessionRow[] | null = [];
let _stopDirectory: (() => void) | null = null;
let _stopOwnUnits: (() => void) | null = null;
let _renderedKey = '';
/** Collapsible sections (cron, gateway) the user opened; survives list rebuilds. */
const _openSections = new Set<string>();
const _chatView = createAgentsChat({
  getPanel: () => _panel,
  locate: locateExternalAgent,
  whereHtml: _whereHtml,
  render: _render,
  loadList: _loadList,
  invalidateList: () => { _renderedKey = ''; },
});

export function bindAgentsPanel(deps: AgentsPanelDeps): void {
  _deps = deps;
  initAgentWindow({ locate: locateExternalAgent });
}

export function isAgentsPanelOpen(): boolean {
  return _visible;
}

export function openAgentsPanel(): void {
  _visible = true;
  showPanel(_getOrCreate());
  _watchExternalSessions();
  _stopOwnUnits?.();
  _stopOwnUnits =
    _deps?.state.subscribe(() => {
      if (_visible && _chatView.sessionId === null && _listKey() !== _renderedKey) _render();
    }) ?? null;
  _render();
  void _loadList();
  _chatView.stopTimers();
}

export function closeAgentsPanel(): void {
  _visible = false;
  _chatView.stopTimers();
  _stopDirectory?.();
  _stopDirectory = null;
  _stopOwnUnits?.();
  _stopOwnUnits = null;
  _chatView.clear();
  if (_panel) hidePanel(_panel);
}

export function toggleAgentsPanel(): void {
  if (_visible) closeAgentsPanel();
  else openAgentsPanel();
}

/** Opens the intentional-session wizard from F8 or a legacy creation shortcut. */
export function openNewAgentSession(
  options: { profileName?: string; harness?: RepoCivProfile['harness'] } = {},
): void {
  if (!_deps) return;
  void openAgentSessionWizard(
    { state: _deps.state, startSession: _deps.startSession, startHerdrSession: _deps.startHerdrSession },
    {
      ...options,
      // Nueva sesión = entrar a conversar: cuando el bridge acepta la sesión,
      // F8 cae directamente en el chat de esa unidad con el compositor listo.
      onStarted: (unitId) => {
        if (unitId) focusOwnChat(unitId);
        else _render();
      },
      onHerdrStarted: (draft, cityName, result) => {
        openAgentWindow({
          terminalId: null, paneId: '', kind: draft.kind, label: HERDR_AGENT_LABELS[draft.kind],
          place: cityName, sessionId: null, status: result.status,
          launch: { commandId: result.commandId, mission: draft.mission },
        });
      },
    },
  );
}

/** Open the chat of one of RepoCiv's own sessions, straight from the list. */
export function focusOwnChat(unitId: string): void {
  const unit = _deps?.state.getUnit(unitId);
  if (unit && _deps) {
    // Select first: opening the panel re-renders the list and must not
    // swallow a click that already identified the unit.
    _deps.selectOwnUnit(unit);
    if (!_visible) openAgentsPanel();
    return;
  }
  // Not materialized yet (panel just opened): fall back to the list.
  if (!_visible) openAgentsPanel();
  _render();
}

/** Open the chat of an external agent, by session id or by its ext-* unit id. */
export function openExternalAgentChat(ref: string): void {
  if (!_visible) openAgentsPanel();
  const byUnit = isExternalAgentUnit(ref);
  const pick = (rows: ExternalSessionRow[] | null) =>
    rows?.find((r) => (byUnit ? r.unit === ref : r.sessionId === ref));
  const row = pick(_rows);
  if (row) {
    _chatView.open(row);
    return;
  }
  // Not listed yet (panel just opened): load, then retry once.
  void _loadList().then(() => {
    const again = pick(_rows);
    if (again) _chatView.open(again);
  });
}

// ─── Data ────────────────────────────────────────────────────────────────────
function _watchExternalSessions(): void {
  if (_stopDirectory) return;
  _stopDirectory = subscribeExternalSessionDirectory((rows) => {
    _rows = rows;
    if (!_visible || _chatView.sessionId !== null) return;
    const key = _listKey();
    if (key === _renderedKey) _tickAgo();
    else _render();
  });
}

async function _loadList(): Promise<void> {
  await refreshExternalSessionDirectory();
}

/** The list's structure: which cards, in which state and place. Clock and
 *  counters are left out — they tick in place (_tickAgo). */
function _listKey(): string {
  const sessions = _rows?.map((r) => [
    r.sessionId,
    r.state,
    r.model,
    r.cityId,
    r.subagent,
    r.section,
    r.liveChat,
    r.herdrPane,
  ]);
  const units = (_deps?.state.getAllUnits() ?? [])
    .filter((u) => !u.ephemeral)
    .map((u) => [u.id, u.name, u.state, u.cityId, u.mission]);
  return JSON.stringify([sessions ?? null, units, _deps?.state.world.cities.length ?? 0]);
}

function _isHermes(row: ExternalSessionRow): boolean {
  return row.source === 'hermes';
}

function _statsText(row: ExternalSessionRow): string {
  const unit = _isHermes(row) ? 'tools' : 'cmd';
  return [`${row.commandCount} ${unit}`, formatTokens(row.totalTokens)].filter(Boolean).join(' · ');
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

function _placeOf(row: ExternalSessionRow): MapPlace {
  return placeOnMap(row, _deps?.state.world.cities ?? []);
}

/** Camera to the agent's unit if it is on the map, else to its city. */
function locateExternalAgent(row: ExternalSessionRow): void {
  if (!_deps) return;
  const unit = row.unit ? _deps.state.getUnit(row.unit) : undefined;
  const coord = _placeOf(row).city?.coord ?? unit?.coord;
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
  const badge = stateBadge(row.state);
  const busy = badge
    ? `<span class="agents-busy agents-busy--${escapeHtml(row.state)}" title="${escapeHtml(badge.title)}">${escapeHtml(badge.text)}</span>`
    : '';
  const origin =
    row.origin && row.origin !== row.section && row.origin !== 'subagent'
      ? `<span class="agents-tag" title="Cómo se inició la sesión">${escapeHtml(row.origin)}</span>`
      : '';
  return `<button type="button" class="agents-card agents-card--${escapeHtml(row.state)}" data-session="${escapeHtml(row.sessionId)}">
    <span class="agents-dot" aria-hidden="true"></span>
    <span class="agents-card-main">
      <span class="agents-card-title">${escapeHtml(sessionLabel(row))} ${model} ${busy} ${origin} ${sub}</span>
      ${_whereHtml(row)}
    </span>
    <span class="agents-card-meta"><span class="agents-ago">${escapeHtml(relativeTime(row.lastActivityAt, now))}</span><br><span class="agents-stats">${escapeHtml(_statsText(row))}</span></span>
  </button>`;
}

/** Explicit retire of an own session: confirm → POST close → re-render. */
async function _closeOwnSession(unitId: string): Promise<void> {
  if (!unitId) return;
  const unit = _deps?.state.getUnit(unitId);
  const label = unit?.name ?? unitId;
  if (
    !window.confirm(
      `¿Cerrar la sesión de ${label}? La unidad se retira del mapa (el transcript queda en el store).`,
    )
  )
    return;
  const ok = await closeOwnSession(unitId);
  if (ok) _render();
}

function _ownUnitsHtml(): string {
  // Names, city labels and missions are escaped before insertion into the static markup.
  const units = (_deps?.state.getAllUnits() ?? []).filter((u) => !u.ephemeral);
  if (units.length === 0) return '<div class="agents-empty">Sin unidades propias.</div>';
  return units
    .map(
      (u) => `<button type="button" class="agents-own" data-unit="${escapeHtml(u.id)}">
        <span class="agents-dot agents-dot--${escapeHtml(u.state)}" aria-hidden="true"></span>
        <span>${escapeHtml(u.name)}${u.cityId ? ` · 📍 ${escapeHtml(_deps?.state.world.cities.find((c) => c.id === u.cityId)?.name ?? u.cityId)}` : ''}${u.mission ? `<small class="agents-own-mission">${escapeHtml(u.mission)}</small>` : ''}</span><span class="agents-own-state">${escapeHtml(u.state)}</span>
        <span class="agents-own-close" role="button" tabindex="0" aria-label="Cerrar sesión ${escapeHtml(u.id)}" title="Cerrar sesión (retira la unidad del mapa)">✕</span>
      </button>`,
    )
    .join('');
}

function _render(): void {
  if (!_panel) return;
  const body = _panel.querySelector<HTMLElement>('.agents-body');
  if (!body) return;
  if (_chatView.sessionId !== null) {
    _chatView.render();
    return;
  }
  body.classList.remove('agents-body--chat');
  _renderedKey = _listKey();
  const now = Date.now();
  let external: string;
  if (_rows === null) {
    external =
      '<div class="agents-empty">⚠ No pude leer los agentes (¿bridge o Suvadu caídos?). Ver <code>/health</code> → externalAgents.</div>';
  } else {
    const { active, recent, cron, gateway } = partitionSessions(_rows);
    const list = (rows: ExternalSessionRow[], empty: string) =>
      rows.length
        ? rows.map((r) => _cardHtml(r, now)).join('')
        : `<div class="agents-empty">${empty}</div>`;
    // Cron and gateway sessions never go on the map; they fold away unless
    // there is one running, or the user opened the section.
    const folded = (key: string, title: string, rows: ExternalSessionRow[], hint: string) => {
      if (rows.length === 0) return '';
      const live = rows.filter((r) => r.active).length;
      const open = _openSections.has(key) ? ' open' : '';
      const count = live
        ? `${rows.length} · ${live} activa${live > 1 ? 's' : ''}`
        : `${rows.length}`;
      return `<details class="agents-fold" data-fold="${key}"${open}>
        <summary class="agents-section" title="${escapeHtml(hint)}">${title} · ${count}</summary>
        ${list(rows, '')}
      </details>`;
    };
    external = `
      <h4 class="agents-section">Activos · ${active.length}</h4>
      ${list(active, 'Ningún agente externo trabajando ahora.')}
      <h4 class="agents-section">Últimas 24 h · ${recent.length}</h4>
      ${list(recent, 'Nada más en las últimas 24 h.')}
      ${folded('cron', 'Cron (Hermes)', cron, 'Tareas programadas de Hermes: solo aquí, no en el mapa')}
      ${folded('gateway', 'Gateway (Hermes)', gateway, 'Chats de Telegram / API de Hermes: solo aquí, no en el mapa')}`;
  }
  body.innerHTML = `
    <h4 class="agents-section">RepoCiv · sesiones propias</h4>
    <div class="agents-own-list">${_ownUnitsHtml()}</div>
    ${external}
    <p class="agents-foot">Externos vía Suvadu y Hermes · escritura solo por canales verificados.</p>`;
  body.querySelectorAll<HTMLDetailsElement>('.agents-fold').forEach((el) =>
    el.addEventListener('toggle', () => {
      const key = el.dataset['fold'] ?? '';
      if (el.open) _openSections.add(key);
      else _openSections.delete(key);
    }),
  );
  body.querySelectorAll<HTMLElement>('.agents-card').forEach((el) =>
    el.addEventListener('click', () => {
      const row = _rows?.find((r) => r.sessionId === el.dataset['session']);
      if (row) _chatView.open(row);
    }),
  );
  body.querySelectorAll<HTMLElement>('.agents-own').forEach((el) =>
    el.addEventListener('click', () => {
      const unit = _deps?.state.getUnit(el.dataset['unit'] ?? '');
      if (unit && _deps) {
        _deps.selectOwnUnit(unit);
        _deps.locate(agentLocation(unit, _deps.state.world.cities));
      }
    }),
  );
  body.querySelectorAll<HTMLElement>('.agents-own-close').forEach((el) =>
    el.addEventListener('click', (ev) => {
      ev.stopPropagation(); // the row's click selects/locates; ✕ must not
      void _closeOwnSession(el.closest<HTMLElement>('.agents-own')?.dataset['unit'] ?? '');
    }),
  );
}

function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  _panel = ensurePanel(
    'agents-panel',
    'panel agents-panel hidden',
    `<div class="agents-header">
      <span class="agents-title">🤖 Agentes</span>
      <div class="agents-header-actions">
        <button class="agents-profiles" title="Editar perfiles de agente">Perfiles</button>
        <button class="agents-new-session" title="Nueva sesión">+ Sesión</button>
        <button class="agents-close" aria-label="Cerrar panel" title="Cerrar [F8]">✕</button>
      </div>
    </div>
    <div class="agents-body"></div>`,
  );
  bindPanelAction(_panel, '.agents-close', closeAgentsPanel);
  bindPanelAction(_panel, '.agents-profiles', openProfileStudio);
  bindPanelAction(_panel, '.agents-new-session', () => openNewAgentSession());
  return _panel;
}
