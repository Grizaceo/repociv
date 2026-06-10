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
import { BridgeEvents, syncGraphRelationFlags } from './bridge.ts';
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
  setWebGLMetricsSource,
  toggleHarnessPanel,
  startHarnessPolling,
  toggleReplayPanel,
  toggleTaskPanel,
  togglePendingPanel,
  toggleLogPanel,
  toggleTaskAssignPanel,
  isHarnessPanelOpen,
  closeSidePanel,
  openCityPanel,
  loadGitInfo,
  loadFilesInfo,
  fetchPendingTracker,
} from './ui/index.ts';
import { mountGacetaWidget } from './ui/gacetaWidget.ts';
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
  showWhiteboardPanel,
} from './ui/localSpatialPreview.ts';
import { sendCommand } from './commandBus.ts';
import { recordGesture } from './directiveLearner.ts';
import { tileKey } from './types.ts';
import type { LocalRoom, LocalNpc } from './types.ts';
import { clearChat } from './ui/chat.ts';
import { openOnboardingPanel } from './ui/onboardingPanel.ts';
import { axialToPixel } from './hex.ts';
import {
  setRendererRef,
  notifyTilePicked,
  setOnCityAddedCb,
  setOnCityDeletedCb,
} from './ui/constructionPanel.ts';

import { getStoredEraLabel } from './ui/eraSystem.ts';
import { logEvent } from './ui/hud.ts';
import { trackPanelOpen } from './ui/analytics.ts';
import { initBubbleLayer, updateBubble, clearAllBubbles } from './ui/actionBubbles.ts';
import { openWonderVignette } from './ui/wonderVignette.ts';
import { bindOrdenDeBatalla } from './ui/ordenDeBatalla.ts';
import { bindSubagentSessionPanel } from './ui/subagentSessionPanel.ts';
import { bindSlashCommandState } from './ui/chat/slashCommands.ts';
import { getWonder } from './wonders/manifest.ts';
import {
  inferCityLabStatus,
  resolveCityLabStatus,
  buildLabActionWarning,
  type CityLabStatus,
} from './labhubStatus.ts';
import {
  postContextToWonder,
  postFocusToWonder,
  postOpenLocalViewToWonder,
} from './wonders/postMessageBridge.ts';
import { findCityByWonderSelection, findNearbyCities } from './wonders/bibliothecaBridge.ts';
import { loadWonderConfig, isFeatureEnabled } from './wonders/wonderConfig.ts';
import type { City } from './types.ts';
import {
  toggleLayerPanel,
  initLayerPanel,
  setOnCleanModeChange,
  isCleanMode,
} from './ui/layerPanel.ts';
import { resolveInitialRenderMode } from './three/renderMode.ts';
import { HEX_SIZE } from './constants.ts';

// ─── Bootstrap ───────────────────────────────────────────────────────────────
const loadSteps = [
  'Escaneando workspace...',
  'Analizando repos...',
  'Construyendo mapa hexagonal...',
  'Pintando texturas de Civilización...',
  'Inicializando bridge a DAVI...',
  'Imperio listo.',
];

type RepoCivDebugApi = {
  getMacroCityScreenPositions: () => Array<{ cityId: string; x: number; y: number }>;
  openLocalView: (cityId: string) => boolean;
  isTerrainAtlasReady: () => boolean;
  queueLocalMission: (filePath: string, fileName: string, unitId?: string) => boolean;
  getLocalUnits: () => Array<{
    id: string;
    gridX: number;
    gridY: number;
    state: string;
    assignedDesk: { x: number; y: number } | null;
    currentWorkbenchId: string | null;
    pathLen: number;
  }>;
};

function showToast(message: string, duration = 3000) {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:8px 16px;background:rgba(20,20,20,0.85);color:#fff;font-family:var(--font-mono);font-size:12px;z-index:9999;border-radius:4px;pointer-events:none;transition:opacity 0.3s ease;';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

async function bootstrap() {
  // Global error handlers for capturing unhandled errors (e.g., merge folder errors)
  window.onerror = (msg, source, lineno, colno, error) => {
    // eslint-disable-next-line no-console
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
    // eslint-disable-next-line no-console
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

  // ══ Theme init from localStorage ══
  const savedTheme = localStorage.getItem('repociv:theme');
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  else document.documentElement.setAttribute('data-theme', 'dark');

  // ══ Theme toggle wiring ══
  document.getElementById('btn-theme-toggle')?.addEventListener('click', () => {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme') ?? 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('repociv:theme', next);
    // No need to re-render Lucide icons — SVG stroke uses currentColor and
    // inherits the new theme automatically.
  });

  // ══ Layer panel wiring ══
  initLayerPanel();
  document.getElementById('btn-layers')?.addEventListener('click', toggleLayerPanel);
  // Wire clean mode changes to renderer
  setOnCleanModeChange((active) => {
    renderer?.setCleanMode(active);
  });

  // ══ Imperial random salute (Whimsy) ══
  const salutes = [
    { icon: '⬡', line: 'El Imperio te espera.', sub: 'Nueva era de desarrollo.' },
    { icon: '👑', line: 'Bienvenido, Gran Estratega.', sub: 'Tus repos te saludan.' },
    { icon: '🏛', line: 'El Senado Convoca.', sub: 'Los agentes están en formación.' },
    { icon: '🦅', line: 'Ave Imperial.', sub: 'El viento sopla a favor.' },
    { icon: '⚔', line: 'Preparando legiones.', sub: 'Ningún bug se escapará.' },
  ];
  const chosen = salutes[Math.floor(Math.random() * salutes.length)]!;
  const welcome = document.createElement('div');
  welcome.id = 'imperial-welcome';
  welcome.innerHTML = `<div class="salute-icon">${chosen.icon}</div><div class="salute-line">${chosen.line}</div><div class="salute-sub">${chosen.sub}</div>`;
  document.getElementById('app')?.appendChild(welcome);
  requestAnimationFrame(() => welcome.classList.add('visible'));
  setTimeout(() => {
    welcome.style.opacity = '0';
    setTimeout(() => welcome.remove(), 800);
  }, 3200);

  await openOnboardingPanel();

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
  mountGacetaWidget();

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
  const bootRenderMode = resolveInitialRenderMode();
  await renderer.applyInitialRenderMode(bootRenderMode);
  renderer.setCleanMode(isCleanMode());
  await renderer.loadAssets();
  const capital = world.cities.find((c) => c.isCapital) ?? world.cities[0];
  if (world.tiles.size === 0) {
    logEvent('⚠ Mapa vacío — no hay repos seleccionados', 'warn');
  } else if (capital) {
    renderer.focusOnCoord(capital.coord);
  } else {
    renderer.focusOnWorldBounds();
  }
  // After the default focus so an explicit ?cam= actually wins (it used to
  // run before focusOnCoord, which silently overwrote it every boot).
  renderer.applyCameraFromUrl();
  if (bootRenderMode === 'webgl' && renderer.getWorldRenderMode() !== 'webgl') {
    showToast('WebGL no disponible — vista isométrica hexagonal');
  }
  canvas.classList.toggle('webgl-overlay', renderer.getWorldRenderMode() === 'webgl');
  void renderer.preloadLocalRenderer();
  renderer.start();
  setRendererRef(renderer);

  (
    window as Window & {
      __repocivDebug?: RepoCivDebugApi;
    }
  ).__repocivDebug = {
    getMacroCityScreenPositions: () => {
      const camera = renderer.getCamera();
      const rect = canvas.getBoundingClientRect();
      return state.world.cities
        .filter((city) => !city.isCapital)
        .map((city) => {
          const worldPos = axialToPixel(city.coord, HEX_SIZE);
          return {
            cityId: city.id,
            x: rect.left + (worldPos.x - camera.x) * camera.zoom + rect.width / 2,
            y: rect.top + (worldPos.y - camera.y) * camera.zoom + rect.height / 2,
          };
        });
    },
    isTerrainAtlasReady: () => renderer.isTerrainAtlasReady(),
    openLocalView: (cityId: string) => {
      const city = state.world.cities.find((item) => item.id === cityId && !item.isCapital);
      if (!city) return false;
      window.dispatchEvent(new CustomEvent('repociv:open-local-view-request', { detail: { cityId } }));
      return true;
    },
    // Test hook: dispatch a mission to a local-view workbench and report unit
    // state — lets the capture/probe scripts verify units actually walk to
    // their assigned desk without going through the bridge.
    queueLocalMission: (filePath: string, fileName: string, unitId?: string) => {
      const world = state.localWorld;
      if (!world) return false;
      state.queueLocalMission(world.repoId, filePath, fileName, unitId);
      return true;
    },
    getLocalUnits: () =>
      state.getLocalUnits().map((u) => ({
        id: u.id,
        gridX: u.gridX,
        gridY: u.gridY,
        state: u.state,
        assignedDesk: u.assignedDesk ?? null,
        currentWorkbenchId: u.currentWorkbenchId,
        pathLen: u.path.length,
      })),
  };

  const toggleView = () => {
    const mode = renderer.cycleWorldRenderMode();
    const labels: Record<string, string> = {
      webgl: 'Vista WebGL 3D',
      flat: 'Vista plana 2D',
    };
    showToast(labels[mode] ?? mode);
  };

  document.getElementById('btn-toggle-3d')?.classList.remove('hidden');
  document.getElementById('btn-toggle-3d')?.addEventListener('click', toggleView);
  document.getElementById('btn-timeline')?.addEventListener('click', toggleTimelinePanel);
  document.getElementById('btn-approvals')?.addEventListener('click', toggleApprovalPanel);
  document.getElementById('btn-replay')?.addEventListener('click', toggleReplayPanel);
  document.getElementById('btn-observability')?.addEventListener('click', toggleObservabilityPanel);
  document.getElementById('btn-tasks')?.addEventListener('click', toggleTaskPanel);
  document.getElementById('btn-pending')?.addEventListener('click', togglePendingPanel);
  document.getElementById('btn-log')?.addEventListener('click', toggleLogPanel);
  document.getElementById('btn-wb-labels')?.addEventListener('click', () => {
    const active = renderer.toggleWorkbenchLabels();
    const btn = document.getElementById('btn-wb-labels');
    if (btn) {
      btn.classList.toggle('active', active);
      btn.title = active ? 'Ocultar etiquetas de archivos [T]' : 'Etiquetas de archivos [T]';
    }
  });
  document.getElementById('btn-task-assign')?.addEventListener('click', () => {
    toggleTaskAssignPanel(
      () => state.getLocalUnits(),
      (unitId, task) => {
        state.setLocalUnitTask(unitId, task);
      },
    );
  });
  document.getElementById('btn-harnesses')?.addEventListener('click', () => {
    toggleHarnessPanel();
    if (isHarnessPanelOpen()) startHarnessPolling();
  });

  const bridge = new BridgeEvents(state);
  bridge.rendererRef = renderer;
  bridge.start();
  startApprovalPolling();
  setWebGLMetricsSource(() => renderer.getWebGLMetrics());
  startObservabilityPolling();
  startHarnessPolling();

  // ══ Analytics wiring ══
  const analyticsPanels = {
    'btn-approvals': 'approvals',
    'btn-timeline': 'timeline',
    'btn-observability': 'observability',
    'btn-tasks': 'tasks',
    'btn-pending': 'pending',
    'btn-log': 'log',
    'btn-settings': 'settings',
  };
  for (const [id, name] of Object.entries(analyticsPanels)) {
    document.getElementById(id)?.addEventListener('click', () => trackPanelOpen(name));
  }

  // Easter egg: press logo/era display 3 times for secret message
  let eraClicks = 0;
  document.getElementById('era-display')?.addEventListener('click', () => {
    eraClicks++;
    if (eraClicks === 3) {
      logEvent('\u00abEl Consejo Secreto te observa.\u00bb', 'info');
      eraClicks = 0;
    }
  });

  // Canvas click → select unit / open city panels
  renderer.onUnitSelect = (unit) => {
    if (unit) selectHero(unit, renderer, state, bridge);
    else {
      hideUnitPanel();
      closeSidePanel();
    }
  };
  let _selectedCityId: string | null = null;

  function _publishWonderContext(cityId?: string | null): void {
    const selected = cityId ? (state.world.cities.find((c) => c.id === cityId) ?? null) : null;
    window.dispatchEvent(
      new CustomEvent('repociv:wonder-context', {
        detail: {
          cities: state.world.cities.map((c) => ({ id: c.id, name: c.name, repoPath: c.repoPath })),
          selectedCityId: selected?.id ?? cityId ?? _selectedCityId,
          selectedRepoPath: selected?.repoPath ?? null,
        },
      }),
    );
  }

  function _syncGraphRelationOptInFlags(): void {
    const config = loadWonderConfig();
    const graphSuggestions = isFeatureEnabled(config, 'bibliotheca', 'graphSuggestions');
    const aiRelationDiscovery =
      graphSuggestions && isFeatureEnabled(config, 'bibliotheca', 'aiRelationDiscovery');
    void syncGraphRelationFlags({ graphSuggestions, aiRelationDiscovery });
  }

  async function _syncBibliothecaFocusIfOpen(
    city: City,
    mode: 'macro' | 'local' = 'macro',
  ): Promise<void> {
    const manifest = getWonder('bibliotheca');
    if (!manifest) return;
    const vignette = document.querySelector<HTMLElement>('#wonder-vignette');
    if (!vignette || vignette.dataset['wonderType'] !== 'bibliotheca') return;
    const iframe = vignette.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe) return;
    postContextToWonder(iframe, manifest, {
      cityId: city.id,
      selectedRepo: city.repoPath,
      theme: document.documentElement.dataset['theme'] ?? 'imperial-dark',
    });
    postFocusToWonder(iframe, manifest, city.id, mode);
    if (mode === 'local' && city.repoPath) {
      postOpenLocalViewToWonder(iframe, manifest, city.repoPath);
    }
  }

  async function _openBibliothecaForCity(
    city: City,
    mode: 'macro' | 'local' = 'macro',
  ): Promise<void> {
    const manifest = getWonder('bibliotheca');
    if (!manifest) return;
    const existing = document.querySelector<HTMLElement>('#wonder-vignette');
    if (!existing || existing.dataset['wonderType'] !== 'bibliotheca') {
      await openWonderVignette(manifest);
    }
    await _syncBibliothecaFocusIfOpen(city, mode);
  }

  function _enterLocalViewForCity(city: City): void {
    bridge.send('enter_local', { repoId: city.id, rootPath: city.repoPath });
    state.enterLocalView(city.id).catch(() => state.enterLocalViewMock(city.id));
    initBubbleLayer();
  }

  function _getCityLabStatus(cityId: string): CityLabStatus | null {
    const city = state.world.cities.find((c) => c.id === cityId);
    if (!city) return null;
    // Prefer synchronous inference for synchronous guards; the async resolve
    // will have already updated the panel if Institutum is online.
    return inferCityLabStatus(state, city);
  }

  async function _confirmLabSensitiveAction(cityId: string, actionLabel: string): Promise<boolean> {
    const config = loadWonderConfig();

    // Only mutating actions need warning — navigation/read focus should pass
    const isNavigation =
      actionLabel.includes('Abrir') ||
      actionLabel.includes('Ver') ||
      actionLabel.includes('focus') ||
      actionLabel.includes('navegar');
    if (isNavigation) return true;

    // Try to resolve real status (async) for better guard accuracy
    const city = state.world.cities.find((c) => c.id === cityId);
    const status = city ? await resolveCityLabStatus(state, city) : _getCityLabStatus(cityId);

    if (!status) return true;
    if (hardLocksEnabled(status, config)) {
      window.alert(
        `Bloqueo duro activo para ${cityId}.\n\n${status.lastMetric || status.labId}\n\nDesactiva hardLocks si quieres override manual.`,
      );
      return false;
    }
    if (shouldWarnForAction(config)) {
      return window.confirm(buildLabActionWarning(status, actionLabel));
    }
    return true;
  }

  function hardLocksEnabled(
    status: CityLabStatus,
    config: ReturnType<typeof loadWonderConfig>,
  ): boolean {
    return status.writeLock && isFeatureEnabled(config, 'institutum', 'hardLocks');
  }

  function shouldWarnForAction(config: ReturnType<typeof loadWonderConfig>): boolean {
    return (
      isFeatureEnabled(config, 'institutum', 'softLocks') ||
      isFeatureEnabled(config, 'institutum', 'warnBeforeCityEdit')
    );
  }

  function _primeMissionComposerForCity(city: City): void {
    const unit = state.getUnit('DAVI') ?? state.getAllUnits()[0];
    if (!unit) return;
    state.selectUnit(unit);
    renderer.selectUnit(unit);
    showUnitPanel(unit, state);
    const missionInput = document.getElementById('mission-input') as HTMLInputElement | null;
    if (missionInput) {
      missionInput.placeholder = `Misión para ${city.name} (${city.id})`;
      missionInput.focus();
    }
  }

  function _openLogsForCityStatus(city: City, status: CityLabStatus | null): void {
    const logPath = status?.links.logs;
    if (!logPath) {
      logEvent(`ℹ ${city.name}: no hay ruta de logs declarada`, 'info');
      return;
    }
    bridge.send('open_file', { filePath: logPath });
  }

  function _openInstitutumForCity(city: City): void {
    const manifest = getWonder('institutum');
    if (!manifest) return;
    void openWonderVignette(manifest).then(() => {
      const vignette = document.querySelector<HTMLElement>('#wonder-vignette');
      const iframe = vignette?.querySelector<HTMLIFrameElement>('iframe');
      if (!iframe) return;
      postContextToWonder(iframe, manifest, {
        cityId: city.id,
        selectedRepo: city.repoPath,
        theme: document.documentElement.dataset['theme'] ?? 'imperial-dark',
      });
      postFocusToWonder(iframe, manifest, city.id, 'macro');
    });
  }

  function _focusCityRequest(detail: {
    cityId?: string;
    repoPath?: string;
    nodePath?: string;
    mode?: 'macro' | 'local';
    source?: string;
  }): void {
    const cityQuery = detail.cityId ?? '';
    const target = findCityByWonderSelection(
      state.world.cities,
      cityQuery,
      detail.repoPath ?? detail.nodePath,
    );
    if (target) {
      const fullCity = state.world.cities.find((c) => c.id === target.id);
      if (!fullCity) return;

      // Si el usuario está enfocado en una unidad, no mover la cámara
      if (!state.selectedUnit) renderer.centerOn(fullCity.coord);

      renderer.onCitySelect?.(fullCity.id);
      if (detail.mode === 'local' && fullCity.repoPath) {
        _enterLocalViewForCity(fullCity);
      }
      logEvent(`📍 ${detail.source ?? 'Wonder'} → ${fullCity.name}`, 'info');
      return;
    }

    const nearby = findNearbyCities(
      state.world.cities,
      detail.repoPath || detail.nodePath || detail.cityId || '',
    );
    if (nearby.length > 0) {
      logEvent(
        `⚠ Sin match exacto para ${detail.cityId || detail.repoPath || detail.nodePath}. Cercanas: ${nearby.map((entry) => entry.city.name).join(', ')}`,
        'warn',
      );
      return;
    }
    logEvent(
      `⚠ RepoCiv no encontró ciudad para ${detail.cityId || detail.repoPath || detail.nodePath}`,
      'warn',
    );
  }

  renderer.onCitySelect = (cityId) => {
    _selectedCityId = cityId;
    const city = state.world.cities.find((c) => c.id === cityId);
    if (city) {
      const activeBuildings = state.world.buildings.filter((b) => b.cityId === cityId);
      const tile = state.world.tiles.get(tileKey(city.coord));
      // Show loading state immediately, then resolve asynchronously
      openCityPanel(city, activeBuildings, tile, null);
      void resolveCityLabStatus(state, city).then((labStatus) => {
        // Re-check same city — avoid race
        if (_selectedCityId === cityId) {
          openCityPanel(city, activeBuildings, tile, labStatus);
        }
      });
    }
    loadGitInfo(cityId);
    loadFilesInfo(cityId);
    _publishWonderContext(cityId);
    window.dispatchEvent(
      new CustomEvent('repociv:city-selected', {
        detail: { cityId, repoPath: state.world.cities.find((c) => c.id === cityId)?.repoPath },
      }),
    );
    const selectedCity = state.world.cities.find((c) => c.id === cityId);
    if (selectedCity) {
      void _syncBibliothecaFocusIfOpen(selectedCity, 'macro');
    }
  };
  _publishWonderContext(null);
  _syncGraphRelationOptInFlags();

  // Listener para "Ver feed completo →" desde el widget Gaceta
  window.addEventListener('repociv:open-city', (e: Event) => {
    const detail = (e as CustomEvent).detail as { repo?: string } | undefined;
    if (!detail?.repo) return;
    const target = state.world.cities.find(
      (c) =>
        c.id.toLowerCase() === detail.repo!.toLowerCase() ||
        (c.name || '').toLowerCase() === detail.repo!.toLowerCase(),
    );
    if (target && renderer.onCitySelect) renderer.onCitySelect(target.id);
  });

  // ─── Fase 4: Bibliotheca ↔ RepoCiv bidirectional focus (wiring real + fallback) ──
  window.addEventListener('repociv:wonder-focus-city', (e: Event) => {
    const detail = (e as CustomEvent).detail as
      | { cityId: string; mode: 'macro' | 'local' }
      | undefined;
    if (!detail?.cityId) return;
    _focusCityRequest({ cityId: detail.cityId, mode: detail.mode, source: 'Bibliotheca focus' });
  });

  window.addEventListener('repociv:wonder-selection', (e: Event) => {
    const detail = (e as CustomEvent).detail as
      | { nodeId: string; nodePath: string; nodeType: string }
      | undefined;
    if (!detail?.nodeId && !detail?.nodePath) return;
    _focusCityRequest({
      cityId: detail?.nodeId,
      nodePath: detail?.nodePath,
      source: `Bibliotheca ${detail?.nodeType ?? 'selection'}`,
    });
  });

  window.addEventListener('repociv:focus-city-request', (e: Event) => {
    const detail = (e as CustomEvent).detail as
      | {
          cityId?: string;
          repoPath?: string;
          nodePath?: string;
          mode?: 'macro' | 'local';
          source?: string;
        }
      | undefined;
    if (!detail) return;
    _focusCityRequest(detail);
  });

  window.addEventListener('repociv:open-bibliotheca-request', (e: Event) => {
    const detail = (e as CustomEvent).detail as { cityId?: string; repoPath?: string } | undefined;
    if (!detail?.cityId) return;
    const city = state.world.cities.find((c) => c.id === detail.cityId);
    if (!city) return;
    void _openBibliothecaForCity(city, 'macro');
  });

  window.addEventListener('repociv:open-local-view-request', (e: Event) => {
    const detail = (e as CustomEvent).detail as { cityId?: string; repoPath?: string } | undefined;
    if (!detail?.cityId) return;
    const city = state.world.cities.find((c) => c.id === detail.cityId);
    if (!city) return;
    _enterLocalViewForCity(city);
  });

  window.addEventListener('repociv:open-institutum-request', (e: Event) => {
    const detail = (e as CustomEvent).detail as { cityId?: string } | undefined;
    if (!detail?.cityId) return;
    const city = state.world.cities.find((c) => c.id === detail.cityId);
    if (!city) return;
    _openInstitutumForCity(city);
  });

  window.addEventListener('repociv:open-city-logs-request', (e: Event) => {
    const detail = (e as CustomEvent).detail as { cityId?: string; labStatus?: string } | undefined;
    if (!detail?.cityId) return;
    const city = state.world.cities.find((c) => c.id === detail.cityId);
    if (!city) return;
    let status: CityLabStatus | null;
    if (detail.labStatus) {
      try {
        status = JSON.parse(detail.labStatus) as CityLabStatus;
      } catch {
        // Corrupt/unexpected dataset payload — fall back to the resolved status.
        status = _getCityLabStatus(city.id);
      }
    } else {
      status = _getCityLabStatus(city.id);
    }
    _openLogsForCityStatus(city, status);
  });

  window.addEventListener('repociv:city-mission-request', async (e: Event) => {
    const detail = (e as CustomEvent).detail as { cityId?: string } | undefined;
    if (!detail?.cityId) return;
    const city = state.world.cities.find((c) => c.id === detail.cityId);
    if (!city) return;
    if (!(await _confirmLabSensitiveAction(city.id, `Enviar misión manual a ${city.name}`))) return;

    if (!state.selectedUnit) renderer.centerOn(city.coord);

    renderer.onCitySelect?.(city.id);
    _primeMissionComposerForCity(city);
    logEvent(`🧪 Mission composer preparado para ${city.name}`, 'info');
  });

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
  renderer.onEnterLocal = (repoId, _rootPath) => {
    const city = state.world.cities.find((c) => c.id === repoId);
    if (!city) return;
    _enterLocalViewForCity(city);
  };

  // ─── Local view callbacks (wired to renderer; applied lazily when localR is created) ──
  renderer.localUnitHoverCb = (unit, mx, my) => {
    if (unit) showLocalUnitTooltip(unit, { x: mx, y: my });
    else hideLocalUnitTooltip();
  };
  renderer.localWorkbenchClickCb = (tile, sx, sy) => {
    const wb = tile.workbench;
    if (!wb) return;
    const availableAgents = state
      .getAllUnits()
      .map((u) => ({ id: u.id, name: u.name, type: u.type, state: u.state }));
    const localWorld = state.localWorld;
    const repoId = localWorld?.repoId ?? wb.repoPath;
    showLocalContextMenu(wb, availableAgents, { x: sx, y: sy }, async (action) => {
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
      if (!(await _confirmLabSensitiveAction(repoId, `Editar/local mission sobre ${wb.fileName}`)))
        return;
      // Resolve which agent will receive the mission: prefer idle, fallback to busy ones
      const agentUnit = action === 'WORKER'
        ? (state.getAllUnits().find((u) => u.type === 'worker' && u.state === 'idle') ??
           state.getAllUnits().find((u) => u.type === 'worker'))
        : (state.getUnit('DAVI') ??
           state.getAllUnits().find((u) => u.id === 'DAVI') ??
           state.getAllUnits().find((u) => u.state === 'idle'));
      const agentId = agentUnit?.id ?? action;
      // Resolve the actual repo filesystem path for bridge context
      const city = state.world.cities.find((c) => c.id === repoId);
      const repoPath = city?.repoPath ?? wb.repoPath ?? repoId;
      showLocalMissionPreview(
        action,
        wb.fileName,
        { x: sx, y: sy },
        () => {
          // 1. Animate the unit walking to the workbench locally
          state.queueLocalMission(repoId, wb.filePath, wb.fileName, agentId);
          // 2. Dispatch the real agent command to the bridge with full repo context
          void sendCommand({
            type: 'execute_agent',
            target: agentId,
            payload: {
              unit: agentId,
              city: repoId,
              repoPath,
              filePath: wb.filePath,
              fileName: wb.fileName,
              mission: `Trabajar en ${wb.fileName}`,
              cwd: repoPath,
            },
            created_by: 'local_view',
          });
        },
        () => {},
      );
    });
  };
  renderer.localUnitClickCb = (unit, _sx, _sy) => {
    // Highlight selected local unit (future: show detail panel)
    showLocalUnitTooltip(unit, { x: _sx, y: _sy });
  };
  // Pan the local-view camera to the room matching `folderName`, or toast if it has no room of its own.
  const navigateToFolder = (folderName: string) => {
    const lw = state.getLocalWorld();
    const target = lw?.rooms.find((r: LocalRoom) => r.folderName === folderName || r.label === folderName);
    if (target) {
      renderer.animateCameraToGrid(target.x + target.width / 2, target.y + target.height / 2, 500);
    } else {
      showToast(`📁 ${folderName} no tiene sala propia`);
    }
  };
  renderer.localNpcClickCb = (npc: LocalNpc, sx, sy) => {
    const localWorld = state.getLocalWorld();
    const room = localWorld?.rooms.find((r: LocalRoom) => r.id === npc.roomId);
    if (room) {
      showWhiteboardPanel(
        room,
        { x: sx, y: sy },
        (folderPath) => { bridge.send('open_file', { filePath: folderPath }); },
        navigateToFolder,
      );
    }
  };
  // ─── Kiosk click → discover rest area with 1.25x bonus ───────────────────
  renderer.localTileClickCb = (x, y, tile, sx, sy) => {
    if (tile?.type === 'kiosk') {
      bridge.send('discover_rest_area', {
        restAreaId: `kiosk-${x}-${y}`,
        roomId: 'kiosk',
        coord: [x, y],
      });
      return;
    }
    if (tile?.type === 'whiteboard') {
      const localWorld = state.getLocalWorld();
      const room = localWorld?.rooms.find((r: LocalRoom) => r.id === tile.roomId);
      if (room) {
        showWhiteboardPanel(
          room,
          { x: sx, y: sy },
          (folderPath) => { bridge.send('open_file', { filePath: folderPath }); },
          navigateToFolder,
        );
      }
      return;
    }
  };

  // ─── Phase 9: Action Bubbles ─────────────────────────────────────────────
  renderer.localUnitRenderedCb = (unit, sx, sy) => updateBubble(unit, sx, sy);
  renderer.onExitLocalView = () => clearAllBubbles();

  // Zone painting: wire to LocalWorldManager
  renderer.onZonePaintedCb = (type, tiles) => {
    const lw = state.getLocalWorld();
    if (!lw) return;
    if (!lw.zones) lw.zones = [];
    const zoneId = `zone-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    lw.zones.push({
      id: zoneId,
      type,
      tiles,
      filters: [],
      priority: 1,
    });
    // Also update tile types visually
    for (const t of tiles) {
      const tile = lw.grid[t.y]?.[t.x];
      if (tile) tile.type = 'stockpile';
    }
    state.notifyUpdate();
  };

  // Spawn DAVI as the default hero, near the capital if present
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
    if (state.selectedUnit) showUnitPanel(state.selectedUnit, state);
  };
  state.subscribe(refreshHero);
  bindOrdenDeBatalla(state);
  bindSubagentSessionPanel(state);
  bindSlashCommandState(state);
  refreshHero();
}

// ─── Start ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', bootstrap);

// ─── Post-load era display sync ─────────────────────────────────────────────
const eraEl = document.getElementById('era-display');
if (eraEl) eraEl.textContent = getStoredEraLabel();
