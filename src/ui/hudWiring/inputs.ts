// ─── HUD button + input wiring (non-hotkey) ─────────────────────────────────
import { tileKey, type Unit } from '../../types.ts';
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
    // 1) Resolve target unit: honor the user's explicit agent choice.
    // Priority:
    //   a) Active chip when the side panel is open (visible to the user).
    //   b) Last chip persisted to localStorage when the panel is closed —
    //      otherwise we'd dispatch to state.selectedUnit while openSidePanel()
    //      below restores the saved chip, splitting dispatch from the UI and
    //      making a second parallel message silently land on the wrong agent.
    const chipActive = document.querySelector<HTMLElement>('.chat-agent-chip.active');
    let selectorUnitId: string | undefined = isSidePanelOpen()
      ? chipActive?.dataset['unit']
      : undefined;
    if (!selectorUnitId && !isSidePanelOpen()) {
      const saved = (() => {
        try { return localStorage.getItem('repociv:lastChatUnit'); } catch { return null; }
      })();
      if (saved && state.getUnit(saved)) selectorUnitId = saved;
    }
    const prefersSelector = !!selectorUnitId && selectorUnitId !== state.selectedUnit?.id;

    let targetUnit: Unit | null = null;
    if (prefersSelector && selectorUnitId) {
      targetUnit = state.getUnit(selectorUnitId) ?? null;
    }
    const unit = targetUnit ?? state.selectedUnit;
    if (!unit || !input || !input.value.trim()) return;

    // 2) Resolve city: if the target unit is on the map, use its position;
    //    otherwise default to "main" (virtual agent not yet spawned)
    let _cityHere = state.world.cities[0];
    if (prefersSelector && !targetUnit) {
      // Virtual agent, not on map — use first city as default
      _cityHere = state.world.cities[0];
    } else {
      const lookupCoord = unit.targetCoord ?? unit.coord;
      const tile = state.world.tiles.get(tileKey(lookupCoord));
      _cityHere =
        tile?.city ??
        state.world.cities.find((c) =>
          c.territory.some((t) => t.q === lookupCoord.q && t.r === lookupCoord.r),
        ) ??
        state.world.cities[0];
    }

    const text = input.value.trim();
    if (!isSidePanelOpen()) openSidePanel(unit);
    appendUserMessage(unit.id, text);

    // Include 3-layer config from chat UI: harness + provider + model
    const { harness, provider, model } = getSelectedConfig();
    const payload: Record<string, unknown> = {
      unit: unit.id,
      city: _cityHere?.id ?? 'main',
      mission: text,
      agentType: unit.type,
    };
    if (harness && harness !== 'auto') payload.harness = harness;
    if (provider && provider !== 'auto') payload.provider = provider;
    if (model) payload.model = model;

    // Update target indicator to reflect actual dispatch target
    const indicator = document.getElementById('chat-target-indicator');
    if (indicator) {
      const icon = document.querySelector('.chat-agent-chip.active .chip-icon')?.textContent ?? '⬡';
      indicator.textContent = `${icon} ${unit.id.toUpperCase()}`;
      indicator.title = `Enviando a: ${unit.id.toUpperCase()}`;
    }

    console.log(
      '[sendMessage] target:', unit.id,
      '| chipActive:', selectorUnitId,
      '| prefersSelector:', prefersSelector,
      '| panelOpen:', isSidePanelOpen(),
      '| harness:', harness,
      '| provider:', provider,
      '| model:', model,
    );

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
