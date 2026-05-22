// ─── Agent selector: initial chip render ────────────────────────────────────
// Chip element + click logic live in agentChip.ts so history.ts can reuse
// them without a circular dependency.
import { chatHistory } from './state.ts';
import { createChip } from './agentChip.ts';

/** Initialize (or re-render) the agent selector chips. */
export function initAgentSelector(activeUnitId: string): void {
  const container = document.getElementById('chat-agent-selector');
  if (!container) return;

  container.innerHTML = '';
  const knownUnits = new Set(chatHistory.keys());
  knownUnits.add(activeUnitId);
  const units = Array.from(knownUnits).sort();

  for (const unitId of units) {
    container.appendChild(createChip(unitId, unitId === activeUnitId));
  }
}
