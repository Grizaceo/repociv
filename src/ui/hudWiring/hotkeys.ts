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
  isPriorityPanelOpen,
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
  toggleTaskAssignPanel,
  isTaskAssignPanelOpen,
} from '../index.ts';
import { toggleSettingsPanel, closeSettingsPanel } from '../settingsPanel.ts';
import { closeConstructionPanel, isConstructionPanelOpen } from '../constructionPanel.ts';
import { selectHero, spawnAgent } from './spawn.ts';
import { takeScreenshot } from './screenshot.ts';
import { toggleLayerPanel, closeLayerPanel, isLayerPanelOpen } from '../layerPanel.ts';
import { trackHotkey, trackPanelOpen } from '../analytics.ts';

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
      trackHotkey('F7:replay');
      if (!isReplayPanelOpen()) trackPanelOpen('replay');
      toggleReplayPanel();
      return;
    }
    if (e.key === 'F8') {
      e.preventDefault();
      trackHotkey('F8:observability');
      if (!isObservabilityPanelOpen()) trackPanelOpen('observability');
      toggleObservabilityPanel();
      return;
    }
    if (e.key === 'F10') {
      e.preventDefault();
      trackHotkey('F10:timeline');
      if (!isTimelinePanelOpen()) trackPanelOpen('timeline');
      toggleTimelinePanel();
      return;
    }

    // Esc: close overlays
    if (e.key === 'Escape') {
      if (isLayerPanelOpen()) {
        closeLayerPanel();
        return;
      }
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

    // Spawn agents (Q/W/E/L/O/C/X)
    if (e.key.toLowerCase() === 'q') {
      trackHotkey('Q:spawn:DAVI');
      return spawnAgent('DAVI', state, renderer, bridge);
    }
    if (e.key.toLowerCase() === 'w') {
      trackHotkey('W:spawn:WORKER');
      return spawnAgent('WORKER', state, renderer, bridge);
    }
    if (e.key.toLowerCase() === 'e') {
      trackHotkey('E:spawn:SCOUT');
      return spawnAgent('SCOUT', state, renderer, bridge);
    }
    if (e.key.toLowerCase() === 'l') {
      trackHotkey('L:spawn:LEXO');
      return spawnAgent('LEXO', state, renderer, bridge);
    }
    if (e.key.toLowerCase() === 'o') {
      trackHotkey('O:spawn:OPENCLAW');
      return spawnAgent('OPENCLAW', state, renderer, bridge);
    }
    if (e.key.toLowerCase() === 'c') {
      trackHotkey('C:spawn:CLAUDE');
      return spawnAgent('CLAUDE', state, renderer, bridge);
    }
    if (e.key.toLowerCase() === 'x') {
      trackHotkey('X:spawn:CODEX');
      return spawnAgent('CODEX', state, renderer, bridge);
    }
    if (e.key.toLowerCase() === 'r') {
      trackHotkey('R:spawn:CURSOR');
      return spawnAgent('CURSOR', state, renderer, bridge);
    }

    // Hero selection 1–9
    if (/^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      const heroes = state.getAllUnits();
      const target = heroes[idx];
      if (target) {
        trackHotkey(`${e.key}:select-hero`);
        selectHero(target, renderer, state, bridge);
      }
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
      trackHotkey('Space:cycle-idle-hero');
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
      trackHotkey('Tab:cycle-hero');
      selectHero(next, renderer, state, bridge);
      return;
    }

    // Enter: toggle side panel
    if (e.key === 'Enter') {
      const unit = state.selectedUnit;
      if (!unit) return;
      trackHotkey('Enter:side-panel');
      if (!isSidePanelOpen()) trackPanelOpen('side-panel');
      if (isSidePanelOpen()) closeSidePanel();
      else openSidePanel(unit);
      return;
    }

    // Modes & toggles
    switch (e.key.toLowerCase()) {
      case 'm':
        trackHotkey('M:move-mode');
        renderer.setActionMode('move');
        break;
      case 's':
        trackHotkey('S:sleep-unit');
        renderer.sleepSelectedUnit();
        break;
      case 'b':
        trackHotkey('B:build-mode');
        renderer.setActionMode('build');
        break;
      case 'g':
        trackHotkey('G:grid');
        renderer.toggleGrid();
        break;
      case 'f':
        if (state.viewMode === 'local') {
          trackHotkey('F:local-debug');
          renderer.toggleLocalDebugOverlay();
        } else {
          trackHotkey('F:debug');
          renderer.toggleDebug();
        }
        break;
      case 'v':
        trackHotkey('V:fog');
        renderer.toggleFog();
        break;
      case '3':
        trackHotkey('3:toggle-view');
        toggleView();
        break;
      case 'a':
        trackHotkey('A:approvals');
        if (!isApprovalPanelOpen()) trackPanelOpen('approvals');
        toggleApprovalPanel();
        break;
      case 't':
        trackHotkey('T:terminal');
        if (!terminalPanel.isVisible()) trackPanelOpen('terminal');
        void terminalPanel.toggle();
        break;
      case 'p':
        trackHotkey('P:priority');
        if (!isPriorityPanelOpen()) trackPanelOpen('priority');
        togglePriorityPanel(state.getMissionQueue(), (missionId) => {
          state.dispatchMissionById(missionId);
        });
        break;
      case 'j':
        trackHotkey('J:task-assign');
        if (!isTaskAssignPanelOpen()) trackPanelOpen('task-assign');
        toggleTaskAssignPanel(
          () => state.getLocalUnits(),
          (unitId, task) => {
            state.setLocalUnitTask(unitId, task);
          },
        );
        break;
      case 'h':
        trackHotkey('H:layers');
        if (!isLayerPanelOpen()) trackPanelOpen('layers');
        toggleLayerPanel();
        break;
      case '?':
        trackHotkey('?:keyboard-help');
        toggleKeyboardHelp();
        break;
    }

    if (e.key === 'F6') {
      e.preventDefault();
      trackHotkey('F6:ledger');
      if (!isLedgerOpen()) trackPanelOpen('ledger');
      toggleLedger(state, (cityId) => {
        const city = state.world.cities.find((c) => c.id === cityId);
        if (city) renderer.centerOn(city.coord);
      });
    }

    if (e.key === 'F9') {
      e.preventDefault();
      trackHotkey('F9:quest-board');
      if (!isQuestBoardOpen()) trackPanelOpen('quest-board');
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
      trackHotkey('F11:settings');
      toggleSettingsPanel();
    }

    if (e.key === 'F12') {
      e.preventDefault();
      trackHotkey('F12:screenshot');
      takeScreenshot(renderer);
    }
  });
}
