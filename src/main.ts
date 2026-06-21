// ─── RepoCiv — Main Entry Point ───────────────────────────────────────────────

import './styles/index.css';
import {
  generateWorld,
  reconnectCities,
  addCityToWorld,
  removeCityFromWorld,
  fetchScannedRepos,
  syncWorldWonders,
} from './map.ts';
import { type ScannedRepo } from './map.ts';
import { Renderer } from './renderer.ts';
import { BridgeEvents, syncGraphRelationFlags } from './bridge.ts';
import {
  ensureWondersUp,
  isAutoStartWondersEnabled,
} from './wonders/wonderLauncher.ts';
import { GameState } from './game.ts';

// ─── First-unit slot ──────────────────────────────────────────────────────────
// "MAIN" is the user's first unit — the slot configured during onboarding
// (harness selection). It exists at boot in place of the historical hardcoded
// "DAVI" spawn. Its capabilities and runtime identity are wired up by PR 2's
// onboarding step; until then it spawns as a generic hero and the bridge
// routes commands through the harness the user picked.
export const DEFAULT_USER_UNIT_ID = 'MAIN';
export const DEFAULT_USER_UNIT_NAME = 'Main';

function getFirstUserUnit(state: GameState) {
  return (
    state.getUnit(DEFAULT_USER_UNIT_ID) ??
    state.getAllUnits().find((u) => u.id === DEFAULT_USER_UNIT_ID) ??
    state.getAllUnits()[0]
  );
}
import {
  showLoadingProgress,
  hideLoadingScreen,
  showUnitPanel,
  hideUnitPanel,
  renderHeroBar,
  initExternalLibs,
  updateResource,
  updateBadges,
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
import { startMcpStatusPolling } from './ui/mcpStatus.ts';
import { maybeStartFirstRunTour } from './ui/firstRunTour.ts';
import { refreshCityList } from './ui/constructionPanel.ts';
import { wireHUD, selectHero } from './ui/hudWiring.ts';
import { initHudMode } from './ui/hudMode.ts';
import { initCommandPalette } from './ui/commandPalette.ts';
import { registerHudCommands } from './ui/hudWiring/commands.ts';
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
import { mountHermesStatusBanner } from './ui/hermesStatusBanner.ts';
import { axialToPixel } from './hex.ts';
import { sharedIdleFinder } from './ui/idleAgentFinder.ts';
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
import { getWonder, ensureWondersLoaded, listIframeWonders } from './wonders/manifest.ts';
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
import { logger } from './logger.ts';

// ─── Lazy 3D debug/capture probes ─────────────────────────────────────────────
// The `are*PropsSettled` and river-stats hooks below live in Three.js-importing
// modules. They are debug/test instrumentation invoked only by the headless
// capture/probe scripts (always in WebGL mode), so we load them lazily to keep
// Three.js out of the eager 2D-canonical bundle.
//
// Contract for callers: these probes are POLL-until-ready. The first call kicks
// off the dynamic import and returns the not-ready sentinel synchronously —
// `false` for the settled-probes and `[]` for getRiverStats (NOTE: an empty
// array here means "probes not loaded yet", not "no rivers"; poll until it goes
// non-empty, like the capture harness does via waitForFunction). Once the import
// resolves, every probe reflects real state. On import failure we log, reset the
// promise, and let the next poll retry (mirrors renderer.ts ensureThreeMap).
type ThreeProbes = {
  areMountainPropsSettled: () => boolean;
  areForestPropsSettled: () => boolean;
  areCityPropsSettled: () => boolean;
  areUnitPropsSettled: () => boolean;
  areResourcePropsSettled: () => boolean;
  computeRiverPaths: (typeof import('./three/Rivers3D.ts'))['computeRiverPaths'];
};
let threeProbes: ThreeProbes | null = null;
let threeProbesPromise: Promise<void> | null = null;
function ensureThreeProbes(): void {
  if (threeProbes || threeProbesPromise) return;
  threeProbesPromise = Promise.all([
    import('./three/MountainProps3D.ts'),
    import('./three/ForestProps3D.ts'),
    import('./three/CityProps3D.ts'),
    import('./three/UnitProps3D.ts'),
    import('./three/ResourceProps3D.ts'),
    import('./three/Rivers3D.ts'),
  ])
    .then(([mountain, forest, city, unit, resource, rivers]) => {
      threeProbes = {
        areMountainPropsSettled: mountain.areMountainPropsSettled,
        areForestPropsSettled: forest.areForestPropsSettled,
        areCityPropsSettled: city.areCityPropsSettled,
        areUnitPropsSettled: unit.areUnitPropsSettled,
        areResourcePropsSettled: resource.areResourcePropsSettled,
        computeRiverPaths: rivers.computeRiverPaths,
      };
    })
    .catch((err) => {
      // Reset so a later poll can retry instead of being wedged forever, and
      // swallow the rejection (no unhandled-rejection toast for a debug hook).
      logger.warn('[RepoCiv] 3D probe modules failed to load — will retry on next poll', err);
      threeProbesPromise = null;
    });
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
const loadSteps = [
  'Escaneando workspace...',
  'Analizando repos...',
  'Construyendo mapa hexagonal...',
  'Pintando texturas de Civilización...',
  'Inicializando bridge al agente principal...',
  'Imperio listo.',
];

type RepoCivDebugApi = {
  getMacroCityScreenPositions: () => Array<{ cityId: string; x: number; y: number }>;
  openLocalView: (cityId: string) => boolean;
  isTerrainAtlasReady: () => boolean;
  areMountainPropsSettled: () => boolean;
  areForestPropsSettled: () => boolean;
  areCityPropsSettled: () => boolean;
  areUnitPropsSettled: () => boolean;
  areResourcePropsSettled: () => boolean;
  getGlobalUnits: () => Array<{
    id: string;
    type: string;
    state: string;
    coord: { q: number; r: number };
    x: number;
    y: number;
  }>;
  getWebGLMetrics: () => { frameTimeAvg: number; frameCount: number; dirtyRatePct: number } | null;
  getShadowDebug: () => {
    shadowMapEnabled: boolean;
    sunCastShadow: boolean;
    sunShadowMapAllocated: boolean;
    casters: number;
    receivers: number;
  } | null;
  getTileStats: () => {
    total: number;
    revealed: number;
    byTerrain: Record<string, number>;
    samplePos: Record<string, { x: number; y: number }>;
    resourceTiers: {
      gold8: number; science4: number; production3: number; crystal: number;
      freeGold8: number; freeSci4: number; freeProd3: number; freeAny: number;
    };
    crystalPos: { x: number; y: number } | null;
    cleanSamplePos: Record<string, { x: number; y: number }>;
  };
  /** River layout probe: path lengths + world-space midpoints (camera targets). */
  getRiverStats: () => Array<{
    tiles: number;
    hasMouth: boolean;
    mid: { x: number; z: number };
    mouth: { x: number; z: number } | null;
  }>;
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

  // Mount the Hermes degraded-mode banner (Fase 1 / audit 1.1). Runs
  // its own poll loop; banner stays mounted across scene changes until
  // Hermes comes back or the user dismisses for the session.
  void mountHermesStatusBanner();

  // Hydrate the wonder registry from the bridge (GET /api/wonders) BEFORE
  // world-gen so connected iframe wonders get their map tiles. Non-fatal: on
  // bridge-down it falls back to the native gaceta-only static registry.
  await ensureWondersLoaded();

  const world = await generateWorld();
  // `?reveal=all` lifts fog of war for capture/audit sessions: the golden
  // macro cameras (05/06) need every biome visible — without it, low-zoom
  // shots are mostly fog cover and texture changes go unverified.
  if (new URLSearchParams(window.location.search).get('reveal') === 'all') {
    for (const tile of world.tiles.values()) {
      tile.revealed = true;
      tile.inFog = false;
    }
  }
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

  // A Maravilla was connected/disconnected (capitalPanel) → reconcile the live
  // world so its tile/structure appears (or disappears) on the map immediately,
  // without a full reload. Also kick off its auto-start so the iframe is ready.
  window.addEventListener('repociv:wonders-changed', (e: Event) => {
    void (async () => {
      await ensureWondersLoaded();
      if (syncWorldWonders(state.world)) {
        state.notifyUpdate();
      }
      const connectedId = (e as CustomEvent).detail?.connectedId as string | undefined;
      if (connectedId && isAutoStartWondersEnabled()) {
        ensureWondersUp([connectedId], { timeoutMs: 60_000, intervalMs: 1_500 });
      }
    })();
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

  // Initial badges: task count + idle agent count
  const initialIdle = state.getAllUnits().filter((u) => u.state === 'idle').length;
  const initialTasks = Array.from(state.missions.values()).filter((m) => m.status === 'running').length;
  updateBadges(initialTasks, initialIdle);
  // Refresh badges periodically (catches agent state changes)
  setInterval(() => {
    const idle = state.getAllUnits().filter((u) => u.state === 'idle').length;
    const tasks = Array.from(state.missions.values()).filter((m) => m.status === 'running').length;
    updateBadges(tasks, idle);
  }, 3000);

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
    // Settled (ready OR failed): capture scripts wait on this so a golden
    // never races the async mountain-glb load.
    areMountainPropsSettled: () => {
      ensureThreeProbes();
      return threeProbes?.areMountainPropsSettled() ?? false;
    },
    areForestPropsSettled: () => {
      ensureThreeProbes();
      return threeProbes?.areForestPropsSettled() ?? false;
    },
    areCityPropsSettled: () => {
      ensureThreeProbes();
      return threeProbes?.areCityPropsSettled() ?? false;
    },
    areUnitPropsSettled: () => {
      ensureThreeProbes();
      return threeProbes?.areUnitPropsSettled() ?? false;
    },
    areResourcePropsSettled: () => {
      ensureThreeProbes();
      return threeProbes?.areResourcePropsSettled() ?? false;
    },
    getWebGLMetrics: () => renderer.getWebGLMetrics(),
    getShadowDebug: () => renderer.getShadowDebug(),
    getGlobalUnits: () =>
      state.world.units.map((u) => {
        const p = axialToPixel(u.coord, HEX_SIZE);
        return {
          id: u.id,
          type: u.type,
          state: u.state,
          coord: u.coord,
          x: Math.round(p.x),
          y: Math.round(p.y),
        };
      }),
    getTileStats: () => {
      const byTerrain: Record<string, number> = {};
      const samplePos: Record<string, { x: number; y: number }> = {};
      // "Clean" samples: no city/district plate on the tile, and every
      // neighbor shares the terrain — used by tone-instrumentation probes
      // that need an uncontaminated top-face pixel patch per biome.
      const cleanSamplePos: Record<string, { x: number; y: number }> = {};
      const cleanFallback: Record<string, { x: number; y: number }> = {};
      const dirs: Array<[number, number]> = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
      let revealed = 0;
      const resourceTiers = {
        gold8: 0, science4: 0, production3: 0, crystal: 0,
        freeGold8: 0, freeSci4: 0, freeProd3: 0, freeAny: 0,
      };
      let crystalPos: { x: number; y: number } | null = null;
      for (const t of state.world.tiles.values()) {
        byTerrain[t.terrain] = (byTerrain[t.terrain] ?? 0) + 1;
        if (t.revealed) revealed++;
        if (t.resources.gold >= 8) resourceTiers.gold8++;
        if (t.resources.science >= 4) resourceTiers.science4++;
        if (t.resources.production >= 3) resourceTiers.production3++;
        if (t.resources.gold >= 8 && t.resources.science >= 4) resourceTiers.crystal++;
        if (!t.city && !t.district) {
          if (t.resources.gold >= 8) resourceTiers.freeGold8++;
          if (t.resources.science >= 4) resourceTiers.freeSci4++;
          if (t.resources.production >= 3) resourceTiers.freeProd3++;
          if (t.resources.gold >= 8 || t.resources.science >= 4 || t.resources.production >= 3) {
            resourceTiers.freeAny++;
            if (!crystalPos) {
              const p = axialToPixel(t.coord, HEX_SIZE);
              crystalPos = { x: Math.round(p.x), y: Math.round(p.y) };
            }
          }
        }
        if (!samplePos[t.terrain]) {
          const p = axialToPixel(t.coord, HEX_SIZE);
          samplePos[t.terrain] = { x: Math.round(p.x), y: Math.round(p.y) };
        }
        if (!t.city && !t.district) {
          const p = axialToPixel(t.coord, HEX_SIZE);
          if (!cleanFallback[t.terrain]) {
            cleanFallback[t.terrain] = { x: Math.round(p.x), y: Math.round(p.y) };
          }
          if (!cleanSamplePos[t.terrain]) {
            const allSame = dirs.every((d) => {
              const n = state.world.tiles.get(tileKey({ q: t.coord.q + d[0], r: t.coord.r + d[1] }));
              return n !== undefined && n.terrain === t.terrain && !n.city && !n.district;
            });
            if (allSame) {
              cleanSamplePos[t.terrain] = { x: Math.round(p.x), y: Math.round(p.y) };
            }
          }
        }
      }
      for (const terrain of Object.keys(byTerrain)) {
        if (!cleanSamplePos[terrain] && cleanFallback[terrain]) {
          cleanSamplePos[terrain] = cleanFallback[terrain];
        }
      }
      return { total: state.world.tiles.size, revealed, byTerrain, samplePos, cleanSamplePos, resourceTiers, crystalPos };
    },
    getRiverStats: () => {
      ensureThreeProbes();
      const paths = threeProbes?.computeRiverPaths(state.world.tiles) ?? [];
      return paths.map((p) => {
        const mid = p.points[Math.floor(p.points.length / 2)]!;
        return {
          tiles: p.points.length,
          hasMouth: p.mouth !== null,
          mid: { x: Math.round(mid.x), z: Math.round(mid.z) },
          mouth: p.mouth ? { x: Math.round(p.mouth.x), z: Math.round(p.mouth.z) } : null,
        };
      });
    },
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

  // ─── Idle agent finder (Age of Empires pattern) ─────────────────────
  // Uses the shared singleton so the cycle index stays in sync with the
  // `,` keyboard hotkey wired in hudWiring/hotkeys.ts.
  const findIdleAgent = () => {
    // Disable in local view
    if (document.body.classList.contains('local-view')) return;
    const units = state.getAllUnits();
    const idle = sharedIdleFinder.nextIdle(units);
    const btn = document.getElementById('btn-idle-agent');
    if (!idle) {
      // Flash red briefly
      if (btn) {
        btn.style.borderColor = '#c04040';
        btn.style.color = '#c04040';
        setTimeout(() => {
          btn.style.borderColor = '';
          btn.style.color = '';
        }, 600);
      }
      return;
    }
    renderer.focusOnCoord(idle.coord);
    renderer.flashIdleHighlight(idle.coord);
  };
  document.getElementById('btn-idle-agent')?.addEventListener('click', findIdleAgent);
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
    if (isHarnessPanelOpen()) {
      startHarnessPolling();
      trackPanelOpen('harness');
    }
  });

  const bridge = new BridgeEvents(state);
  bridge.rendererRef = renderer;
  bridge.start();
  startApprovalPolling();
  startMcpStatusPolling();
  setWebGLMetricsSource(() => renderer.getWebGLMetrics());
  startObservabilityPolling();
  startHarnessPolling();

  // First-run coachmark tour (plan B2): teach the core loop once. Delayed so
  // the canvas/HUD have settled and any onboarding panel has resolved.
  setTimeout(() => maybeStartFirstRunTour(), 1800);

  // ══ Wonder auto-start ══
  // Fire-and-forget: launch + poll every CONNECTED iframe wonder (whatever the
  // user wrote to ~/.repociv/wonders/, hydrated above) that isn't explicitly
  // disabled. Out-of-the-box this is empty — nothing is pre-installed; the user
  // connects wonders from the Maravillas guide. Default ON, disable via
  // localStorage key 'repociv:auto-start-wonders' = 'false'.
  if (isAutoStartWondersEnabled()) {
    const autoStartIds = listIframeWonders()
      .filter((m) => m.defaultEnabled !== false)
      .map((m) => m.id);
    if (autoStartIds.length > 0) {
      ensureWondersUp(autoStartIds, { timeoutMs: 60_000, intervalMs: 1_500 });
      logEvent(`⚙️ Levantando maravillas (auto-start): ${autoStartIds.join(', ')}…`, 'info');
    }
  } else {
    logEvent('Auto-arranque de maravillas desactivado (localStorage).', 'info');
  }

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
    const unit = getFirstUserUnit(state);
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
              agentId: String(draft.payload?.['unit'] ?? DEFAULT_USER_UNIT_ID),
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
        : (getFirstUserUnit(state));
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
  // P4: Drag-to-assign — reuse queueLocalMission for the drag flow
  renderer.localDragAssignCb = (unitId, tile) => {
    const wb = tile.workbench;
    if (!wb) return;
    const localWorld = state.localWorld;
    const repoId = localWorld?.repoId ?? wb.repoPath;
    state.queueLocalMission(repoId, wb.filePath, wb.fileName, unitId);
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

  // Spawn MAIN as the default hero, near the capital if present.
  // MAIN's runtime identity is configured by the onboarding step (PR 2):
  // the user picks a harness, and the bridge routes MAIN through it.
  const spawnAt = capital ? capital.coord : { q: 0, r: 0 };
  state.spawnUnit(DEFAULT_USER_UNIT_ID, DEFAULT_USER_UNIT_NAME, 'hero', 'gris', spawnAt, 'En espera de misión');

  wireHUD(renderer, state, bridge, toggleView);
  initHudMode();
  initCommandPalette();
  registerHudCommands(state, renderer, bridge, toggleView);

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
