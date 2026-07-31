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
import { selectHero, spawnAgent, spawnFromProfile } from './spawn.ts';
import { takeScreenshot } from './screenshot.ts';
import { getSelectedProfile } from '../agentProfileStrip.ts';
import { toggleLayerPanel, closeLayerPanel, isLayerPanelOpen } from '../layerPanel.ts';
import { trackHotkey, trackPanelOpen } from '../analytics.ts';
import { isPickerOpen } from '../chat/slashPicker.ts';
import { isCommandPaletteOpen } from '../commandPalette.ts';
import { sharedIdleFinder } from '../idleAgentFinder.ts';

export function wireHotkeys(
  renderer: Renderer,
  state: GameState,
  bridge: BridgeEvents,
  toggleView: () => void,
): void {
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

    // A modal slash-picker (/model · /harness · /provider) owns the keyboard
    // while open: it handles Esc/arrows/Enter/digits/type-ahead itself, so no
    // global hotkey (spawn letters, hero numbers, panel toggles, or the
    // Esc-closes-panel branch) may fire underneath it.
    if (isPickerOpen()) return;

    // Same for the command palette (Ctrl/Cmd-K): while open it is modal, so no
    // global hotkey — especially the F7/F8/F10 branches below, which run before
    // the inField guard — may fire and open a panel behind the overlay.
    if (isCommandPaletteOpen()) return;

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

    // Spawn agents (Ctrl+Q/W/E/O/C/X). WASD is reserved for camera panning,
    // so every spawn hotkey now requires Ctrl. Ctrl+W would close the browser
    // tab (not interceptable), so WORKER uses Ctrl+Shift+W; Ctrl+R would
    // reload the page, so CURSOR stays on bare R. N opens the new profile
    // wizard.
    if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      trackHotkey('N:new-profile');
      // Delegate to profile strip wizard (loaded lazily)
      void import('../agentProfileStrip.ts').then(({ openNewProfileWizard }) => {
        void openNewProfileWizard();
      });
      return;
    }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      // If a profile is selected in the strip, spawn from it; else fall back to MAIN
      const selectedProfile = getSelectedProfile();
      if (selectedProfile) {
        trackHotkey(`Ctrl+Q:spawn-profile:${selectedProfile.name}`);
        return spawnFromProfile(selectedProfile, state, renderer, bridge);
      }
      trackHotkey('Ctrl+Q:spawn:MAIN');
      return spawnAgent('MAIN', state, renderer, bridge);
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      trackHotkey('Ctrl+Shift+W:spawn:WORKER');
      return spawnAgent('WORKER', state, renderer, bridge);
    }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      trackHotkey('Ctrl+E:spawn:SCOUT');
      return spawnAgent('SCOUT', state, renderer, bridge);
    }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      trackHotkey('Ctrl+O:spawn:OPENCLAW');
      return spawnAgent('OPENCLAW', state, renderer, bridge);
    }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      trackHotkey('Ctrl+C:spawn:CLAUDE');
      return spawnAgent('CLAUDE', state, renderer, bridge);
    }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      trackHotkey('Ctrl+X:spawn:CODEX');
      return spawnAgent('CODEX', state, renderer, bridge);
    }
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'r') {
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

    // ,: focus camera on next idle unit (Age of Empires pattern)
    if (e.key === ',') {
      e.preventDefault();
      if (document.body.classList.contains('local-view')) return;
      const idle = sharedIdleFinder.nextIdle(state.getAllUnits());
      if (idle) {
        trackHotkey(',:find-idle');
        renderer.focusOnCoord(idle.coord);
        renderer.flashIdleHighlight(idle.coord);
      }
      return;
    }

    // Enter: toggle side panel
    if (e.key === 'Enter') {
      const unit = state.selectedUnit;
      if (!unit) return;
      trackHotkey('Enter:side-panel');
      if (!isSidePanelOpen()) trackPanelOpen('side-panel');
      if (isSidePanelOpen()) closeSidePanel();
      else void openSidePanel(unit);
      return;
    }

    // Modes & toggles
    switch (e.key.toLowerCase()) {
      case 'm':
        trackHotkey('M:move-mode');
        renderer.setActionMode('move');
        break;
      case 's':
        // Ctrl+S: sleep unit (bare S is reserved for camera pan down)
        if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) break;
        e.preventDefault();
        trackHotkey('Ctrl+S:sleep-unit');
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
      case '2':
        trackHotkey('2:map-render-mode');
        renderer.toggleWorldRenderMode();
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
        trackHotkey('3:cycle-render-mode');
        toggleView();
        break;
      case 'a':
        // Ctrl+A: approvals panel (bare A is reserved for camera pan left)
        if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) break;
        e.preventDefault();
        trackHotkey('Ctrl+A:approvals');
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
