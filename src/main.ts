// ─── RepoCiv — Main Entry Point ───────────────────────────────────────────────

import './styles.css';
import { generateWorld } from './map.ts';
import { Renderer } from './renderer.ts';
import { BridgeEvents } from './bridge.ts';
import { GameState } from './game.ts';
import {
  showLoadingProgress, hideLoadingScreen, showUnitPanel, hideUnitPanel,
  renderHeroBar, openSidePanel, closeSidePanel, isSidePanelOpen,
  appendUserMessage, wireSideTabs, loadGitInfo, loadFilesInfo,
  openQuestBoard, closeQuestBoard, isQuestBoardOpen,
  wireQuestBoardTabs, fetchPersistedMissions, fetchPendingTracker, renderQuestBoard,
  toggleKeyboardHelp,
} from './ui.ts';
import type { Unit } from './types.ts';

// ─── Bootstrap ───────────────────────────────────────────────────────────────
const loadSteps = [
  'Escaneando workspace...',
  'Analizando repos...',
  'Construyendo mapa hexagonal...',
  'Inicializando bridge a DAVI...',
  'Imperio listo.',
];

async function bootstrap() {
  for (let i = 0; i < loadSteps.length; i++) {
    showLoadingProgress((i / loadSteps.length) * 100, loadSteps[i]!);
    await new Promise(r => setTimeout(r, 200));
  }

  const world = await generateWorld();
  const state = new GameState(world);
  state.start();

  // Initial resources from world
  const setRes = (id: string, value: number) => {
    const el = document.querySelector<HTMLElement>(`#res-${id} .res-value`);
    if (el) el.textContent = value.toLocaleString();
  };
  setRes('gold', world.resources.gold);
  setRes('science', world.resources.science);
  setRes('production', world.resources.production);

  const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
  const renderer = new Renderer(canvas, state);
  renderer.start();

  const bridge = new BridgeEvents(state);
  bridge.start();

  // Canvas click → select unit / open city panels
  renderer.onUnitSelect = (unit) => {
    if (unit) selectHero(unit, renderer, state, bridge);
    else { hideUnitPanel(); closeSidePanel(); }
  };
  renderer.onCitySelect = (cityId) => {
    loadGitInfo(cityId);
    loadFilesInfo(cityId);
    if (state.selectedUnit) openSidePanel(state.selectedUnit);
  };

  renderer.onTileInspect = (cityName, coord, repoPath) => {
    bridge.send('tile_inspected', { cityName, coord, repoPath });
  };

  // Spawn DAVI as the default hero, near the capital if present
  const capital = world.cities.find(c => c.isCapital) ?? world.cities[0];
  const spawnAt = capital ? capital.coord : { q: 0, r: 0 };
  state.spawnUnit('DAVI', 'DAVI', 'hero', 'gris', spawnAt, 'En espera de misión');

  wireHUD(renderer, state, bridge);

  // Load pending tracker missions at boot
  fetchPendingTracker().then(pending => {
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

  hideLoadingScreen();
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
    const cityHere = state.world.cities.find(c =>
      c.coord.q === unit.coord.q && c.coord.r === unit.coord.r,
    );
    if (cityHere) {
      loadGitInfo(cityHere.id);
      loadFilesInfo(cityHere.id);
    }
  }
}

// ─── HUD wiring ───────────────────────────────────────────────────────────────
function wireHUD(renderer: Renderer, state: GameState, bridge: BridgeEvents) {
  const missionInput = document.getElementById('mission-input') as HTMLInputElement;

  // ─── Hotkeys ────────────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

    // Esc: close overlays
    if (e.key === 'Escape') {
      if (isQuestBoardOpen()) { closeQuestBoard(); return; }
      const help = document.getElementById('keyboard-help');
      if (help && !help.classList.contains('hidden')) { toggleKeyboardHelp(false); return; }
      if (isSidePanelOpen()) { closeSidePanel(); return; }
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
      const heroes = state.getAllUnits().filter(u => u.state === 'idle');
      if (heroes.length === 0) return;
      const cur = state.selectedUnit;
      const idx = cur ? heroes.findIndex(h => h.id === cur.id) : -1;
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
      const idx = cur ? heroes.findIndex(h => h.id === cur.id) : -1;
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
      case 'm': renderer.setActionMode('move'); break;
      case 's': renderer.sleepSelectedUnit(); break;
      case 'b': renderer.setActionMode('build'); break;
      case 'g': renderer.toggleGrid(); break;
      case 'f': renderer.toggleDebug(); break;
      case 'v': renderer.toggleFog(); break;
      case '?': toggleKeyboardHelp(); break;
    }

    if (e.key === 'F9') {
      e.preventDefault();
      if (isQuestBoardOpen()) closeQuestBoard();
      else (async () => {
        const persisted = await fetchPersistedMissions();
        openQuestBoard(state);
        renderQuestBoard(state, persisted);
      })();
    }

    if (e.key === 'F12') {
      e.preventDefault();
      takeScreenshot(renderer);
    }
  });

  // ─── Spawn buttons (Q/W/E/L) ────────────────────────────────────────────
  document.querySelectorAll<HTMLButtonElement>('.spawn-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset['type'] as string;
      spawnAgent(type, state, renderer, bridge);
    });
  });

  // ─── Screenshot button ───────────────────────────────────────────────────
  document.getElementById('btn-screenshot')?.addEventListener('click', () => takeScreenshot(renderer));

  // ─── Minimap ────────────────────────────────────────────────────────────
  const minimap = document.getElementById('minimap-canvas') as HTMLCanvasElement;
  minimap?.addEventListener('click', (e) => {
    const rect = minimap.getBoundingClientRect();
    renderer.minimapClick(e.clientX - rect.left, e.clientY - rect.top);
  });

  // ─── Mission input ──────────────────────────────────────────────────────
  const sendMission = () => {
    const unit = state.selectedUnit;
    if (!unit || !missionInput.value.trim()) return;
    const cityHere = state.world.cities.find(c =>
      c.territory.some(t => t.q === unit.coord.q && t.r === unit.coord.r),
    ) ?? state.world.cities[0];

    const text = missionInput.value.trim();
    if (!isSidePanelOpen()) openSidePanel(unit);
    appendUserMessage(unit.id, text);

    bridge.send('unit_command', {
      unit: unit.id,
      city: cityHere?.id ?? 'main',
      mission: text,
      agentType: unit.type,
    });
    state.setUnitState(unit.id, 'working');
    missionInput.value = '';
  };

  document.getElementById('btn-send-mission')?.addEventListener('click', sendMission);
  missionInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.stopPropagation(); sendMission(); }
  });

  // ─── Side panel close ────────────────────────────────────────────────────
  document.getElementById('side-panel-close')?.addEventListener('click', () => closeSidePanel());

  // ─── Side panel tabs ─────────────────────────────────────────────────────
  wireSideTabs((tab) => {
    const unit = state.selectedUnit;
    if (!unit) return;
    const cityHere = state.world.cities.find(c =>
      c.territory.some(t => t.q === unit.coord.q && t.r === unit.coord.r),
    );
    if (tab === 'git' && cityHere)   loadGitInfo(cityHere.id);
    if (tab === 'files' && cityHere) loadFilesInfo(cityHere.id);
  });

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
  const capital = state.world.cities.find(c => c.isCapital) ?? state.world.cities[0];
  const existingCount = state.getAllUnits().filter(u => u.id.startsWith(base)).length;
  const offset = existingCount % 6;
  const coord = capital
    ? { q: capital.coord.q + 1 + (offset % 3), r: capital.coord.r - Math.floor(offset / 3) }
    : { q: 1 + offset, r: 0 };

  const typeMap: Record<string, 'hero' | 'worker' | 'scout' | 'lexo'> = {
    DAVI: 'hero', WORKER: 'worker', SCOUT: 'scout', LEXO: 'lexo',
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
