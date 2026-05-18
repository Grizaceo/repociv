// ─── Global keyboard hotkeys ────────────────────────────────────────────────
import { type Renderer } from '../../renderer.ts';
import { type GameState } from '../../game.ts';
import { type BridgeEvents } from '../../bridge.ts';
import { terminalPanel } from '../../terminalPanel.ts';
import {
  hideUnitPanel,
  renderHeroBar,
  openSidePanel,
  closeSidePanel,
  isSidePanelOpen,
  openQuestBoard,
  closeQuestBoard,
  isQuestBoardOpen,
  fetchPersistedMissions,
  renderQuestBoard,
  toggleKeyboardHelp,
  closeCityPanel,
  isCityPanelOpen,
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
} from '../index.ts';
import { toggleSettingsPanel, closeSettingsPanel } from '../settingsPanel.ts';
import { closeConstructionPanel, isConstructionPanelOpen } from '../constructionPanel.ts';
import { selectHero, spawnAgent } from './spawn.ts';
import { takeScreenshot } from './screenshot.ts';

export function wireHotkeys(
  renderer: Renderer,
  state: GameState,
  bridge: BridgeEvents,
  toggleView: () => void,
): void {
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

    // Spawn agents (Q/W/E/L/O)
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
}
