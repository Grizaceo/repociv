// ─── HUD button + input wiring (non-hotkey) ─────────────────────────────────
import { tileKey } from '../../types.ts';
import { type Renderer } from '../../renderer.ts';
import { type GameState } from '../../game.ts';
import { type BridgeEvents } from '../../bridge.ts';
import {
  openSidePanel,
  closeSidePanel,
  isSidePanelOpen,
  appendUserMessage,
  wireSideTabs,
  loadGitInfo,
  loadFilesInfo,
  closeQuestBoard,
  wireQuestBoardTabs,
  toggleKeyboardHelp,
  wireCityPanel,
  getSelectedConfig,
} from '../index.ts';
import { toggleSettingsPanel } from '../settingsPanel.ts';
import { toggleConstructionPanel } from '../constructionPanel.ts';
import { spawnAgent } from './spawn.ts';
import { takeScreenshot } from './screenshot.ts';

export function wireInputs(renderer: Renderer, state: GameState, bridge: BridgeEvents): void {
  const missionInput = document.getElementById('mission-input') as HTMLInputElement;

  // ─── Spawn buttons (Q/W/E/L) ────────────────────────────────────────────
  document.querySelectorAll<HTMLButtonElement>('.spawn-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset['type'] as string;
      spawnAgent(type, state, renderer, bridge);
    });
  });

  // ─── Top-bar buttons ────────────────────────────────────────────────────
  document
    .getElementById('btn-screenshot')
    ?.addEventListener('click', () => takeScreenshot(renderer));
  document
    .getElementById('btn-construction')
    ?.addEventListener('click', () => toggleConstructionPanel());
  document.getElementById('btn-settings')?.addEventListener('click', () => toggleSettingsPanel());

  // ─── Minimap ────────────────────────────────────────────────────────────
  const minimap = document.getElementById('minimap-canvas') as HTMLCanvasElement;
  minimap?.addEventListener('click', (e) => {
    const rect = minimap.getBoundingClientRect();
    renderer.minimapClick(e.clientX - rect.left, e.clientY - rect.top);
  });

  // ─── Mission / Chat input (shared logic) ────────────────────────────────
  const chatInput = document.getElementById('chat-input') as HTMLInputElement | null;

  const sendMessage = (input: HTMLInputElement | null) => {
    const unit = state.selectedUnit;
    if (!unit || !input || !input.value.trim()) return;
    const lookupCoord = unit.targetCoord ?? unit.coord;
    const tile = state.world.tiles.get(tileKey(lookupCoord));
    const cityHere =
      tile?.city ??
      state.world.cities.find((c) =>
        c.territory.some((t) => t.q === lookupCoord.q && t.r === lookupCoord.r),
      ) ??
      state.world.cities[0];

    const text = input.value.trim();
    if (!isSidePanelOpen()) openSidePanel(unit);
    appendUserMessage(unit.id, text);

    // Include 3-layer config from chat UI: harness + provider + model
    const { harness, provider, model } = getSelectedConfig();
    const payload: Record<string, unknown> = {
      unit: unit.id,
      city: cityHere?.id ?? 'main',
      mission: text,
      agentType: unit.type,
    };
    if (harness && harness !== 'auto') payload.harness = harness;
    if (provider && provider !== 'auto') payload.provider = provider;
    if (model) payload.model = model;
    bridge.send('unit_command', payload);
    state.setUnitState(unit.id, 'working');
    input.value = '';
  };

  document
    .getElementById('btn-send-mission')
    ?.addEventListener('click', () => sendMessage(missionInput));
  missionInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.stopPropagation();
      sendMessage(missionInput);
    }
  });

  document.getElementById('btn-chat-send')?.addEventListener('click', () => sendMessage(chatInput));
  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.stopPropagation();
      sendMessage(chatInput);
    }
  });

  // ─── Side panel close ────────────────────────────────────────────────────
  document.getElementById('side-panel-close')?.addEventListener('click', () => closeSidePanel());

  // ─── Side panel tabs ─────────────────────────────────────────────────────
  wireSideTabs((tab) => {
    const unit = state.selectedUnit;
    if (!unit) return;
    const cityHere = state.world.cities.find((c) =>
      c.territory.some((t) => t.q === unit.coord.q && t.r === unit.coord.r),
    );
    if (tab === 'git' && cityHere) loadGitInfo(cityHere.id);
    if (tab === 'files' && cityHere) loadFilesInfo(cityHere.id);
  });

  // ─── City panel ──────────────────────────────────────────────────────────
  wireCityPanel();

  // ─── Quest board ─────────────────────────────────────────────────────────
  document.getElementById('quest-board-close')?.addEventListener('click', closeQuestBoard);
  wireQuestBoardTabs(state);

  // ─── Keyboard help close ─────────────────────────────────────────────────
  document.getElementById('kbh-close')?.addEventListener('click', () => toggleKeyboardHelp(false));
}
