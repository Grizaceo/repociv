// ─── RepoCiv — Main Entry Point ───────────────────────────────────────────────

import './styles/index.css';
import { generateWorld } from './map.ts';
import { Renderer } from './renderer.ts';
import { BridgeEvents } from './bridge.ts';
import { GameState } from './game.ts';
import {
  showLoadingProgress,
  hideLoadingScreen,
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
  fetchPendingTracker,
  renderQuestBoard,
  toggleKeyboardHelp,
  openCityPanel,
  closeCityPanel,
  isCityPanelOpen,
  wireCityPanel,
  initExternalLibs,
  updateResource,
  togglePriorityPanel,
  toggleTimelinePanel,
  closeTimelinePanel,
  isTimelinePanelOpen,
  toggleApprovalPanel,
  closeApprovalPanel,
  isApprovalPanelOpen,
  startApprovalPolling,
  toggleObservabilityPanel,
  closeObservabilityPanel,
  isObservabilityPanelOpen,
  startObservabilityPolling,
  toggleHarnessPanel,
  isHarnessPanelOpen,
  startHarnessPolling,
  toggleReplayPanel,
  closeReplayPanel,
  isReplayPanelOpen,
  toggleLedger,
  closeLedger,
  isLedgerOpen,
  toggleTaskPanel,
  closeTaskPanel,
  isTaskPanelOpen,
  toggleLogPanel,
  closeLogPanel,
  isLogPanelOpen,
} from './ui/index.ts';
import { toggleSettingsPanel, closeSettingsPanel } from './ui/settingsPanel.ts';
import { showDirectivePreview, showContextMenu, showDragTooltip } from './ui/spatialPreview.ts';
import { sendCommand } from './commandBus.ts';
import { recordGesture } from './directiveLearner.ts';
import { type Unit, tileKey } from './types.ts';
import { clearChat } from './ui/chat.ts';
import { terminalPanel } from './terminalPanel.ts';
import { ensureRepoOnboarding } from './ui/onboardingPanel.ts';
import {
  closeConstructionPanel,
  isConstructionPanelOpen,
  toggleConstructionPanel,
  setRendererRef,
  notifyTilePicked,
} from './ui/constructionPanel.ts';

// ─── Bootstrap ───────────────────────────────────────────────────────────────
const loadSteps = [
  'Escaneando workspace...',
  'Analizando repos...',
  'Construyendo mapa hexagonal...',
  'Pintando texturas de Civilización...',
  'Inicializando bridge a DAVI...',
  'Imperio listo.',
];

async function bootstrap() {
  for (let i = 0; i < loadSteps.length; i++) {
    showLoadingProgress((i / loadSteps.length) * 100, loadSteps[i]!);
    await new Promise((r) => setTimeout(r, 200));
  }

  hideLoadingScreen();
  await ensureRepoOnboarding();

  const world = await generateWorld();
  const state = new GameState(world);
  state.start();
  // Clean up chat buffer when a unit is removed from the world.
  state.onUnitRemoved((unitId) => clearChat(unitId));

  // Initialize UI Libraries (Icons, Animations)
  initExternalLibs();

  // Restore saved side panel width
  const savedWidth = localStorage.getItem('repociv-side-panel-width');
  const panel = document.getElementById('side-panel');
  if (panel && savedWidth) {
    panel.style.width = `${savedWidth}px`;
  }

  // Save panel width on resize (debounced)
  if (panel) {
    let resizeTimeout: ReturnType<typeof setTimeout>;
    new ResizeObserver(() => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        localStorage.setItem('repociv-side-panel-width', panel.offsetWidth.toString());
      }, 300);
    }).observe(panel);
  }

  // Initial resources from world
  updateResource('gold', world.resources.gold);
  updateResource('science', world.resources.science);
  updateResource('production', world.resources.production);

  const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
  const renderer = new Renderer(canvas, state);
  await renderer.loadAssets();
  renderer.start();
  setRendererRef(renderer);

  const toggleView = () => {
    // 3D renderer intentionally removed: the 2D Civ view is the canonical map.
    renderer.start();
  setRendererRef(renderer);
  };

  document.getElementById('btn-toggle-3d')?.classList.add('hidden');
  document.getElementById('btn-toggle-3d')?.addEventListener('click', toggleView);
  document.getElementById('btn-timeline')?.addEventListener('click', toggleTimelinePanel);
  document.getElementById('btn-approvals')?.addEventListener('click', toggleApprovalPanel);
  document.getElementById('btn-replay')?.addEventListener('click', toggleReplayPanel);
  document.getElementById('btn-observability')?.addEventListener('click', toggleObservabilityPanel);
  document.getElementById('btn-tasks')?.addEventListener('click', toggleTaskPanel);
  document.getElementById('btn-log')?.addEventListener('click', toggleLogPanel);
  document.getElementById('btn-harnesses')?.addEventListener('click', () => {
    toggleHarnessPanel();
    if (isHarnessPanelOpen()) startHarnessPolling();
  });

  const bridge = new BridgeEvents(state);
  bridge.start();
  startApprovalPolling();
  startObservabilityPolling();
  startHarnessPolling();

  // Canvas click → select unit / open city panels
  renderer.onUnitSelect = (unit) => {
    if (unit) selectHero(unit, renderer, state, bridge);
    else {
      hideUnitPanel();
      closeSidePanel();
    }
  };
  renderer.onCitySelect = (cityId) => {
    const city = state.world.cities.find((c) => c.id === cityId);
    if (city) {
      const activeBuildings = state.world.buildings.filter((b) => b.cityId === cityId);
      const tile = state.world.tiles.get(tileKey(city.coord));
      openCityPanel(city, activeBuildings, tile);
    }
    loadGitInfo(cityId);
    loadFilesInfo(cityId);
  };

  renderer.onTileInspect = (cityName, coord, repoPath) => {
    bridge.send('tile_inspected', { cityName, coord, repoPath });
  };
  renderer.onEmptyTileClick = (coord) => {
    notifyTilePicked(coord);
  };

  // ─── Fase 5: Spatial gestures → preview card → command bus ──────────────────
  renderer.onSpatialGesture = (directive, screenPos) => {
    showDirectivePreview(
      directive,
      screenPos,
      (draft) => {
        void sendCommand(draft).then((res) => {
          if (res.ok) {
            void recordGesture({
              commandId: res.commandId,
              gesture: directive.gesture,
              agentId: String(draft.payload?.['unit'] ?? 'DAVI'),
              cmdType: draft.type,
              target: draft.target,
            });
          }
        });
      },
      () => {},
    );
  };
  renderer.onContextMenu = (items, screenPos) => {
    showContextMenu(items, screenPos, (draft) => {
      void sendCommand(draft);
    });
  };

  // ─── Fase 9: Drag tooltip with suggestion autocomplete ─────────────────────
  renderer.onDragUpdate = (gesture, agentId, screenPos, dropTarget) => {
    showDragTooltip(gesture, agentId, screenPos, dropTarget);
  };

  // ─── Phase 6: Double-click city → enter RimWorld local view ─────────────────
  renderer.onEnterLocal = (repoId, rootPath) => {
    bridge.send('enter_local', { repoId, rootPath });
    state.enterLocalView(repoId).catch(() => state.enterLocalViewMock(repoId));
  };

  // Spawn DAVI as the default hero, near the capital if present
  const capital = world.cities.find((c) => c.isCapital) ?? world.cities[0];
  const spawnAt = capital ? capital.coord : { q: 0, r: 0 };
  state.spawnUnit('DAVI', 'DAVI', 'hero', 'gris', spawnAt, 'En espera de misión');

  wireHUD(renderer, state, bridge, toggleView);

  // Load pending tracker missions at boot
  fetchPendingTracker().then((pending) => {
    for (const m of pending) {
      if (!state.missions.has(m.id)) state.missions.set(m.id, m);
    }
  });

  // Re-render hero bar on state changes
  const refreshHero = () => {
    renderHeroBar(state, (u) => selectHero(u, renderer, state, bridge));
    if (state.selectedUnit) showUnitPanel(state.selectedUnit);
  };
  state.subscribe(refreshHero);
  refreshHero();

}

// ─── Hero selection ──────────────────────────────────────────────────────────
function selectHero(unit: Unit, renderer: Renderer, state: GameState, _bridge: BridgeEvents) {
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
function wireHUD(
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
    if (e.key === 'F6') {
      e.preventDefault();
      toggleHarnessPanel();
      return;
    }
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

    bridge.send('unit_command', {
      unit: unit.id,
      city: cityHere?.id ?? 'main',
      mission: text,
      agentType: unit.type,
    });
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

// ─── Start ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', bootstrap);
