// ─── RepoCiv — Main Entry Point ───────────────────────────────────────────────

import './styles/index.css';
import {
  generateWorld,
  reconnectCities,
  addCityToWorld,
  removeCityFromWorld,
  fetchScannedRepos,
} from './map.ts';
import { type ScannedRepo } from './map.ts';
import { Renderer } from './renderer.ts';
import { BridgeEvents } from './bridge.ts';
import { GameState } from './game.ts';
import {
  showLoadingProgress,
  hideLoadingScreen,
  showUnitPanel,
  hideUnitPanel,
  renderHeroBar,
  initExternalLibs,
  updateResource,
  toggleTimelinePanel,
  toggleApprovalPanel,
  startApprovalPolling,
  toggleObservabilityPanel,
  startObservabilityPolling,
  toggleHarnessPanel,
  startHarnessPolling,
  toggleReplayPanel,
  toggleTaskPanel,
  togglePendingPanel,
  toggleLogPanel,
  isHarnessPanelOpen,
  closeSidePanel,
  openCityPanel,
  loadGitInfo,
  loadFilesInfo,
  fetchPendingTracker,
} from './ui/index.ts';
import { refreshCityList } from './ui/constructionPanel.ts';
import { wireHUD, selectHero } from './ui/hudWiring.ts';
import { showDirectivePreview, showContextMenu, showDragTooltip } from './ui/spatialPreview.ts';
import {
  showLocalUnitTooltip,
  hideLocalUnitTooltip,
  showLocalWorkbenchTooltip,
  hideLocalWorkbenchTooltip,
  showLocalContextMenu,
  showLocalMissionPreview,
  showGitForFile,
} from './ui/localSpatialPreview.ts';
import { sendCommand } from './commandBus.ts';
import { recordGesture } from './directiveLearner.ts';
import { tileKey } from './types.ts';
import { clearChat } from './ui/chat.ts';
import { ensureRepoOnboarding } from './ui/onboardingPanel.ts';
import {
  setRendererRef,
  notifyTilePicked,
  setOnCityAddedCb,
  setOnCityDeletedCb,
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
  // Global error handlers for capturing unhandled errors (e.g., merge folder errors)
  window.onerror = (msg, source, lineno, colno, error) => {
    console.error('[Global Error]', { msg, source, lineno, colno, error: error?.stack });
    let el = document.getElementById('global-error-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'global-error-toast';
      el.style.cssText =
        'position:fixed;bottom:16px;left:16px;max-width:560px;padding:12px;background:rgba(180,30,30,0.9);color:#fff;font-family:monospace;font-size:12px;z-index:9999;border:1px solid #f44;border-radius:4px;';
      document.body.appendChild(el);
    }
    el.textContent = `Error: ${msg} ${source ? `(${source}:${lineno})` : ''}`;
    el.style.display = 'block';
    setTimeout(() => {
      el.style.display = 'none';
    }, 8000);
  };

  window.onunhandledrejection = (event) => {
    console.error('[Unhandled Rejection]', event.reason);
    let el = document.getElementById('global-error-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'global-error-toast';
      el.style.cssText =
        'position:fixed;bottom:16px;left:16px;max-width:560px;padding:12px;background:rgba(180,30,30,0.9);color:#fff;font-family:monospace;font-size:12px;z-index:9999;border:1px solid #f44;border-radius:4px;';
      document.body.appendChild(el);
    }
    el.textContent = `Unhandled Rejection: ${event.reason}`;
    el.style.display = 'block';
    setTimeout(() => {
      el.style.display = 'none';
    }, 8000);
  };

  for (let i = 0; i < loadSteps.length; i++) {
    showLoadingProgress((i / loadSteps.length) * 100, loadSteps[i]!);
    await new Promise((r) => setTimeout(r, 200));
  }

  hideLoadingScreen();
  await ensureRepoOnboarding();

  const world = await generateWorld();
  const state = new GameState(world);
  state.start();

  // Set up dynamic city add/delete callbacks from constructionPanel
  setOnCityAddedCb(async (repo: ScannedRepo, coord) => {
    // Fetch repo data to get population, terrain, etc.
    const repos = await fetchScannedRepos();
    const repoData = repos.find((r) => r.path === repo.path) ?? repo;
    // Add city to world
    addCityToWorld(state.world, repoData, coord);
    // Reconnect cities to ensure pathfinding works
    await reconnectCities(state.world);
    // Notify state update to refresh UI/renderer
    state.notifyUpdate();
  });

  setOnCityDeletedCb((repoPath: string) => {
    // Remove city from world
    const removed = removeCityFromWorld(state.world, repoPath);
    if (removed) {
      // Reconnect cities
      reconnectCities(state.world).then(() => {
        state.notifyUpdate();
      });
    }
    // Refresh construction panel city list
    refreshCityList();
  });

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

    // Add resize handle for dragging
    const resizeHandle = document.createElement('div');
    resizeHandle.style.cssText =
      'position:absolute; left:0; top:0; bottom:0; width:6px; cursor:col-resize; z-index:13;';
    panel.appendChild(resizeHandle);

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = panel.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const dx = startX - e.clientX; // Positive when dragging left (making wider)
      const newWidth = Math.max(300, Math.min(600, startWidth + dx));
      panel.style.width = `${newWidth}px`;
      // Force repaint to avoid black screen during drag
      void panel.offsetHeight;
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('repociv-side-panel-width', panel.offsetWidth.toString());
    });
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
  document.getElementById('btn-pending')?.addEventListener('click', togglePendingPanel);
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

  // ─── Local view callbacks (wired to renderer; applied lazily when localR is created) ──
  renderer.localUnitHoverCb = (unit, mx, my) => {
    if (unit) showLocalUnitTooltip(unit, { x: mx, y: my });
    else hideLocalUnitTooltip();
  };
  renderer.localWorkbenchClickCb = (tile, sx, sy) => {
    const wb = tile.workbench;
    if (!wb) return;
    const idleAgents = state
      .getAllUnits()
      .filter((u) => u.state === 'idle')
      .map((u) => ({ id: u.id, name: u.name, type: u.type }));
    const localWorld = state.localWorld;
    const repoId = localWorld?.repoId ?? wb.repoPath;
    showLocalContextMenu(wb, idleAgents, { x: sx, y: sy }, (action) => {
      if (action === 'git') {
        void showGitForFile(repoId, wb.filePath, { x: sx, y: sy });
        return;
      }
      if (action === 'code') {
        bridge.send('open_file', { filePath: wb.filePath });
        return;
      }
      if (action === 'info') {
        showLocalWorkbenchTooltip(wb, { x: sx, y: sy });
        setTimeout(() => hideLocalWorkbenchTooltip(), 3000);
        return;
      }
      showLocalMissionPreview(
        action,
        wb.fileName,
        { x: sx, y: sy },
        () => {
          state.queueLocalMission(repoId, wb.filePath, wb.fileName);
        },
        () => {},
      );
    });
  };
  renderer.localUnitClickCb = (unit, _sx, _sy) => {
    // Highlight selected local unit (future: show detail panel)
    showLocalUnitTooltip(unit, { x: _sx, y: _sy });
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

// ─── Start ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', bootstrap);
