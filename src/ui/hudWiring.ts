import { type Unit, tileKey } from '../types.ts';
import { type Renderer } from '../renderer.ts';
import { type GameState } from '../game.ts';
import { type BridgeEvents } from '../bridge.ts';
import { terminalPanel } from '../terminalPanel.ts';
import {
  showUnitPanel,
  hideUnitPanel,
  renderHeroBar,
  openSidePanel,
  closeSidePanel,
  isSidePanelOpen,
  appendUserMessage,
  wireSideTabs,
  loadGitInfo,
  loadFilesInfo,
  openQuestBoard,
  closeQuestBoard,
  isQuestBoardOpen,
  wireQuestBoardTabs,
  fetchPersistedMissions,
  renderQuestBoard,
  toggleKeyboardHelp,
  closeCityPanel,
  isCityPanelOpen,
  wireCityPanel,
  togglePriorityPanel,
  toggleTimelinePanel,
  closeTimelinePanel,
  isTimelinePanelOpen,
  toggleApprovalPanel,
  closeApprovalPanel,
  isApprovalPanelOpen,
  toggleObservabilityPanel,
  closeObservabilityPanel,
  isObservabilityPanelOpen,
  toggleReplayPanel,
  closeReplayPanel,
  isReplayPanelOpen,
  toggleLedger,
  closeLedger,
  isLedgerOpen,
  closeTaskPanel,
  isTaskPanelOpen,
  closePendingPanel,
  isPendingPanelOpen,
  closeLogPanel,
  isLogPanelOpen,
  getSelectedConfig,
} from './index.ts';
import { toggleSettingsPanel, closeSettingsPanel } from './settingsPanel.ts';
import {
  closeConstructionPanel,
  isConstructionPanelOpen,
  toggleConstructionPanel,
} from './constructionPanel.ts';

// ─── Hero selection ──────────────────────────────────────────────────────────
export function selectHero(unit: Unit, renderer: Renderer, state: GameState, _bridge: BridgeEvents) {
  state.selectUnit(unit);
  renderer.selectUnit(unit);
  showUnitPanel(unit);
  renderHeroBar(state, (u) => selectHero(u, renderer, state, _bridge));

  // Auto-open side panel & load city context if hero is on a city
  if (isSidePanelOpen()) {
    openSidePanel(unit);
    const cityHere = state.world.cities.find(
      (c) => c.coord.q === unit.coord.q && c.coord.r === unit.coord.r,
    );
    if (cityHere) {
      loadGitInfo(cityHere.id);
      loadFilesInfo(cityHere.id);
    }
  }
}

// ─── HUD wiring ───────────────────────────────────────────────────────────────
export function wireHUD(
  renderer: Renderer,
  state: GameState,
  bridge: BridgeEvents,
  toggleView: () => void,
) {
  const missionInput = document.getElementById('mission-input') as HTMLInputElement;

  // ─── Hotkeys ────────────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

    // Hotkey panels
    if (e.key === 'F7') {
      e.preventDefault();
      toggleReplayPanel();
      return;
    }
    if (e.key === 'F8') {
      e.preventDefault();
      toggleObservabilityPanel();
      return;
    }
    if (e.key === 'F10') {
      e.preventDefault();
      toggleTimelinePanel();
      return;
    }

    // Esc: close overlays
    if (e.key === 'Escape') {
      if (isLedgerOpen()) {
        closeLedger();
        return;
      }
      if (terminalPanel.isVisible()) {
        terminalPanel.hide();
        return;
      }
      if (isReplayPanelOpen()) {
        closeReplayPanel();
        return;
      }
      if (isObservabilityPanelOpen()) {
        closeObservabilityPanel();
        return;
      }
      if (isTaskPanelOpen()) {
        closeTaskPanel();
        return;
      }
      if (isPendingPanelOpen()) {
        closePendingPanel();
        return;
      }
      if (isLogPanelOpen()) {
        closeLogPanel();
        return;
      }
      if (isApprovalPanelOpen()) {
        closeApprovalPanel();
        return;
      }
      if (isTimelinePanelOpen()) {
        closeTimelinePanel();
        return;
      }
      if (isCityPanelOpen()) {
        closeCityPanel();
        return;
      }
      if (isQuestBoardOpen()) {
        closeQuestBoard();
        return;
      }
      const help = document.getElementById('keyboard-help');
      if (help && !help.classList.contains('hidden')) {
        toggleKeyboardHelp(false);
        return;
      }
      if (isSidePanelOpen()) {
        closeSidePanel();
        return;
      }
      if (isConstructionPanelOpen()) {
        closeConstructionPanel();
        return;
      }
      closeSettingsPanel();
      if (state.selectedUnit) {
        state.selectUnit(null);
        renderer.selectUnit(null);
        hideUnitPanel();
        renderHeroBar(state, (u) => selectHero(u, renderer, state, bridge));
      }
      return;
    }

    if (inField) return;

    // Spawn agents (Q/W/E/L)
    if (e.key.toLowerCase() === 'q') return spawnAgent('DAVI', state, renderer, bridge);
    if (e.key.toLowerCase() === 'w') return spawnAgent('WORKER', state, renderer, bridge);
    if (e.key.toLowerCase() === 'e') return spawnAgent('SCOUT', state, renderer, bridge);
    if (e.key.toLowerCase() === 'l') return spawnAgent('LEXO', state, renderer, bridge);
    if (e.key.toLowerCase() === 'o') return spawnAgent('OPENCLAW', state, renderer, bridge);

    // Hero selection 1–9
    if (/^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      const heroes = state.getAllUnits();
      const target = heroes[idx];
      if (target) selectHero(target, renderer, state, bridge);
      return;
    }

    // Space: cycle to idle hero
    if (e.key === ' ') {
      e.preventDefault();
      const heroes = state.getAllUnits().filter((u) => u.state === 'idle');
      if (heroes.length === 0) return;
      const cur = state.selectedUnit;
      const idx = cur ? heroes.findIndex((h) => h.id === cur.id) : -1;
      const next = heroes[(idx + 1) % heroes.length]!;
      selectHero(next, renderer, state, bridge);
      return;
    }

    // Tab: cycle through all heroes
    if (e.key === 'Tab') {
      e.preventDefault();
      const heroes = state.getAllUnits();
      if (heroes.length === 0) return;
      const cur = state.selectedUnit;
      const idx = cur ? heroes.findIndex((h) => h.id === cur.id) : -1;
      const next = heroes[(idx + 1) % heroes.length]!;
      selectHero(next, renderer, state, bridge);
      return;
    }

    // Enter: toggle side panel
    if (e.key === 'Enter') {
      const unit = state.selectedUnit;
      if (!unit) return;
      if (isSidePanelOpen()) closeSidePanel();
      else openSidePanel(unit);
      return;
    }

    // Modes & toggles
    switch (e.key.toLowerCase()) {
      case 'm':
        renderer.setActionMode('move');
        break;
      case 's':
        renderer.sleepSelectedUnit();
        break;
      case 'b':
        renderer.setActionMode('build');
        break;
      case 'g':
        renderer.toggleGrid();
        break;
      case 'f':
        renderer.toggleDebug();
        break;
      case 'v':
        renderer.toggleFog();
        break;
      case '3':
        toggleView();
        break;
      case 'a':
        toggleApprovalPanel();
        break;
      case 't':
        void terminalPanel.toggle();
        break;
      case 'p':
        togglePriorityPanel(state.getMissionQueue(), (missionId) => {
          state.dispatchMissionById(missionId);
        });
        break;
      case '?':
        toggleKeyboardHelp();
        break;
    }

    if (e.key === 'F6') {
      e.preventDefault();
      toggleLedger(state, (cityId) => {
        const city = state.world.cities.find((c) => c.id === cityId);
        if (city) renderer.centerOn(city.coord);
      });
    }

    if (e.key === 'F9') {
      e.preventDefault();
      if (isQuestBoardOpen()) closeQuestBoard();
      else
        (async () => {
          const persisted = await fetchPersistedMissions();
          openQuestBoard(state);
          renderQuestBoard(state, persisted);
        })();
    }

    if (e.key === 'F11') {
      e.preventDefault();
      toggleSettingsPanel();
    }

    if (e.key === 'F12') {
      e.preventDefault();
      takeScreenshot(renderer);
    }
  });

  // ─── Spawn buttons (Q/W/E/L) ────────────────────────────────────────────
  document.querySelectorAll<HTMLButtonElement>('.spawn-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset['type'] as string;
      spawnAgent(type, state, renderer, bridge);
    });
  });

  // ─── Screenshot button ───────────────────────────────────────────────────
  document
    .getElementById('btn-screenshot')
    ?.addEventListener('click', () => takeScreenshot(renderer));
  document.getElementById('btn-construction')?.addEventListener('click', () => toggleConstructionPanel());

  // ─── Settings button ─────────────────────────────────────────────────────
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

// ─── Multi-spawn counter ─────────────────────────────────────────────────────
const spawnCounters: Record<string, number> = {};

function getNextUnitId(base: string): string {
  spawnCounters[base] = (spawnCounters[base] ?? 0) + 1;
  return spawnCounters[base] === 1 ? base : `${base}-${spawnCounters[base]}`;
}

// ─── Spawn an agent at the capital (or near existing units) ─────────────────
function spawnAgent(base: string, state: GameState, renderer: Renderer, bridge: BridgeEvents) {
  // If base unit (no suffix) exists and is idle, just select it instead of spawning another
  const baseUnit = state.getUnit(base);
  if (baseUnit && baseUnit.state === 'idle' && !state.getUnit(`${base}-2`)) {
    selectHero(baseUnit, renderer, state, bridge);
    return;
  }

  const unitId = getNextUnitId(base);
  const capital = state.world.cities.find((c) => c.isCapital) ?? state.world.cities[0];
  const existingCount = state.getAllUnits().filter((u) => u.id.startsWith(base)).length;
  const offset = existingCount % 6;
  const coord = capital
    ? { q: capital.coord.q + 1 + (offset % 3), r: capital.coord.r - Math.floor(offset / 3) }
    : { q: 1 + offset, r: 0 };

  const typeMap: Record<string, 'hero' | 'worker' | 'scout' | 'lexo'> = {
    DAVI: 'hero',
    WORKER: 'worker',
    SCOUT: 'scout',
    LEXO: 'lexo',
    OPENCLAW: 'hero',
  };
  const type = typeMap[base] ?? 'hero';
  const unit = state.spawnUnit(unitId, unitId, type, 'gris', coord, 'En espera de misión');
  selectHero(unit, renderer, state, bridge);
}

// ─── Screenshot ──────────────────────────────────────────────────────────────
function takeScreenshot(renderer: Renderer) {
  const canvas = renderer.getCanvas();
  if (!canvas) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `repociv-${ts}.png`;
  a.click();
}
