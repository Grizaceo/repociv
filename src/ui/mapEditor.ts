// ─── RepoCiv — Map editor ───────────────────────────────────────────────────
//
// One mode for the whole map surface, replacing the one-off "✥ move city"
// button of the construction panel. The toolbar floats over the map so the
// user keeps seeing (and clicking) the hexes while editing.
//
// Tools: move a city, paint terrain, align a city to a nation, place a repo
// by hand, erase a hex (or take a city off the map). Every edit is persisted
// in localStorage by the stores in `mapEdits.ts` / `nations.ts`, so the map
// survives a reload.

import { type Renderer } from '../renderer.ts';
import { type GameState } from '../game.ts';
import { fetchScannedRepos, TERRAIN_COLOR, type ScannedRepo } from '../map.ts';
import { PAINTABLE_TERRAINS, TERRAIN_LABELS } from '../mapEdits.ts';
import { getNationStore } from '../nations.ts';
import type { MapEditorTool, Terrain } from '../types.ts';

interface ToolDef {
  id: MapEditorTool;
  label: string;
  icon: string;
  hint: string;
}

const TOOLS: ToolDef[] = [
  {
    id: 'move',
    label: 'Mover',
    icon: '✥',
    hint: 'Arrastra una ciudad a otra casilla del mapa.',
  },
  {
    id: 'terrain',
    label: 'Terreno',
    icon: '🖌',
    hint: 'Pinta el terreno: clic y arrastra sobre los hexes.',
  },
  {
    id: 'nation',
    label: 'Nación',
    icon: '⚑',
    hint: 'Clic en una ciudad para alinearla a la nación elegida.',
  },
  {
    id: 'place',
    label: 'Crear',
    icon: '＋',
    hint: 'Elige un repo y haz clic en un hex libre para fundar una ciudad.',
  },
  {
    id: 'erase',
    label: 'Borrar',
    icon: '🗑',
    hint: 'Clic en una ciudad para sacarla del mapa, o en un hex para borrarlo.',
  },
];

const _state = {
  renderer: null as Renderer | null,
  game: null as GameState | null,
  panel: null as HTMLElement | null,
  tool: 'move' as MapEditorTool,
  terrain: 'plains' as Terrain,
  nationId: null as string | null,
  /** Repo picked in the "place" tool, by the same key the renderer uses. */
  repoPath: null as string | null,
  repos: [] as ScannedRepo[],
};

function terrainSwatch(terrain: Terrain): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'map-editor-terrain';
  button.dataset['terrain'] = terrain;
  button.title = TERRAIN_LABELS[terrain] ?? terrain;
  button.setAttribute('aria-label', TERRAIN_LABELS[terrain] ?? terrain);
  button.style.background = TERRAIN_COLOR[terrain]?.fill ?? '#888888';
  if (terrain === _state.terrain) button.classList.add('active');
  button.addEventListener('click', () => {
    _state.terrain = terrain;
    _state.renderer?.setMapEditorTerrain(terrain);
    renderToolbar();
  });
  return button;
}

function buildContext(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'map-editor-context';

  if (_state.tool === 'terrain') {
    for (const terrain of PAINTABLE_TERRAINS) wrap.append(terrainSwatch(terrain));
  }

  if (_state.tool === 'nation') {
    const select = document.createElement('select');
    select.className = 'map-editor-select';
    select.setAttribute('aria-label', 'Nación activa');
    select.append(new Option('Sin nación', ''));
    for (const nation of getNationStore().nations) {
      select.append(new Option(nation.name, nation.id));
    }
    select.value = _state.nationId ?? '';
    select.addEventListener('change', () => {
      _state.nationId = select.value || null;
      _state.renderer?.setMapEditorNation(_state.nationId);
    });
    wrap.append(select);
  }

  if (_state.tool === 'place') {
    const select = document.createElement('select');
    select.className = 'map-editor-select';
    select.setAttribute('aria-label', 'Repo a colocar');
    const mapped = new Set((_state.game?.world.cities ?? []).map((c) => c.repoPath ?? c.id));
    const available = _state.repos.filter((r) => !mapped.has(r.repoPath ?? r.path));
    select.append(new Option('— elige un repo —', ''));
    for (const repo of available) {
      select.append(new Option(repo.name, repo.repoPath ?? repo.path));
    }
    select.value = _state.repoPath ?? '';
    select.addEventListener('change', () => {
      const repo = available.find((r) => (r.repoPath ?? r.path) === select.value) ?? null;
      _state.repoPath = repo ? (repo.repoPath ?? repo.path) : null;
      _state.renderer?.setMapEditorRepo(repo);
    });
    wrap.append(select);
  }

  return wrap;
}

function renderToolbar(): void {
  const panel = _state.panel;
  if (!panel) return;

  const tools = document.createElement('div');
  tools.className = 'map-editor-tools';
  for (const tool of TOOLS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-editor-tool';
    button.dataset['tool'] = tool.id;
    button.title = `${tool.label} — ${tool.hint}`;
    if (tool.id === _state.tool) button.classList.add('active');
    button.append(document.createTextNode(`${tool.icon} ${tool.label}`));
    button.addEventListener('click', () => {
      _state.tool = tool.id;
      _state.renderer?.setMapEditorTool(tool.id);
      renderToolbar();
    });
    tools.append(button);
  }

  const context = buildContext();
  const hint = document.createElement('span');
  hint.className = 'map-editor-hint';
  hint.textContent = TOOLS.find((t) => t.id === _state.tool)?.hint ?? '';

  panel.replaceChildren(tools, context, hint);
}

/**
 * Forget the repo picked in the "place" tool and redraw the bar. Called after
 * a successful placement: a repo is one city, so it must leave the dropdown.
 */
export function clearMapEditorRepoSelection(): void {
  _state.repoPath = null;
  _state.renderer?.setMapEditorRepo(null);
  renderToolbar();
}

/** Open the editor: the toolbar appears and the map switches to edit mode. */
export function openMapEditor(renderer?: Renderer, game?: GameState): void {
  if (renderer) _state.renderer = renderer;
  if (game) _state.game = game;
  if (!_state.renderer) return;

  if (!_state.panel) {
    const panel = document.createElement('div');
    panel.id = 'map-editor';
    panel.className = 'map-editor';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'map-editor-close';
    close.textContent = '✕';
    close.title = 'Cerrar el editor (Esc)';
    close.setAttribute('aria-label', 'Cerrar el editor de mapa');
    close.addEventListener('click', () => closeMapEditor());
    panel.append(close);

    document.body.append(panel);
    _state.panel = panel;
  }

  _state.panel.classList.remove('hidden');
  _state.renderer.setMapEditorMode(true);
  _state.renderer.setMapEditorTool(_state.tool);

  // The repo list powers the "place" tool; it is only needed for that tool.
  void fetchScannedRepos()
    .then((repos) => {
      _state.repos = repos;
      if (_state.tool === 'place') renderToolbar();
    })
    .catch(() => {
      _state.repos = [];
    });

  renderToolbar();
}

/** Close the editor and give the map back to the player. */
export function closeMapEditor(): void {
  _state.panel?.classList.add('hidden');
  _state.renderer?.setMapEditorMode(false);
}

export function isMapEditorOpen(): boolean {
  return _state.panel?.classList.contains('hidden') === false;
}

export function toggleMapEditor(renderer?: Renderer, game?: GameState): void {
  if (isMapEditorOpen()) closeMapEditor();
  else openMapEditor(renderer, game);
}

/** Wire the keyboard shortcut and keep the editor in sync with the renderer. */
export function initMapEditor(renderer: Renderer, game: GameState): void {
  _state.renderer = renderer;
  _state.game = game;

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isMapEditorOpen()) {
      e.preventDefault();
      closeMapEditor();
    }
  });
}
