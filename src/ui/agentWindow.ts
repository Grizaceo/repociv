import { BRIDGE_URL } from '../bridgeEnv.ts';
import { fetchExternalChat, sessionLabel } from '../externalAgents.ts';
import type { ExternalChatMessage, ExternalSessionRow } from '../externalAgents.ts';
import { TerminalLink } from '../terminalLink.ts';
import type { SubmitResult } from '../terminalLink.ts';
import { reasonText, terminalPanel } from '../terminalPanel.ts';
import { countUserText, normalizeMessage, statusLabel } from './agentWindowState.ts';
import { attachCopyListeners } from './chat/clipboard.ts';
import { renderMarkdown } from './chat/markdown.ts';
import { getSidePanelCleanup, setSidePanelCleanup } from './chat/state.ts';
import { trapFocus } from './focusTrap.ts';

interface Pending {
  id: string;
  text: string;
  target: number;
  state: 'sending' | 'confirmed' | 'unconfirmed';
  reason: string | null;
}

const HIDDEN_IDS = [
  'chat-agent-selector-row', 'chat-messages', 'operation-ticker', 'chat-input-row',
  'model-selector-wrapper', 'chat-scroll-bottom',
];
const BLOCKED_NOTICE =
  'El agente espera tu respuesta en su terminal (un permiso o un diálogo). ' +
  'Esas respuestas no quedan en la crónica: contéstale en su CLI.';
const UNCONFIRMED: Record<string, string> = {
  agent_busy: 'El agente estaba trabajando; se confirmará cuando aparezca en la crónica.',
  no_state_change: 'herdr no vio reacción del agente. Revisa su CLI antes de reenviar.',
  enter_failed: 'El texto quedó en su cuadro de entrada sin enviar. Ábrelo en el CLI.',
  confirm_unavailable: 'No se pudo confirmar la reacción. Revisa su CLI antes de reenviar.',
};

let deps: { locate(row: ExternalSessionRow): void } | null = null;
let row: ExternalSessionRow | null = null;
let link: TerminalLink | null = null;
let timer = 0;
let generation = 0;
let status = '';
let notice = '';
let messages: ExternalChatMessage[] = [];
let pending: Pending[] = [];
let hidden: Array<{ element: HTMLElement; display: string }> = [];
let originalNameClick: GlobalEventHandlers['onclick'] = null;
let nextId = 0;

export function initAgentWindow(value: { locate(row: ExternalSessionRow): void }): void {
  deps = value;
}

export function isAgentWindowOpen(): boolean {
  return row !== null;
}

function element<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(`#agent-window ${selector}`);
}

function cli(): void {
  if (row?.herdrPane) void terminalPanel.open(row.herdrPane);
}

function setStatus(value: string): void {
  status = ['idle', 'working', 'blocked', 'done'].includes(value) ? value : 'unknown';
  const badge = element<HTMLElement>('.agent-window-status');
  if (badge) {
    badge.textContent = `${status} · ${statusLabel(status)}`;
    badge.className = `agent-window-status terminal-status--${status}`;
  }
  const hero = document.getElementById('side-hero-state');
  if (hero) {
    hero.textContent = status;
    hero.className = `state-${status}`;
  }
  renderNotice();
}

function renderNotice(): void {
  const box = element<HTMLElement>('.agent-window-notice');
  const send = element<HTMLButtonElement>('.agent-window-send');
  if (!box || !send) return;
  send.disabled = status === 'blocked' || Boolean(BRIDGE_URL);
  box.replaceChildren();
  const text = status === 'blocked' ? BLOCKED_NOTICE : notice;
  box.classList.toggle('hidden', !text);
  if (!text) return;
  box.append(document.createTextNode(text));
  if (status === 'blocked') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '⌨ Abrir CLI';
    button.addEventListener('click', cli);
    box.append(' ', button);
  }
}

function bubble(text: string, role: 'user' | 'assistant', label: string, detail = ''): HTMLElement {
  const item = document.createElement('div');
  item.className = role === 'user' ? 'chat-msg user' : 'chat-msg agent assistant';
  item.dataset['raw'] = text;
  item.innerHTML = `<div class="chat-msg-head"><div class="chat-msg-meta">
    <span></span>
    <button class="chat-copy-btn" title="Copiar mensaje" aria-label="Copiar mensaje al portapapeles">copiar</button>
    </div></div><div class="chat-body"></div>`;
  const name = item.querySelector('span');
  const body = item.querySelector<HTMLElement>('.chat-body');
  if (name) name.textContent = label;
  if (body && role === 'user') body.textContent = text;
  else if (body) body.innerHTML = renderMarkdown(text);
  if (detail) {
    const state = document.createElement('div');
    state.className = 'agent-window-delivery';
    state.textContent = detail;
    item.append(state);
  }
  return item;
}

function renderMessages(): void {
  const log = element<HTMLElement>('.agent-window-log');
  if (!log || !row) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 50;
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const time = message.at === null ? '' : new Date(message.at).toLocaleTimeString('es-CL', {
      hour: '2-digit', minute: '2-digit',
    });
    const who = message.role === 'user' ? 'TÚ' : sessionLabel(row);
    fragment.append(bubble(message.text, message.role, [who, time].filter(Boolean).join(' · ')));
  }
  for (const item of pending) {
    const detail = item.state === 'sending' ? 'Enviando…'
      : item.state === 'confirmed' ? '✓ Entregado'
        : `Sin confirmar${item.reason ? ` · ${UNCONFIRMED[item.reason] ?? 'Revisa su CLI antes de reenviar.'}` : ''}`;
    fragment.append(bubble(item.text, 'user', 'TÚ', detail));
  }
  log.replaceChildren(fragment);
  attachCopyListeners(log, row.sessionId);
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function schedulePoll(): void {
  window.clearTimeout(timer);
  if (!row) return;
  timer = window.setTimeout(() => void poll(false), pending.length ? 5_000 : 15_000);
}

async function poll(refresh: boolean): Promise<void> {
  const current = row;
  const version = generation;
  if (!current) return;
  const chat = await fetchExternalChat(current.sessionId, { refresh });
  if (version !== generation || !row) return;
  if (chat) {
    messages = chat.messages;
    pending = pending.filter((item) => countUserText(messages, item.text) < item.target);
    renderMessages();
  }
  schedulePoll();
}

function restoreDraft(text: string): void {
  const input = element<HTMLTextAreaElement>('.agent-window-input');
  if (!input) return;
  input.value = input.value ? `${text}\n${input.value}` : text;
}

function resultReceived(result: SubmitResult): void {
  const index = pending.findIndex((item) => item.id === result.id);
  const item = pending[index];
  if (!item) return;
  if (result.state === 'refused' || result.state === 'failed') {
    pending.splice(index, 1);
    for (const other of pending) {
      if (normalizeMessage(other.text) === normalizeMessage(item.text) && other.target > item.target) {
        other.target -= 1;
      }
    }
    restoreDraft(item.text);
    notice = result.reason === 'agent_blocked'
      ? BLOCKED_NOTICE
      : `No se entregó: ${reasonText(
        result.reason && /^[a-z0-9_]+$/i.test(result.reason) ? result.reason : 'error desconocido',
      )}`;
    if (result.reason === 'agent_blocked') setStatus('blocked');
    else renderNotice();
  } else {
    item.state = result.state;
    item.reason = result.reason;
  }
  renderMessages();
  schedulePoll();
}

function send(): void {
  const input = element<HTMLTextAreaElement>('.agent-window-input');
  if (!row || !input || status === 'blocked' || BRIDGE_URL) return;
  const text = input.value;
  if (!text.trim()) return;
  const normalized = normalizeMessage(text);
  const count = countUserText(messages, text);
  const target = Math.max(count, ...pending.filter((item) => normalizeMessage(item.text) === normalized)
    .map((item) => item.target)) + 1;
  const item: Pending = { id: `submit-${Date.now()}-${++nextId}`, text, target, state: 'sending', reason: null };
  pending.push(item);
  renderMessages();
  if (!link?.submit(item.id, text)) {
    pending = pending.filter((candidate) => candidate !== item);
    notice = 'Sin conexión con el agente: no se envió.';
    renderMessages();
    renderNotice();
    return;
  }
  input.value = '';
  notice = '';
  renderNotice();
  schedulePoll();
}

function mount(): HTMLElement | null {
  const pane = document.querySelector<HTMLElement>('#side-panel .tab-pane[data-pane="chat"]');
  if (!pane) return null;
  let windowEl = document.getElementById('agent-window');
  if (windowEl) return windowEl;
  windowEl = document.createElement('div');
  windowEl.id = 'agent-window';
  windowEl.innerHTML = `
    <div class="agent-window-header">
      <span class="agent-window-status"></span><span class="agent-window-place"></span>
      <button type="button" class="agent-window-locate" aria-label="Ir al agente en el mapa">📍</button>
      <button type="button" class="agent-window-cli">⌨ Abrir CLI</button>
    </div>
    <div class="agent-window-log"></div>
    <div class="agent-window-notice hidden" role="status"></div>
    <div class="agent-window-input-row">
      <textarea class="agent-window-input" rows="1" maxlength="100000" placeholder="Hablar con el agente..." aria-label="Mensaje al agente"></textarea>
      <button type="button" class="agent-window-send">Enviar</button>
    </div>`;
  pane.append(windowEl);
  windowEl.querySelector('.agent-window-locate')?.addEventListener('click', () => {
    if (row) deps?.locate(row);
  });
  windowEl.querySelector('.agent-window-cli')?.addEventListener('click', cli);
  windowEl.querySelector('.agent-window-send')?.addEventListener('click', send);
  windowEl.querySelector('textarea')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });
  return windowEl;
}

export function openAgentWindow(value: ExternalSessionRow): void {
  if (!value.herdrPane) return;
  closeAgentWindow();
  const panel = document.getElementById('side-panel');
  const windowEl = mount();
  if (!panel || !windowEl) return;
  row = value;
  generation += 1;
  const version = generation;
  messages = [];
  pending = [];
  notice = BRIDGE_URL ? 'La terminal solo funciona a través del proxy de la interfaz.' : '';
  hidden = HIDDEN_IDS.flatMap((id) => {
    const target = document.getElementById(id);
    if (!target) return [];
    const old = { element: target, display: target.style.display };
    target.style.display = 'none';
    return [old];
  });
  windowEl.classList.remove('hidden');
  panel.classList.remove('hidden');
  panel.querySelectorAll('.side-tab').forEach((tab) =>
    tab.classList.toggle('active', (tab as HTMLElement).dataset['tab'] === 'chat'),
  );
  panel.querySelectorAll('.tab-pane').forEach((pane) =>
    pane.classList.toggle('active', (pane as HTMLElement).dataset['pane'] === 'chat'),
  );
  const name = document.getElementById('side-hero-name');
  if (name) {
    name.textContent = sessionLabel(value);
    originalNameClick = name.onclick;
    name.onclick = () => { if (row) deps?.locate(row); };
  }
  const place = element<HTMLElement>('.agent-window-place');
  if (place) place.textContent = value.repo.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'capital';
  const input = element<HTMLTextAreaElement>('.agent-window-input');
  if (input) input.value = '';
  setStatus(value.herdrPane.status);
  renderMessages();
  getSidePanelCleanup()?.();
  setSidePanelCleanup(trapFocus(panel));
  if (!BRIDGE_URL) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    link = new TerminalLink(`${scheme}://${location.host}/repociv-ws/terminal`, value.herdrPane.terminalId, {
      onAttached: (attachment) => {
        if (version !== generation) return;
        if (notice === 'Sin conexión con el agente.') notice = '';
        setStatus(attachment.agent.status);
      },
      onStatus: (next) => { if (version === generation) setStatus(next); },
      onSize: () => {},
      onScreen: () => {},
      onError: (reason) => { if (version === generation) { notice = reasonText(reason); renderNotice(); } },
      onClosed: (reason) => { if (version === generation) { notice = reasonText(reason); renderNotice(); } },
      onRefused: (reason) => { if (version === generation) { notice = reasonText(reason); renderNotice(); } },
      onDropped: () => {
        if (version !== generation) return;
        for (const item of pending) {
          if (item.state === 'sending') { item.state = 'unconfirmed'; item.reason = 'confirm_unavailable'; }
        }
        notice = 'Sin conexión con el agente.';
        renderNotice();
        renderMessages();
        schedulePoll();
      },
      onSubmitResult: (result) => { if (version === generation) resultReceived(result); },
    }, undefined, { screen: false });
    link.start();
  }
  void poll(value.source !== 'hermes' && (value.active || !value.imported));
}

export function closeAgentWindow(): void {
  if (!row) return;
  generation += 1;
  row = null;
  window.clearTimeout(timer);
  timer = 0;
  link?.stop();
  link = null;
  pending = [];
  messages = [];
  for (const item of hidden) item.element.style.display = item.display;
  hidden = [];
  document.getElementById('agent-window')?.classList.add('hidden');
  const name = document.getElementById('side-hero-name');
  if (name) name.onclick = originalNameClick;
}
