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
  workingUnits,
  subscribeWorkingUnits,
  chatHistory,
  chatBuffers,
  currentAgentBubble,
  currentAgentMessageIndex,
} from './state.ts';
import { loadConfigForUnit, getUnitConfig, setConfigPersistedHandler } from './modelSelector.ts';
import { escapeHtml } from '../escapeHtml.ts';

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
/** Compact label for a chip's model line: the model id, else the provider,
 *  else 'auto' (cascade). */
function chipModelLabel(cfg: { harness: string; provider: string; model: string }): string {
  if (cfg.model) return cfg.model;
  if (cfg.provider && cfg.provider !== 'auto') return cfg.provider;
  return 'auto';
}

/** Full harness · provider/model summary for the chip's tooltip. */
function chipModelTitle(cfg: { harness: string; provider: string; model: string }): string {
  return `${cfg.harness || 'auto'} · ${cfg.provider || 'auto'}/${cfg.model || 'default'}`;
}

/** Update the model line on an existing chip to match the unit's persisted
 *  config. Registered as the modelSelector persist handler so any selection
 *  change (dropdown, slash command, or picker) reflects on the active tab. */
export function updateChipModel(unitId: string): void {
  const container = document.getElementById('chat-agent-selector');
  if (!container) return;
  const chip = container.querySelector<HTMLElement>(`.chat-agent-chip[data-unit="${unitId}"]`);
  const modelEl = chip?.querySelector<HTMLElement>('.chip-model');
  if (!modelEl) return;
  const cfg = getUnitConfig(unitId);
  modelEl.textContent = chipModelLabel(cfg);
  modelEl.title = chipModelTitle(cfg);
}

// Mirror every persisted selection onto its tab's model line.
setConfigPersistedHandler((unitId) => {
  if (unitId) updateChipModel(unitId);
});

/** Create a chip button with click handler attached. */
export function createChip(unitId: string, isActive: boolean): HTMLElement {
  const btn = document.createElement('button');
  btn.className = `chat-agent-chip${isActive ? ' active' : ''}`;
  btn.dataset['unit'] = unitId;
  const cfg = getUnitConfig(unitId);
  btn.innerHTML =
    `<span class="chip-icon">${AGENT_ICONS[unitId.toUpperCase()] ?? '◆'}</span>` +
    `<span class="chip-text">` +
    `<span class="chip-name">${unitId.toUpperCase()}</span>` +
    `<span class="chip-model" title="${escapeHtml(chipModelTitle(cfg))}">${escapeHtml(chipModelLabel(cfg))}</span>` +
    `</span>` +
    `<span class="chip-working${workingUnits.has(unitId) ? ' active' : ''}" title="Trabajando en otra pestaña"></span>` +
    `<span class="chip-badge${agentsWithNewMessages.has(unitId) ? ' active' : ''}"></span>` +
    // The close button is hidden for the currently active chip (you
    // can't close the tab you're viewing). It's also hidden until
    // hover, so the strip stays clean by default.
    (isActive ? '' : `<span class="chip-close" title="Cerrar pestaña">×</span>`);
  btn.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('chip-close')) {
      e.stopPropagation();
      void closeChip(unitId);
      return;
    }
    void handleChipClick(unitId);
  });
  return btn;
}

/** Close a chip: remove it from the DOM, clear its chat history
 *  (both the in-memory Map and the localStorage copy), and persist.
 *  The unit is NOT removed from the game world — if it re-enters the
 *  chat later (e.g. a new mission dispatches to it), the chip is
 *  re-created via ensureChipExists. */
async function closeChip(unitId: string): Promise<void> {
  const container = document.getElementById('chat-agent-selector');
  if (!container) return;
  const chip = container.querySelector<HTMLElement>(`.chat-agent-chip[data-unit="${unitId}"]`);
  if (!chip) return;

  // If the closed chip was the active chat, switch to the H default
  // (or any remaining chip) so the user has somewhere to type.
  if (getActiveChatUnit() === unitId) {
    const remaining = container.querySelectorAll<HTMLElement>('.chat-agent-chip');
    const fallback = Array.from(remaining).find((c) => c.dataset['unit'] !== unitId);
    if (fallback) {
      await handleChipClick(fallback.dataset['unit']!);
    } else {
      // No other chips; create a fresh H chip.
      const fresh = createChip('H', true);
      container.appendChild(fresh);
      setActiveChatUnit('H');
      const { renderChatHistory } = await import('./history.ts');
      renderChatHistory('H');
    }
  }

  chip.remove();

  // Clear chat history (in-memory + localStorage).
  chatHistory.delete(unitId);
  chatBuffers.delete(unitId);
  currentAgentBubble.delete(unitId);
  currentAgentMessageIndex.delete(unitId);
  agentsWithNewMessages.delete(unitId);

  // Drop the chip for the now-empty unit. ensureChipExists will rebuild
  // it if a new event comes in for that unit.
  workingUnits.delete(unitId);
}

/** Re-render the working-spinner state on every visible chip.
 *  Called on every workingUnits change so the spinner appears/disappears
 *  even when the user is looking at a different tab. */
export function syncChipsWorking(): void {
  const container = document.getElementById('chat-agent-selector');
  if (!container) return;
  for (const chip of container.querySelectorAll<HTMLElement>('.chat-agent-chip')) {
    const unitId = chip.dataset['unit'];
    if (!unitId) continue;
    const spinner = chip.querySelector<HTMLElement>('.chip-working');
    if (!spinner) continue;
    spinner.classList.toggle('active', workingUnits.has(unitId));
  }
}

// Wire the spinner sync once on module load.
subscribeWorkingUnits(syncChipsWorking);

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
  // The side-hero-state element should reflect the actual state of the
  // unit whose chat is now active. Previously this was hardcoded to
  // 'IDLE' which left the label stale when switching from a working
  // agent to an idle one (e.g. user has H working, switches to SCOUT
  // tab, the panel still says "WORKING" because nothing updated it).
  // Read the live state from workingUnits and re-render accordingly.
  updateSideHeroState(unitId);
}

/** Re-render the side-hero-state element for the given unit.
 *  Called on chip click AND on every workingUnits change so the
 *  label stays in sync with the actual unit state, regardless of
 *  which tab is visible. */
function updateSideHeroState(unitId: string): void {
  const stateEl = document.getElementById('side-hero-state');
  if (!stateEl) return;
  if (workingUnits.has(unitId)) {
    stateEl.textContent = 'WORKING';
    stateEl.className = 'state-working';
  } else {
    stateEl.textContent = 'IDLE';
    stateEl.className = 'state-idle';
  }
}

// When the active unit's working state changes (e.g. SCOUT starts
// working while you're viewing H's chat), the side-hero-state label
// must update. The active unit is `getActiveChatUnit()`.
subscribeWorkingUnits(() => {
  const active = getActiveChatUnit();
  if (active) updateSideHeroState(active);
});
