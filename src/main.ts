// ─── RepoCiv — Main Entry Point ───────────────────────────────────────────────

import './styles/index.css';
import { generateWorld, reconnectCities, removeCityFromWorld, syncWorldWonders } from './map.ts';
import { Renderer } from './renderer.ts';
import { BridgeEvents } from './bridge.ts';
import { ensureWondersUp, isAutoStartWondersEnabled } from './wonders/wonderLauncher.ts';
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
  initExternalLibs,
  updateResource,
  updateBadges,
  toggleApprovalPanel,
  startApprovalPolling,
  toggleHarnessPanel,
  startHarnessPolling,
  toggleTaskPanel,
  toggleKanbanPanel,
  initRoundtabletPanel,
  togglePendingPanel,
  toggleLogPanel,
  isHarnessPanelOpen,
  fetchPendingTracker,
} from './ui/index.ts';
import { mountGacetaWidget } from './ui/gacetaWidget.ts';
import { startMcpStatusPolling } from './ui/mcpStatus.ts';
import { maybeStartFirstRunTour } from './ui/firstRunTour.ts';
import { refreshCityList } from './ui/constructionPanel.ts';
import { wireHUD, selectHero } from './ui/hudWiring.ts';
import { nextSessionUnitId, spawnAcceptedSession } from './ui/hudWiring/spawn.ts';
import { buildAgentSessionCommand, buildHerdrLaunchCommand } from './ui/agentSessionStart.ts';
import { bindChatAgentLocator } from './ui/chat/panel.ts';
import { agentLocation } from './ui/agentLocation.ts';
import {
  externalSessionSnapshot,
  subscribeExternalSessionDirectory,
} from './ui/externalSessionDirectory.ts';
import { bindAgentAttentionStrip } from './ui/agentAttentionStrip.ts';
import {
  bindAgentsPanel,
  focusOwnChat,
  openExternalAgentChat,
  toggleAgentsPanel,
} from './ui/agentsPanel.ts';
import { bindApprovalPanel } from './ui/approvalPanel.ts';
import { isExternalAgentUnit } from './externalAgents.ts';
import { initHudMode } from './ui/hudMode.ts';
import { initHudWindows, mountHudWindow } from './ui/hudWindow.ts';
import { initUnitPanelDock } from './ui/unitPanelDock.ts';
import { initCommandPalette } from './ui/commandPalette.ts';
import { registerHudCommands } from './ui/hudWiring/commands.ts';
import { wireSelection } from './ui/hudWiring/selection.ts';
import { wireCityEvents } from './ui/hudWiring/cityEvents.ts';
import { wireLocalView } from './ui/hudWiring/localView.ts';
import { showDirectivePreview, showContextMenu, showDragTooltip } from './ui/spatialPreview.ts';
import { sendCommand } from './commandBus.ts';
import { tileInspectedCommand } from './commandDrafts.ts';
import { recordGesture } from './directiveLearner.ts';
import { tileKey } from './types.ts';
import { clearChat } from './ui/chat.ts';
import { openOnboardingPanel } from './ui/onboardingPanel.ts';
import { mountHermesStatusBanner } from './ui/hermesStatusBanner.ts';
import { axialToPixel } from './hex.ts';
import { sharedIdleFinder } from './ui/idleAgentFinder.ts';
import { setRendererRef, notifyTilePicked, setOnCityDeletedCb } from './ui/constructionPanel.ts';

import { getStoredEraLabel } from './ui/eraSystem.ts';
import { logEvent } from './ui/hud.ts';
import { trackPanelOpen } from './ui/analytics.ts';
import { initBubbleLayer } from './ui/actionBubbles.ts';
import { bindOrdenDeBatalla } from './ui/ordenDeBatalla.ts';
import { bindSubagentSessionPanel } from './ui/subagentSessionPanel.ts';
import { bindSlashCommandState } from './ui/chat/slashCommands.ts';
import { ensureWondersLoaded, listIframeWonders } from './wonders/manifest.ts';
import type { City } from './types.ts';
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
  getUnitRoleSources: () => Record<string, string | undefined>;
  areResourcePropsSettled: () => boolean;
  isTerrainScatterSettled: () => boolean;
  areWonderPropsSettled: () => boolean;
  getWonderProps: (typeof import('./three/WonderProps3D.ts'))['wonderPropsDebug'];
  unitWalkDebug: (typeof import('./three/UnitMesh3D.ts'))['unitWalkDebug'];
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
    import('./three/TerrainScatter3D.ts'),
    import('./three/WonderProps3D.ts'),
    import('./three/Rivers3D.ts'),
    import('./three/UnitMesh3D.ts'),
  ])
    .then(([mountain, forest, city, unit, resource, scatter, wonder, rivers, unitMesh]) => {
      threeProbes = {
        areMountainPropsSettled: mountain.areMountainPropsSettled,
        areForestPropsSettled: forest.areForestPropsSettled,
        areCityPropsSettled: city.areCityPropsSettled,
        areUnitPropsSettled: unit.areUnitPropsSettled,
        getUnitRoleSources: () =>
          Object.fromEntries(unit.UNIT_ROLE_GLB_IDS.map((id) => [id, unit.getUnitRoleSource(id)])),
        areResourcePropsSettled: resource.areResourcePropsSettled,
        isTerrainScatterSettled: scatter.isTerrainScatterSettled,
        areWonderPropsSettled: wonder.areWonderPropsSettled,
        getWonderProps: wonder.wonderPropsDebug,
        unitWalkDebug: unitMesh.unitWalkDebug,
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
  getUnitRoleSources: () => Record<string, string | undefined>;
  areResourcePropsSettled: () => boolean;
  isTerrainScatterSettled: () => boolean;
  areWonderPropsSettled: () => boolean;
  getWonderProps: () => Array<Record<string, unknown>> | null;
  getUnitWalkDebug: () => ReturnType<(typeof import('./three/UnitMesh3D.ts'))['unitWalkDebug']>;
  walkUnit: (id: string, q: number, r: number) => boolean;
  getGlobalUnits: () => Array<{
    id: string;
    type: string;
    state: string;
    coord: { q: number; r: number };
    x: number;
    y: number;
  }>;
  getWebGLMetrics: () => { frameTimeAvg: number; frameCount: number; dirtyRatePct: number } | null;
  getCamera: () => { x: number; y: number; zoom: number; yaw: number; pitch: number };
  setPostFxEnabled: (enabled: boolean) => void;
  isPostFxEnabled: () => boolean;
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
      gold8: number;
      science4: number;
      production3: number;
      crystal: number;
      freeGold8: number;
      freeSci4: number;
      freeProd3: number;
      freeAny: number;
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
    // A browser notice, not a failure: the notification arrives a frame later.
    if (typeof msg === 'string' && msg.startsWith('ResizeObserver loop')) return;
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

  // HUD overlays can be rearranged locally without affecting game state.
  initHudWindows();

  // The hero card docks into the side panel's "Unidad" tab while the panel is
  // open, so selection + chat never produce two windows.
  initUnitPanelDock();

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

  // Set up the dynamic city-delete callback from constructionPanel. City ADD
  // goes through renderer.foundRepoCity (constructionPanel.placePickedCity).
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
  const initialTasks = Array.from(state.missions.values()).filter(
    (m) => m.status === 'running',
  ).length;
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
    getUnitRoleSources: () => {
      ensureThreeProbes();
      return threeProbes?.getUnitRoleSources() ?? {};
    },
    areResourcePropsSettled: () => {
      ensureThreeProbes();
      return threeProbes?.areResourcePropsSettled() ?? false;
    },
    isTerrainScatterSettled: () => {
      ensureThreeProbes();
      return threeProbes?.isTerrainScatterSettled() ?? false;
    },
    areWonderPropsSettled: () => {
      ensureThreeProbes();
      return threeProbes?.areWonderPropsSettled() ?? false;
    },
    getWonderProps: () => {
      ensureThreeProbes();
      return threeProbes?.getWonderProps() ?? null;
    },
    getUnitWalkDebug: () => {
      ensureThreeProbes();
      return threeProbes?.unitWalkDebug?.() ?? [];
    },
    walkUnit: (id: string, q: number, r: number) => state.walkUnitTo(id, { q, r }),
    getWebGLMetrics: () => renderer.getWebGLMetrics(),
    getCamera: () => renderer.getCamera(),
    setPostFxEnabled: (enabled: boolean) => renderer.setPostFxEnabled(enabled),
    isPostFxEnabled: () => renderer.isPostFxEnabled(),
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
      const dirs: Array<[number, number]> = [
        [1, 0],
        [1, -1],
        [0, -1],
        [-1, 0],
        [-1, 1],
        [0, 1],
      ];
      let revealed = 0;
      const resourceTiers = {
        gold8: 0,
        science4: 0,
        production3: 0,
        crystal: 0,
        freeGold8: 0,
        freeSci4: 0,
        freeProd3: 0,
        freeAny: 0,
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
              const n = state.world.tiles.get(
                tileKey({ q: t.coord.q + d[0], r: t.coord.r + d[1] }),
              );
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
      return {
        total: state.world.tiles.size,
        revealed,
        byTerrain,
        samplePos,
        cleanSamplePos,
        resourceTiers,
        crystalPos,
      };
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
      window.dispatchEvent(
        new CustomEvent('repociv:open-local-view-request', { detail: { cityId } }),
      );
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
  document.getElementById('btn-approvals')?.addEventListener('click', toggleApprovalPanel);
  document.getElementById('btn-tasks')?.addEventListener('click', toggleTaskPanel);
  document.getElementById('btn-kanban')?.addEventListener('click', toggleKanbanPanel);

  // ─── RoundTablet — Bot Mode panel ───────────────────────────────────────
  // La ventana se monta como hud-window (drag/resize/persistencia) y el botón
  // vive en el minimap-button-strip junto a los demás toggles de paneles.
  // La ronda se hospeda en la ciudad de la unidad seleccionada (o la primera
  // con repo real): los harnesses CLI necesitan un working_dir de repo.
  const rtPanel = initRoundtabletPanel(document.body, () => {
    const unitCity = state.world.cities.find((c) => c.id === state.selectedUnit?.cityId);
    const host =
      (unitCity?.repoPath?.trim() ? unitCity : null) ??
      state.world.cities.find((c) => c.repoPath?.trim());
    return { cityId: host?.id ?? '', repoPath: host?.repoPath ?? '' };
  });
  mountHudWindow(rtPanel.element);
  document.getElementById('btn-roundtablet')?.addEventListener('click', () => rtPanel.toggle());

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
  document.getElementById('btn-agents')?.addEventListener('click', toggleAgentsPanel);
  document.getElementById('btn-wb-labels')?.addEventListener('click', () => {
    const active = renderer.toggleWorkbenchLabels();
    const btn = document.getElementById('btn-wb-labels');
    if (btn) {
      btn.classList.toggle('active', active);
      btn.title = active ? 'Ocultar etiquetas de archivos [T]' : 'Etiquetas de archivos [T]';
    }
  });
  document.getElementById('btn-task-assign')?.addEventListener('click', () => {
    void import('./ui/taskAssignPanel.ts').then((m) =>
      m.toggleTaskAssignPanel(
        () => state.getLocalUnits(),
        (unitId, task) => {
          if (task !== null) state.setLocalUnitTask(unitId, task);
        },
      ),
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
    'btn-tasks': 'tasks',
    'btn-kanban': 'kanban',
    'btn-pending': 'pending',
    'btn-log': 'log',
    'btn-agents': 'agents',
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

  function _enterLocalViewForCity(city: City): void {
    // No bridge command here. Entering a sector is a view change, not an intent
    // the executor acts on: `enter_local` is not in CommandType and carries no
    // `target`, so every entry fired a rejected command and surfaced
    // "WS command rejected: Missing required fields: {'target'}" to the user.
    // The local world is built client-side from GET /api/files/<repoId>.
    state.enterLocalView(city.id).catch(() => state.enterLocalViewMock(city.id));
    initBubbleLayer();
    // Any wonder that is open follows us into the local view.
    void import('./ui/wonderVignette.ts').then((m) => m.pushContextToOpenWonder('local'));
  }

  wireSelection({ renderer, state, bridge });
  wireCityEvents({
    renderer,
    state,
    enterLocalViewForCity: _enterLocalViewForCity,
    getFirstUserUnit,
  });

  renderer.onTileInspect = (cityName, coord, repoPath) => {
    void sendCommand(tileInspectedCommand(cityName, coord, repoPath));
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

  wireLocalView({
    renderer,
    state,
    bridge,
    enterLocalViewForCity: _enterLocalViewForCity,
    getFirstUserUnit,
    showToast,
  });

  // Spawn MAIN as the default hero, near the capital if present.
  // MAIN's runtime identity is configured by the onboarding step (PR 2):
  // the user picks a harness, and the bridge routes MAIN through it.
  const spawnAt = capital ? capital.coord : { q: 0, r: 0 };
  state.spawnUnit(
    DEFAULT_USER_UNIT_ID,
    DEFAULT_USER_UNIT_NAME,
    'hero',
    'gris',
    spawnAt,
    'En espera de misión',
  );

  wireHUD(renderer, state, bridge, toggleView);
  initHudMode();
  initCommandPalette();
  registerHudCommands(state, renderer, bridge, toggleView);

  // Profile editing is opened intentionally from the canonical F8 session list.

  // Load pending tracker missions at boot
  fetchPendingTracker().then((pending) => {
    for (const m of pending) {
      if (!state.missions.has(m.id)) state.missions.set(m.id, m);
    }
  });

  const locateAgent = (coord: { q: number; r: number }) => {
    state.enterMacroView();
    renderer.focusOnCoord(coord);
    renderer.flashIdleHighlight(coord);
  };
  bindChatAgentLocator((unitId) => {
    const unit = state.getUnit(unitId);
    if (unit) locateAgent(agentLocation(unit, state.world.cities));
  });
  // "Ir al chat" on approval items: resolve the ref (unit id or session id)
  // against the existing stores and reuse the session navigation flows.
  bindApprovalPanel({
    gotoChat: (ref) => {
      if (!ref) return false;
      const unit = state.getUnit(ref);
      if (unit) {
        locateAgent(agentLocation(unit, state.world.cities));
        if (isExternalAgentUnit(unit.id)) openExternalAgentChat(unit.id);
        else focusOwnChat(unit.id);
        return true;
      }
      const row = externalSessionSnapshot()?.find(
        (r) => r.sessionId === ref || r.unit === ref || r.agent === ref,
      );
      if (row) {
        openExternalAgentChat(row.sessionId);
        const extUnit = row.unit ? state.getUnit(row.unit) : undefined;
        if (extUnit) locateAgent(agentLocation(extUnit, state.world.cities));
        return true;
      }
      return false;
    },
  });
  bindAgentsPanel({
    state,
    locate: locateAgent,
    selectOwnUnit: (u) => selectHero(u, renderer, state, bridge),
    startHerdrSession: async (draft) => {
      const city = state.world.cities.find((candidate) => candidate.id === draft.cityId);
      if (!city || city.isCapital || !city.repoPath) {
        return {
          ok: false,
          status: 'rejected',
          commandId: '',
          reason: 'La ciudad ya no está disponible para una sesión.',
        };
      }
      return sendCommand(buildHerdrLaunchCommand(draft));
    },
    startSession: async ({ profile, cityId, mission }) => {
      const city = state.world.cities.find((candidate) => candidate.id === cityId);
      if (!city || city.isCapital || !city.repoPath) {
        return { ok: false, reason: 'La ciudad ya no está disponible para una sesión.' };
      }
      const unitId = nextSessionUnitId(profile, state);
      const response = await sendCommand(
        buildAgentSessionCommand({ unitId, profile, cityId, mission }),
      );
      if (!response.ok) {
        return { ok: false, reason: response.reason ?? 'El bridge rechazó la sesión.' };
      }
      spawnAcceptedSession(profile, city, mission, unitId, state, renderer, bridge);
      return { ok: true, unitId };
    },
  });

  bindAgentAttentionStrip(state);

  // Keep the unit panel in sync with state; external (Suvadu ext-*) selection
  // routes to the Agents panel instead of the mission composer.
  let extSelected: string | null = null;
  const syncSelection = () => {
    const selected = state.selectedUnit;
    if (selected && isExternalAgentUnit(selected.id)) {
      if (extSelected !== selected.id) {
        extSelected = selected.id;
        openExternalAgentChat(selected.id);
      }
      return;
    }
    extSelected = null;
    if (selected) showUnitPanel(selected, state);
  };
  state.subscribe(syncSelection);
  subscribeExternalSessionDirectory(() => syncSelection());
  bindOrdenDeBatalla(state);
  bindSubagentSessionPanel(state);
  bindSlashCommandState(state);

  // Readiness contract for e2e/scripts: every HUD listener is wired by now.
  // The loading screen hides much earlier (before the HUD wiring), so it
  // cannot gate interactions — clicking a HUD button before this point is a
  // silent no-op on a loaded machine.
  document.documentElement.dataset.appReady = '1';
}

// ─── Start ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', bootstrap);

// ─── Post-load era display sync ─────────────────────────────────────────────
const eraEl = document.getElementById('era-display');
if (eraEl) eraEl.textContent = getStoredEraLabel();
