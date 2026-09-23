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
// The chat reads the session's own transcript. A live session is writable only
// when its row advertises a verified liveChat capability; quiet sessions keep
// the existing one-turn resume flow. ⏎ still hands back the terminal command.
import type { GameState } from '../game.ts';
import type { Axial } from '../hex.ts';
import type { Unit } from '../types.ts';
import {
  chatMessagesHtml,
  fetchExternalChat,
  fetchExternalResume,
  formatTokens,
  isExternalAgentUnit,
  partitionSessions,
  placeOnMap,
  relativeTime,
  replyErrorText,
  sendExternalChat,
  sendExternalReply,
  sessionLabel,
  shortModel,
  stateBadge,
  type ExternalChat,
  type ExternalChatError,
  type ExternalLiveChatResult,
  type ExternalReplyRun,
  type ExternalResume,
  type ExternalSessionRow,
  type MapPlace,
} from '../externalAgents.ts';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';
import { clipboardWrite } from './chat/clipboard.ts';
import { escapeHtml } from './escapeHtml.ts';
import type { RepoCivProfile } from '../agentProfile.ts';
import { openAgentSessionWizard, type SessionStartResult } from './agentSessionWizard.ts';
import { openProfileStudio } from './agentProfileStrip.ts';
import { closeOwnSession } from '../ownSessions.ts';
import {
  refreshExternalSessionDirectory,
  subscribeExternalSessionDirectory,
} from './externalSessionDirectory.ts';

const CHAT_POLL_MS = 15_000;

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
}

let _deps: AgentsPanelDeps | null = null;
let _panel: HTMLElement | null = null;
let _visible = false;
let _rows: ExternalSessionRow[] | null = [];
let _chatSession: string | null = null;
let _chat: ExternalChat | null = null;
let _chatLoading = false;
/** The open chat's resume plan, once the user asked for it (null = not asked). */
let _resume: ExternalResume | null = null;
let _resumeCopied = false;
/** Composer state. The draft survives the 15 s re-render. */
let _draft = '';
let _replyError = '';
let _sending = false;
let _stopDirectory: (() => void) | null = null;
let _chatTimer = 0;
let _renderedKey = '';
const _refreshed = new Set<string>();
/** Collapsible sections (cron, gateway) the user opened; survives list rebuilds. */
const _openSections = new Set<string>();

export function bindAgentsPanel(deps: AgentsPanelDeps): void {
  _deps = deps;
}

export function isAgentsPanelOpen(): boolean {
  return _visible;
}

export function openAgentsPanel(): void {
  _visible = true;
  showPanel(_getOrCreate());
  _watchExternalSessions();
  _render();
  void _loadList();
  _stopTimers();
}

export function closeAgentsPanel(): void {
  _visible = false;
  _stopTimers();
  _stopDirectory?.();
  _stopDirectory = null;
  _chatSession = null;
  _chat = null;
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
    { state: _deps.state, startSession: _deps.startSession },
    {
      ...options,
      // Nueva sesión = entrar a conversar: cuando el bridge acepta la sesión,
      // F8 cae directamente en el chat de esa unidad con el compositor listo.
      onStarted: (unitId) => {
        if (unitId) focusOwnChat(unitId);
        else _render();
      },
    },
  );
}

/** Open the chat of one of RepoCiv's own sessions, straight from the list. */
export function focusOwnChat(unitId: string): void {
  const unit = _deps?.state.getUnit(unitId);
  if (!unit || !_deps) {
    // Not materialized yet (panel just opened): fall back to the list.
    if (!_visible) openAgentsPanel();
    _render();
    return;
  }
  if (!_visible) openAgentsPanel();
  _deps.selectOwnUnit(unit);
}

/** Open the chat of an external agent, by session id or by its ext-* unit id. */
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
function _watchExternalSessions(): void {
  if (_stopDirectory) return;
  _stopDirectory = subscribeExternalSessionDirectory((rows) => {
    _rows = rows;
    if (!_visible || _chatSession !== null) return;
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
  ]);
  const units = (_deps?.state.getAllUnits() ?? [])
    .filter((u) => !u.ephemeral)
    .map((u) => `${u.id}:${u.state}`);
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
  _resume = null;
  _resumeCopied = false;
  _draft = '';
  _replyError = '';
  _sending = false;
  _locate(row);
  // Suvadu re-imports a transcript only on prompt/stop: pull it now for a live
  // session (once per session per panel lifetime; ↻ does it on demand).
  // Hermes reads its live database: nothing to import.
  const refresh =
    !_isHermes(row) && (row.active || !row.imported) && !_refreshed.has(row.sessionId);
  if (refresh) _refreshed.add(row.sessionId);
  void _loadChat(refresh);
  window.clearInterval(_chatTimer);
  _chatTimer = window.setInterval(() => void _loadChat(false), CHAT_POLL_MS);
}

/**
 * Ask the bridge how to pick this session back up, and put the command on the
 * clipboard in the same click — the point is not having to go hunt for it.
 * Nothing is executed here: the user runs it in their own terminal.
 */
async function _loadResume(): Promise<void> {
  const sessionId = _chatSession;
  if (!sessionId) return;
  const plan = await fetchExternalResume(sessionId);
  if (_chatSession !== sessionId) return; // the user moved on while it loaded
  _resume = plan ?? {
    mode: 'unavailable',
    command: '',
    agent: '',
    live: null,
    note: 'No pude pedirle el comando al bridge.',
  };
  _resumeCopied =
    _resume.mode === 'resume' && _resume.command !== '' && clipboardWrite(_resume.command);
  _renderChat();
}

export interface ComposerState {
  enabled: boolean;
  mode: 'live' | 'reply' | 'disabled';
  hint: string;
}

const LIVE_CHAT_REASON_TEXT: Record<string, string> = {
  codex_probe_pending: 'El canal de esta sesión todavía se debe verificar.',
  hermes_probe_pending: 'El canal de esta sesión todavía se debe verificar.',
  codex_queue_unavailable: 'Codex Queue no está disponible para esta sesión.',
  hermes_not_live_bot_chat: 'Esta sesión Hermes no admite chat vivo seguro.',
  profile_key_unavailable: 'Falta la autorización local del perfil para este canal.',
  claude_control_channel_unavailable: 'Claude no ofrece un canal vivo verificado para esta sesión.',
  unsupported_session_source: 'El chat vivo no está disponible para esta sesión.',
};

function isQuietSession(row: ExternalSessionRow): boolean {
  return !row.active || row.state === 'idle' || row.state === 'inactive';
}

/** Public behavior contract for enabling the external-session composer. */
export function composerState(
  row: ExternalSessionRow,
  flags: { sending?: boolean; replyRunning?: boolean } = {},
): ComposerState {
  if (isQuietSession(row)) {
    const busy = flags.sending || flags.replyRunning;
    return {
      enabled: !busy,
      mode: 'reply',
      hint: busy
        ? '⏳ Turno en curso. Su respuesta aparece en el chat cuando termine.'
        : 'Reanuda la sesión y corre un turno. No es un chat en vivo: el agente no está escuchando.',
    };
  }
  if (row.liveChat?.state === 'available') {
    return {
      enabled: !flags.sending,
      mode: 'live',
      hint: flags.sending
        ? '⏳ Enviando al canal vivo. No se reintenta automáticamente.'
        : 'Chat en vivo mediante el canal verificado de esta sesión.',
    };
  }
  const reason = row.liveChat?.reason ?? 'unsupported_session_source';
  return {
    enabled: false,
    mode: 'disabled',
    hint:
      LIVE_CHAT_REASON_TEXT[reason] ??
      (row.liveChat?.state === 'probe_required'
        ? 'El canal de esta sesión todavía se debe verificar.'
        : 'El chat vivo no está disponible para esta sesión.'),
  };
}

interface ExternalSendDeps {
  sendLive: (
    sessionId: string,
    text: string,
  ) => Promise<ExternalLiveChatResult | ExternalChatError | null>;
  sendReply: (
    sessionId: string,
    text: string,
  ) => Promise<ExternalReplyRun | { error: string } | null>;
  refresh: () => Promise<unknown>;
}

export type ExternalSendOutcome =
  | { ok: true; mode: 'live' }
  | { ok: true; mode: 'reply'; reply: ExternalReplyRun }
  | { ok: false; error: string };

/** One user attempt: exactly one transport call, with no automatic retry. */
export async function performExternalSend(
  row: ExternalSessionRow,
  text: string,
  deps: ExternalSendDeps = {
    sendLive: sendExternalChat,
    sendReply: sendExternalReply,
    refresh: async () => undefined,
  },
): Promise<ExternalSendOutcome> {
  if (!isQuietSession(row)) {
    if (row.liveChat?.state !== 'available') {
      return { ok: false, error: row.liveChat?.reason ?? 'transport_unavailable' };
    }
    const result = await deps.sendLive(row.sessionId, text);
    if (result === null) return { ok: false, error: 'bridge_unreachable' };
    if (!('state' in result)) return { ok: false, error: result.error };
    await deps.refresh();
    return { ok: true, mode: 'live' };
  }
  const result = await deps.sendReply(row.sessionId, text);
  if (result === null) return { ok: false, error: 'bridge_unreachable' };
  if (!('state' in result)) return { ok: false, error: result.error };
  return { ok: true, mode: 'reply', reply: result };
}

/** The composer, plus the one line that says why it is or is not usable. */
function _composerHtml(row: ExternalSessionRow): string {
  const running = _chat?.lastReply?.state === 'running';
  const composer = composerState(row, { sending: _sending, replyRunning: running });
  const disabled = !composer.enabled;
  let hint: string;
  let tone = '';
  if (_replyError) {
    hint = `⚠ ${_replyError}`;
    tone = ' agents-compose-hint--error';
  } else if (composer.mode === 'disabled') {
    hint = composer.hint;
    tone = ' agents-compose-hint--busy';
  } else if (_chat?.lastReply?.state === 'failed') {
    hint = `⚠ El último turno falló: ${_chat.lastReply.error}`;
    tone = ' agents-compose-hint--error';
  } else {
    hint = composer.hint;
  }
  return `<div class="agents-compose">
    <textarea class="agents-compose-text" rows="2" ${disabled ? 'disabled' : ''}
      placeholder="Escribile a esta sesión…"
      aria-label="Mensaje para esta sesión">${escapeHtml(_draft)}</textarea>
    <button type="button" class="agents-compose-send" ${disabled || !_draft.trim() ? 'disabled' : ''}
      title="Enviar (Ctrl+Enter)">${_sending ? '…' : 'Enviar'}</button>
    <p class="agents-compose-hint${tone}">${escapeHtml(hint)}</p>
  </div>`;
}

function _resumeHtml(): string {
  if (!_resume) return '';
  const note = escapeHtml(_resume.note);
  if (_resume.mode !== 'resume' || !_resume.command) {
    return `<div class="agents-resume agents-resume--${escapeHtml(_resume.mode)}">${note}</div>`;
  }
  const copied = _resumeCopied ? '<strong>✅ Copiado.</strong> ' : '';
  return `<div class="agents-resume">
    ${copied}${note}
    <code class="agents-resume-cmd">${escapeHtml(_resume.command)}</code>
  </div>`;
}

/**
 * Send the draft as one turn over this session.
 *
 * Worth being blunt in the UI about what this is: the session is closed, so
 * the bridge spawns a process that resumes it, runs one turn and exits. It is
 * not a live chat, and a session whose process is still alive is refused.
 */
async function _send(): Promise<void> {
  const sessionId = _chatSession;
  const text = _draft.trim();
  const row = _chat?.session;
  if (!sessionId || !row || !text || _sending) return;
  _sending = true;
  _replyError = '';
  _renderChat();
  const result = await performExternalSend(row, text, {
    sendLive: sendExternalChat,
    sendReply: sendExternalReply,
    refresh: () => (_chatSession === sessionId ? _loadChat(false) : Promise.resolve()),
  });
  if (_chatSession !== sessionId) return;
  _sending = false;
  if (!result.ok) {
    _replyError = row.active
      ? result.error === 'bridge_unreachable'
        ? 'No pude hablar con el bridge.'
        : result.error
      : result.error === 'bridge_unreachable'
        ? 'No pude hablar con el bridge.'
        : replyErrorText(result.error);
  } else {
    _draft = '';
    if (_chat && result.mode === 'reply') _chat = { ..._chat, lastReply: result.reply };
  }
  _renderChat();
}

function _backToList(): void {
  _chatSession = null;
  _chat = null;
  _resume = null;
  _resumeCopied = false;
  _draft = '';
  _replyError = '';
  _sending = false;
  _renderedKey = '';
  window.clearInterval(_chatTimer);
  _chatTimer = 0;
  _render();
  void _loadList();
}

function _stopTimers(): void {
  window.clearInterval(_chatTimer);
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
  const units = (_deps?.state.getAllUnits() ?? []).filter((u) => !u.ephemeral);
  if (units.length === 0) return '<div class="agents-empty">Sin unidades propias.</div>';
  return units
    .map(
      (u) => `<button type="button" class="agents-own" data-unit="${escapeHtml(u.id)}">
        <span class="agents-dot agents-dot--${escapeHtml(u.state)}" aria-hidden="true"></span>
        <span>${escapeHtml(u.name)}</span><span class="agents-own-state">${escapeHtml(u.state)}</span>
        <span class="agents-own-close" role="button" tabindex="0" aria-label="Cerrar sesión ${escapeHtml(u.id)}" title="Cerrar sesión (retira la unidad del mapa)">✕</span>
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
  body.innerHTML = `${external}
    <h4 class="agents-section">Unidades RepoCiv</h4>
    <div class="agents-own-list">${_ownUnitsHtml()}</div>
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
  body.querySelectorAll<HTMLElement>('.agents-own-close').forEach((el) =>
    el.addEventListener('click', (ev) => {
      ev.stopPropagation(); // the row's click selects/locates; ✕ must not
      void _closeOwnSession(el.closest<HTMLElement>('.agents-own')?.dataset['unit'] ?? '');
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
  // The poll rebuilds this view every 15 s: keep what the user is typing, and
  // their place in it.
  const box = body.querySelector<HTMLTextAreaElement>('.agents-compose-text');
  if (box) _draft = box.value;
  const hadFocus = box !== null && document.activeElement === box;
  const caret = box?.selectionStart ?? null;
  const row = _chat.session;
  const hermes = _isHermes(row);
  const badge = stateBadge(row.state);
  const status = row.active
    ? (badge?.text ?? row.state)
    : `inactivo · ${relativeTime(row.lastActivityAt)}`;
  let log: string;
  if (_chat.messages.length > 0) {
    const more = _chat.hasMore
      ? '<div class="agents-empty">… mensajes anteriores no mostrados</div>'
      : '';
    log = more + chatMessagesHtml(_chat.messages, row.agent);
  } else if (_chatLoading) {
    log = '<div class="agents-empty">Cargando chat…</div>';
  } else if (!_chat.available && hermes) {
    log = `<div class="agents-empty">No pude leer esta sesión en la base de Hermes (${escapeHtml(_chat.error ?? 'sin datos')}); probá ↻.</div>`;
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
        <strong>${escapeHtml(sessionLabel(row))}</strong> ${row.model ? escapeHtml(shortModel(row.model)) : ''}
        ${_chat.title ? `<div class="agents-chat-name">${escapeHtml(_chat.title)}</div>` : ''}
        <div class="agents-chat-sub">${_whereHtml(row)} · ${escapeHtml(status)} ${note}</div>
      </div>
      <button type="button" class="agents-resume-btn" title="Retomar esta sesión: copia el comando para tu terminal" aria-label="Retomar esta sesión">⏎</button>
      <button type="button" class="agents-locate" title="Ubicar en el mapa" aria-label="Ubicar en el mapa">📍</button>
      <button type="button" class="agents-refresh" title="${hermes ? 'Actualizar' : 'Actualizar (reimporta el transcript)'}" aria-label="Actualizar">${_chatLoading ? '…' : '↻'}</button>
    </div>
    <div class="agents-chat-log">${log}</div>
    ${_resumeHtml()}
    ${_composerHtml(row)}`;
  bindPanelAction(body, '.agents-back', _backToList);
  bindPanelAction(body, '.agents-resume-btn', () => void _loadResume());
  bindPanelAction(body, '.agents-locate', () => _locate(row));
  bindPanelAction(body, '.agents-refresh', () => void _loadChat(true));
  bindPanelAction(body, '.agents-compose-send', () => void _send());
  const textEl = body.querySelector<HTMLTextAreaElement>('.agents-compose-text');
  if (textEl) {
    textEl.addEventListener('input', () => {
      const wasEmpty = _draft.trim() === '';
      _draft = textEl.value;
      // The send button flips enabled/disabled on the first and last character;
      // toggle it in place instead of rebuilding the view under the cursor.
      if (wasEmpty !== (_draft.trim() === '')) {
        const send = body.querySelector<HTMLButtonElement>('.agents-compose-send');
        if (send) send.disabled = _draft.trim() === '';
      }
    });
    textEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        void _send();
      }
    });
    if (hadFocus) {
      textEl.focus();
      if (caret !== null) textEl.setSelectionRange(caret, caret);
    }
  }
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
