// ─── Agent chip: shared element + click wiring ──────────────────────────────
// Lives in its own module so both agentSelector.ts (initial render) and
// history.ts (dynamic creation on first inbound message) use the same code.
// Dynamic import of renderChatHistory inside handleChipClick breaks the
// init-time cycle with history.ts.
import {
  agentsWithNewMessages,
  getActiveChatUnit,
  setActiveChatUnit,
  updateChatTargetIndicator,
} from './state.ts';
import { loadConfigForUnit } from './modelSelector.ts';

const AGENT_ICONS: Record<string, string> = {
  DAVI: '🛡',
  LEXO: '⚖',
  SCOUT: '🔍',
  WORKER: '⚒',
  OPENCLAW: '🦀',
  CLAUDE: '🧠',
  CODEX: '⌨',
  CURSOR: '🖱',
};
/** Create a chip button with click handler attached. */
export function createChip(unitId: string, isActive: boolean): HTMLElement {
  const btn = document.createElement('button');
  btn.className = `chat-agent-chip${isActive ? ' active' : ''}`;
  btn.dataset['unit'] = unitId;
  btn.innerHTML =
    `<span class="chip-icon">${AGENT_ICONS[unitId.toUpperCase()] ?? '◆'}</span>` +
    `<span class="chip-name">${unitId.toUpperCase()}</span>` +
    `<span class="chip-badge${agentsWithNewMessages.has(unitId) ? ' active' : ''}"></span>`;
  btn.addEventListener('click', () => {
    void handleChipClick(unitId);
  });
  return btn;
}

/** Ensure a chip exists for the given unit (idempotent). */
export function ensureChipExists(unitId: string): void {
  const container = document.getElementById('chat-agent-selector');
  if (!container) return;
  if (container.querySelector(`.chat-agent-chip[data-unit="${unitId}"]`)) return;
  const isActive = getActiveChatUnit() === unitId;
  container.appendChild(createChip(unitId, isActive));
}

/** Switch active agent + refresh UI. */
export async function handleChipClick(unitId: string): Promise<void> {
  if (unitId === getActiveChatUnit()) return;

  setActiveChatUnit(unitId);
  agentsWithNewMessages.delete(unitId);

  const container = document.getElementById('chat-agent-selector');
  if (container) {
    for (const chip of container.querySelectorAll<HTMLElement>('.chat-agent-chip')) {
      const isActive = chip.dataset['unit'] === unitId;
      chip.classList.toggle('active', isActive);
      if (isActive) {
        const badge = chip.querySelector<HTMLElement>('.chip-badge');
        if (badge) badge.classList.remove('active');
      }
    }
  }

  // Dynamic import breaks the init-time cycle with history.ts
  const { renderChatHistory } = await import('./history.ts');
  renderChatHistory(unitId);

  // Restore saved harness/provider/model config for this agent.
  loadConfigForUnit(unitId);

  updateChatTargetIndicator();

  const nameEl = document.getElementById('side-hero-name');
  if (nameEl) nameEl.textContent = unitId.toUpperCase();
  const stateEl = document.getElementById('side-hero-state');
  if (stateEl) {
    stateEl.textContent = 'IDLE';
    stateEl.className = 'state-idle';
  }
}
