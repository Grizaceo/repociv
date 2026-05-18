// ─── Agent selector dropdown (multi-agent chat tabs) ───────────────────────
import {
  chatHistory,
  agentsWithNewMessages,
  getActiveChatUnit,
  setActiveChatUnit,
} from './state.ts';
import { renderChatHistory } from './history.ts';

/** Initialize the agent selector dropdown in the chat panel */
export function initAgentSelector(activeUnitId: string): void {
  const selector = document.getElementById('chat-agent-selector') as HTMLSelectElement | null;
  if (!selector) return;

  selector.innerHTML = '';
  const units = Array.from(chatHistory.keys()).sort();
  for (const unitId of units) {
    const opt = document.createElement('option');
    opt.value = unitId;
    opt.textContent = unitId.toUpperCase();
    if (agentsWithNewMessages.has(unitId)) {
      opt.classList.add('new-message');
    }
    selector.appendChild(opt);
  }

  selector.value = activeUnitId;

  if (!selector.dataset['wired']) {
    selector.addEventListener('change', () => {
      const selectedUnitId = selector.value;
      if (selectedUnitId && selectedUnitId !== getActiveChatUnit()) {
        setActiveChatUnit(selectedUnitId);
        agentsWithNewMessages.delete(selectedUnitId);
        selector.querySelector(`option[value="${selectedUnitId}"]`)?.classList.remove('new-message');
        renderChatHistory(selectedUnitId);
        // DON'T call clearChat here — it would wipe the DOM since activeChatUnit now matches
      }
    });
    selector.dataset['wired'] = '1';
  }
}
