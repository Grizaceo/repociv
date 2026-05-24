// ─── Chat-history state shared across chat submodules ────────────────────────
// ESM no permite reasignar imports, asi que activeChatUnit y sidePanelCleanup
// se exponen via getter/setter. Los Map/Set son mutables in-place.

export interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
  timestamp: string;
}

// ═══ Persistencia en localStorage ═══
const STORAGE_KEY_HISTORY = 'repociv:chatHistory';
const STORAGE_KEY_BUFFERS = 'repociv:chatBuffers';

function loadHistory(): Map<string, ChatMessage[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed));
  } catch { return new Map(); }
}
function saveHistory(map: Map<string, ChatMessage[]>) {
  try {
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(Object.fromEntries(map)));
  } catch { /* storage full or private mode */ }
}
function loadBuffers(): Map<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BUFFERS);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed));
  } catch { return new Map(); }
}
function saveBuffers(map: Map<string, string>) {
  try {
    localStorage.setItem(STORAGE_KEY_BUFFERS, JSON.stringify(Object.fromEntries(map)));
  } catch { /* storage full or private mode */ }
}

export const chatHistory = loadHistory();
export const chatBuffers = loadBuffers();
export const currentAgentBubble = new Map<string, HTMLElement>();
export const currentAgentMessageIndex = new Map<string, number>();
export const agentsWithNewMessages = new Set<string>();

// Proxy para persistir automáticamente
const _originalSetH = chatHistory.set.bind(chatHistory);
chatHistory.set = function set(k: string, v: ChatMessage[]) {
  _originalSetH(k, v);
  saveHistory(chatHistory);
  return this;
};
const _originalDelH = chatHistory.delete.bind(chatHistory);
chatHistory.delete = function del(k: string) {
  const res = _originalDelH(k);
  saveHistory(chatHistory);
  return res;
};
const _originalSetB = chatBuffers.set.bind(chatBuffers);
chatBuffers.set = function set(k: string, v: string) {
  _originalSetB(k, v);
  saveBuffers(chatBuffers);
  return this;
};
const _originalDelB = chatBuffers.delete.bind(chatBuffers);
chatBuffers.delete = function del(k: string) {
  const res = _originalDelB(k);
  saveBuffers(chatBuffers);
  return res;
};

let _activeChatUnit: string | null = (() => {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('repociv:lastChatUnit') : null;
  return saved ?? null;
})();
export function getActiveChatUnit(): string | null { return _activeChatUnit; }
export function setActiveChatUnit(v: string | null): void {
  _activeChatUnit = v;
  if (v && typeof localStorage !== 'undefined') localStorage.setItem('repociv:lastChatUnit', v);
}

export function updateChatTargetIndicator(): void {
  const el = document.getElementById('chat-target-indicator');
  if (!el) return;
  const chipActive = document.querySelector<HTMLElement>('.chat-agent-chip.active');
  const unitId = chipActive?.dataset['unit'] ?? _activeChatUnit ?? '—';
  const icon = chipActive?.querySelector('.chip-icon')?.textContent ?? '⬡';
  el.textContent = `${icon} ${unitId.toUpperCase()}`;
  el.title = `Enviando a: ${unitId.toUpperCase()}`;
}

let _sidePanelCleanup: (() => void) | null = null;
export function getSidePanelCleanup(): (() => void) | null { return _sidePanelCleanup; }
export function setSidePanelCleanup(v: (() => void) | null): void { _sidePanelCleanup = v; }
