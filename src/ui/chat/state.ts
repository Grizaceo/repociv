// ─── Chat-history state shared across chat submodules ──────────────────────
// ESM no permite reasignar imports, asi que activeChatUnit y sidePanelCleanup
// se exponen via getter/setter. Los Map/Set son mutables in-place.

export interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
  timestamp: string;
}

export const chatHistory = new Map<string, ChatMessage[]>();
export const chatBuffers = new Map<string, string>();
export const currentAgentBubble = new Map<string, HTMLElement>();
export const currentAgentMessageIndex = new Map<string, number>();
export const agentsWithNewMessages = new Set<string>();

let _activeChatUnit: string | null = (() => {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('repociv:lastChatUnit') : null;
  return saved ?? null;
})();
export function getActiveChatUnit(): string | null {
  return _activeChatUnit;
}
export function setActiveChatUnit(v: string | null): void {
  _activeChatUnit = v;
  if (v && typeof localStorage !== 'undefined') {
    localStorage.setItem('repociv:lastChatUnit', v);
  }
}

/** Update the visual target indicator in the chat input row. */
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
export function getSidePanelCleanup(): (() => void) | null {
  return _sidePanelCleanup;
}
export function setSidePanelCleanup(v: (() => void) | null): void {
  _sidePanelCleanup = v;
}
