// ─── Global keyboard hotkeys ────────────────────────────────────────────────
import { type Renderer } from '../../renderer.ts';
import { type GameState } from '../../game.ts';
import { type BridgeEvents } from '../../bridge.ts';
import { terminalPanel } from '../../terminalPanel.ts';
import {
  hideUnitPanel,
  openSidePanel,
  closeSidePanel,
  isSidePanelOpen,
  toggleKeyboardHelp,
  closeCityPanel,
  isCityPanelOpen,
  togglePriorityPanel,
  isPriorityPanelOpen,
  toggleApprovalPanel,
  closeApprovalPanel,
  isApprovalPanelOpen,
  closeTaskPanel,
  toggleTaskPanel,
  isTaskPanelOpen,
  closePendingPanel,
  isPendingPanelOpen,
  closeLogPanel,
  toggleLogPanel,
  isLogPanelOpen,
  toggleTaskAssignPanel,
  isTaskAssignPanelOpen,
  toggleKanbanPanel,
  closeKanbanPanel,
  isKanbanPanelOpen,
} from '../index.ts';
import { toggleSettingsPanel, closeSettingsPanel } from '../settingsPanel.ts';
import {
  toggleAgentsPanel,
  closeAgentsPanel,
  isAgentsPanelOpen,
  openNewAgentSession,
  openExternalAgentChat,
} from '../agentsPanel.ts';
import { closeConstructionPanel, isConstructionPanelOpen } from '../constructionPanel.ts';
import { selectHero } from './spawn.ts';
import { takeScreenshot } from './screenshot.ts';
import { getSelectedProfile } from '../agentProfileStrip.ts';
import type { RepoCivProfile } from '../../agentProfile.ts';
import { heroBarRoster } from '../heroBarUnits.ts';
import { activeSessionDock, visibleSessionDock } from '../agentDock.ts';
import { externalSessionSnapshot } from '../externalSessionDirectory.ts';
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
  let lastDockKey: string | null = null;
  const selectDockItem = (item: ReturnType<typeof activeSessionDock>[number]) => {
    lastDockKey = `${item.kind}:${item.key}`;
    if (item.kind === 'external') {
      state.selectUnit(null);
      renderer.selectUnit(null);
      hideUnitPanel();
      openExternalAgentChat(item.key);
      return;
    }
    const unit = state.getUnit(item.key);
    if (unit) selectHero(unit, renderer, state, bridge);
  };

  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

    // A modal slash-picker (/model · /harness · /provider) owns the keyboard
    // while open: it handles Esc/arrows/Enter/digits/type-ahead itself, so no
    // global hotkey (spawn letters, hero numbers, panel toggles, or the
    // Esc-closes-panel branch) may fire underneath it.
    if (isPickerOpen()) return;

    // Same for the command palette (Ctrl/Cmd-K): while open it is modal, so no
    // global hotkey — including the F-key panel toggles (F6/F8/F9/F10/F11/F12)
    // below — may fire and open a panel behind the overlay.
    if (isCommandPaletteOpen()) return;

    // Native session wizard is modal too. Returning lets its form and the
    // browser's Esc-to-close behavior own this event without moving the map.
    if (document.querySelector('dialog[open]')) return;

    // Hotkey panels
    if (e.key === 'Escape') {
      if (isLayerPanelOpen()) {
        closeLayerPanel();
        return;
      }
      if (terminalPanel.isVisible()) {
        terminalPanel.hide();
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
      if (isAgentsPanelOpen()) {
        closeAgentsPanel();
        return;
      }
      if (isApprovalPanelOpen()) {
        closeApprovalPanel();
        return;
      }
      if (isKanbanPanelOpen()) {
        closeKanbanPanel();
        return;
      }
      if (isCityPanelOpen()) {
        closeCityPanel();
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
      }
      return;
    }

    if (inField) return;

    // N still manages the profile registry; session creation always goes through
    // the wizard so profile + territory + mission are explicit before dispatch.
    if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      trackHotkey('N:new-profile');
      void import('../agentProfileStrip.ts').then(({ openNewProfileWizard }) => {
        void openNewProfileWizard();
      });
      return;
    }
    const quickHarness: Record<string, RepoCivProfile['harness']> = {
      q: 'hermes',
      w: 'openclaw',
      e: 'claude',
      o: 'openclaw',
      c: 'claude',
      x: 'codex',
      r: 'cursor',
      g: 'hermes',
    };
    const quickKey = e.key.toLowerCase();
    if (
      (e.ctrlKey && !e.shiftKey && quickKey !== 'w' && quickHarness[quickKey]) ||
      (e.ctrlKey && e.shiftKey && quickKey === 'w') ||
      (!e.ctrlKey && !e.altKey && !e.metaKey && quickKey === 'r')
    ) {
      e.preventDefault();
      const selectedProfile = quickKey === 'q' ? getSelectedProfile() : null;
      trackHotkey(`session-wizard:${quickKey}`);
      openNewAgentSession({
        profileName: selectedProfile?.name,
        harness: selectedProfile ? undefined : quickHarness[quickKey],
      });
      return;
    }

    // Hero selection 1–9 is the same active-session dock the HUD renders.
    if (/^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      const target = visibleSessionDock(
        activeSessionDock(state.getAllUnits(), externalSessionSnapshot()),
      )[idx];
      if (target) {
        trackHotkey(`${e.key}:select-session`);
        selectDockItem(target);
      }
      return;
    }

    // Space: cycle to idle hero
    if (e.key === ' ') {
      e.preventDefault();
      const heroes = heroBarRoster(state).filter((u) => u.state === 'idle');
      if (heroes.length === 0) return;
      const cur = state.selectedUnit;
      const idx = cur ? heroes.findIndex((h) => h.id === cur.id) : -1;
      const next = heroes[(idx + 1) % heroes.length]!;
      trackHotkey('Space:cycle-idle-hero');
      selectHero(next, renderer, state, bridge);
      return;
    }

    // Tab: cycle through every active session, including external sessions.
    if (e.key === 'Tab') {
      e.preventDefault();
      const dock = activeSessionDock(state.getAllUnits(), externalSessionSnapshot());
      if (dock.length === 0) return;
      const selectedKey = state.selectedUnit ? `own:${state.selectedUnit.id}` : lastDockKey;
      const idx = selectedKey
        ? dock.findIndex((item) => `${item.kind}:${item.key}` === selectedKey)
        : -1;
      const next = dock[(idx + 1) % dock.length]!;
      trackHotkey('Tab:cycle-session');
      selectDockItem(next);
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
      case 'u':
        trackHotkey('U:unhide-all');
        state.unhideAllUnits();
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
      trackHotkey('F6:kanban');
      toggleKanbanPanel();
    }

    if (e.key === 'F8') {
      e.preventDefault();
      trackHotkey('F8:agents');
      toggleAgentsPanel();
    }

    if (e.key === 'F9') {
      e.preventDefault();
      trackHotkey('F9:tasks');
      toggleTaskPanel();
    }

    if (e.key === 'F10') {
      e.preventDefault();
      trackHotkey('F10:log');
      toggleLogPanel();
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
