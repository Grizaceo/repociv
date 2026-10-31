import {
  chatMessagesHtml,
  fetchExternalChat,
  fetchExternalResume,
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
} from '../externalAgents.ts';
import { fetchAgents, terminalPanel } from '../terminalPanel.ts';
import { agentWindowDestination, openAgentWindow } from './agentWindow.ts';
import { clipboardWrite } from './chat/clipboard.ts';
import { escapeHtml } from './escapeHtml.ts';
import { herdrHint, type HerdrRuntime } from './herdrHint.ts';
import { bindPanelAction } from './panelShell.ts';

const CHAT_POLL_MS = 15_000;

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
  devin_live_chat_unavailable: 'Devin CLI no expone un canal vivo externo para esta sesión.',
  mcode_live_chat_unavailable: 'MiniMax Code no expone un canal vivo externo para esta sesión.',
  unsupported_session_source: 'El chat vivo no está disponible para esta sesión.',
};

function isQuietSession(row: ExternalSessionRow): boolean {
  return !row.active || row.state === 'idle' || row.state === 'inactive';
}

function herdrFamily(row: ExternalSessionRow): 'claude' | 'devin' | null {
  if (row.herdrPane || isQuietSession(row)) return null;
  if (row.liveChat?.reason === 'claude_control_channel_unavailable') return 'claude';
  if (row.liveChat?.reason === 'devin_live_chat_unavailable') return 'devin';
  return null;
}

/** Public behavior contract for enabling the external-session composer. */
export function composerState(
  row: ExternalSessionRow,
  flags: { sending?: boolean; replyRunning?: boolean; runtime?: HerdrRuntime | null } = {},
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
  const family = herdrFamily(row);
  if (!family && row.liveChat?.state === 'available') {
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
      (family ? herdrHint(family, flags.runtime ?? null) : LIVE_CHAT_REASON_TEXT[reason]) ??
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

interface AgentsChatDeps {
  getPanel: () => HTMLElement | null;
  locate: (row: ExternalSessionRow) => void;
  whereHtml: (row: ExternalSessionRow) => string;
  render: () => void;
  loadList: () => Promise<void>;
  invalidateList: () => void;
}

export function createAgentsChat(deps: AgentsChatDeps) {
  let _chatSession: string | null = null;
  let _chat: ExternalChat | null = null;
  let _chatLoading = false;
  let _herdrRuntime: HerdrRuntime | null = null;
  let _herdrRequest = 0;
  let _resume: ExternalResume | null = null;
  let _resumeCopied = false;
  let _draft = '';
  let _replyError = '';
  let _sending = false;
  let _chatTimer = 0;
  const _refreshed = new Set<string>();
  const locateExternalAgent = deps.locate;
  const _whereHtml = deps.whereHtml;
  const _render = deps.render;
  const _loadList = deps.loadList;

  function _isHermes(row: ExternalSessionRow): boolean {
    return row.source === 'hermes';
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

  async function _loadHerdrRuntime(row: ExternalSessionRow): Promise<void> {
    if (!herdrFamily(row)) return;
    const request = ++_herdrRequest;
    _herdrRuntime = null;
    _renderChat();
    const data = await fetchAgents();
    if (_chatSession !== row.sessionId || request !== _herdrRequest) return;
    _herdrRuntime = data?.runtime ?? null;
    _renderChat();
  }

  function _openChat(row: ExternalSessionRow): void {
    _herdrRequest++;
    _herdrRuntime = null;
    if (row.herdrPane) {
      _chatSession = null;
      _chat = null;
      _stopTimers();
      _render();
      locateExternalAgent(row);
      openAgentWindow(agentWindowDestination(row));
      return;
    }
    _chatSession = row.sessionId;
    _chat = { session: row, messages: [], hasMore: false, available: false };
    _resume = null;
    _resumeCopied = false;
    _draft = '';
    _replyError = '';
    _sending = false;
    locateExternalAgent(row);
    // Suvadu re-imports a transcript only on prompt/stop: pull it now for a live
    // session (once per session per panel lifetime; ↻ does it on demand).
    // Hermes reads its live database: nothing to import.
    const refresh =
      !_isHermes(row) && (row.active || !row.imported) && !_refreshed.has(row.sessionId);
    if (refresh) _refreshed.add(row.sessionId);
    void _loadHerdrRuntime(row);
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

  /** The composer, plus the one line that says why it is or is not usable. A
   *  session in a herdr pane has its real CLI instead: one way in, no second writer. */
  function _composerHtml(row: ExternalSessionRow): string {
    if (row.herdrPane) {
      return `<div class="agents-compose">
      <button type="button" class="agents-open-cli">⌨ Abrir su CLI</button>
      <p class="agents-compose-hint">Escribes en su terminal real, en herdr. Cerrar RepoCiv no lo detiene.</p>
    </div>`;
    }
    const running = _chat?.lastReply?.state === 'running';
    const composer = composerState(row, { sending: _sending, replyRunning: running, runtime: _herdrRuntime });
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
    const hintHtml = composer.mode === 'disabled' && !_replyError && herdrFamily(row)
      ? escapeHtml(hint).replace(/`([^`]+)`/g, '<code>$1</code>')
      : escapeHtml(hint);
    return `<div class="agents-compose">
    <textarea class="agents-compose-text" rows="2" ${disabled ? 'disabled' : ''}
      placeholder="Escribile a esta sesión…"
      aria-label="Mensaje para esta sesión">${escapeHtml(_draft)}</textarea>
    <button type="button" class="agents-compose-send" ${disabled || !_draft.trim() ? 'disabled' : ''}
      title="Enviar (Ctrl+Enter)">${_sending ? '…' : 'Enviar'}</button>
    <p class="agents-compose-hint${tone}">${hintHtml}</p>
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
    deps.invalidateList();
    window.clearInterval(_chatTimer);
    _chatTimer = 0;
    _render();
    void _loadList();
  }

  function _stopTimers(): void {
    window.clearInterval(_chatTimer);
    _chatTimer = 0;
  }

  function _renderChat(firstLoad = false): void {
    const _panel = deps.getPanel();
    if (!_panel || !_chat) return;
    const body = _panel.querySelector<HTMLElement>('.agents-body')!;
    body.classList.add('agents-body--chat');
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
        <button type="button" class="agents-chat-agent" title="Ir a la ciudad del agente">${escapeHtml(sessionLabel(row))}</button> ${row.model ? escapeHtml(shortModel(row.model)) : ''}
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
    bindPanelAction(body, '.agents-locate', () => locateExternalAgent(row));
    bindPanelAction(body, '.agents-chat-agent', () => locateExternalAgent(row));
    bindPanelAction(body, '.agents-refresh', () => {
      void _loadHerdrRuntime(row);
      void _loadChat(true);
    });
    bindPanelAction(body, '.agents-compose-send', () => void _send());
    bindPanelAction(body, '.agents-open-cli', () => {
      if (row.herdrPane) void terminalPanel.open(row.herdrPane);
    });
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

  return {
    get sessionId(): string | null {
      return _chatSession;
    },
    open: _openChat,
    render: _renderChat,
    stopTimers: _stopTimers,
    clear(): void {
      _chatSession = null;
      _chat = null;
    },
  };
}
