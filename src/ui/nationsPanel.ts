// ─── RepoCiv — Nations panel (side panel tab) ───────────────────────────────
//
// The editorial layer over the map: create nations, give them a flag colour,
// rename them and decide which city (repo) belongs to which nation. The panel
// never touches the filesystem — it only changes how the map reads.
//
// Built with DOM APIs (no innerHTML interpolation) so the no-unsanitized lint
// gate stays green for new files.

import {
  applyNationsToWorld,
  assignCityToNation,
  cityKey,
  createNation,
  deleteNation,
  getNationStore,
  updateNation,
} from '../nations.ts';
import type { City, Nation, World } from '../types.ts';

interface NationsPanelState {
  world: World | null;
  onChange: (() => void) | null;
}

const _state: NationsPanelState = { world: null, onChange: null };

function container(): HTMLElement | null {
  return document.getElementById('nations-pane');
}

/** Apply a change to the store and repaint the map + the panel. */
function commit(): void {
  if (_state.world) applyNationsToWorld(_state.world);
  _state.onChange?.();
  render();
}

function citiesOf(nationId: string | null, cities: City[]): City[] {
  return cities.filter((c) => (nationId === null ? !c.nationId : c.nationId === nationId));
}

function agentsOf(nationId: string | null, world: World): number {
  const owned = new Set(citiesOf(nationId, world.cities).map((c) => c.id));
  return world.units.filter((u) => u.cityId && owned.has(u.cityId)).length;
}

function buildNationRow(nation: Nation, world: World): HTMLElement {
  const row = document.createElement('div');
  row.className = 'nation-row';
  row.dataset['nationId'] = nation.id;

  const color = document.createElement('input');
  color.type = 'color';
  color.className = 'nation-color';
  color.value = nation.color;
  color.title = 'Color de la bandera';
  color.setAttribute('aria-label', `Color de ${nation.name}`);
  color.addEventListener('input', () => {
    updateNation(nation.id, { color: color.value });
    // Repaint the map without re-rendering the panel: the color picker keeps focus.
    if (_state.world) applyNationsToWorld(_state.world);
    _state.onChange?.();
  });

  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'nation-name';
  name.value = nation.name;
  name.title = 'Nombre de la nación';
  name.setAttribute('aria-label', 'Nombre de la nación');
  name.addEventListener('change', () => {
    if (!name.value.trim()) {
      name.value = nation.name;
      return;
    }
    updateNation(nation.id, { name: name.value });
    commit();
  });

  const counts = document.createElement('span');
  counts.className = 'nation-counts';
  const cityCount = citiesOf(nation.id, world.cities).length;
  const agentCount = agentsOf(nation.id, world);
  counts.textContent = `${cityCount}🏙 ${agentCount}⚔`;
  counts.title = `${cityCount} ciudades · ${agentCount} agentes`;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'nation-delete';
  remove.textContent = '🗑';
  remove.title = 'Eliminar nación';
  remove.setAttribute('aria-label', `Eliminar ${nation.name}`);
  remove.addEventListener('click', () => {
    if (!confirm(`¿Eliminar la nación "${nation.name}"? Sus ciudades quedan sin asignar.`)) return;
    deleteNation(nation.id);
    commit();
  });

  row.append(color, name, counts, remove);
  return row;
}

function buildCityRow(city: City, nations: Nation[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'nation-city-row';
  row.dataset['cityKey'] = cityKey(city);

  const label = document.createElement('span');
  label.className = 'nation-city-name';
  label.textContent = city.name;
  label.title = city.repoPath ?? city.id;

  const select = document.createElement('select');
  select.className = 'nation-city-select';
  select.setAttribute('aria-label', `Nación de ${city.name}`);
  select.append(new Option('Sin nación', ''));
  for (const nation of nations) {
    select.append(new Option(nation.name, nation.id));
  }
  select.value = city.nationId ?? '';
  select.addEventListener('change', () => {
    assignCityToNation(cityKey(city), select.value || null);
    commit();
  });

  row.append(label, select);
  return row;
}

function render(): void {
  const el = container();
  if (!el || !_state.world) return;
  const world = _state.world;
  const store = getNationStore();

  el.innerHTML = `
    <div class="nations-panel">
      <div class="nations-head">
        <span class="nations-title">
          <i data-lucide="flag" class="nations-icon"></i>
          Naciones
        </span>
        <button type="button" id="nations-new" class="nations-new">+ Nueva</button>
      </div>
      <p class="nations-hint">
        Agrupa ciudades bajo una bandera. Los bordes del territorio y los agentes
        toman el color de su nación.
      </p>
      <div class="nations-list" id="nations-list"></div>
      <div class="nations-section-title" id="nations-cities-title"></div>
      <div class="nations-cities" id="nations-cities"></div>
      <div class="nations-footer" id="nations-footer"></div>
    </div>
  `;

  const list = el.querySelector('#nations-list');
  if (list) {
    if (!store.nations.length) {
      const empty = document.createElement('p');
      empty.className = 'nations-empty';
      empty.textContent = 'Sin naciones todavía. Crea una para agrupar ciudades bajo una bandera.';
      list.append(empty);
    } else {
      for (const nation of store.nations) list.append(buildNationRow(nation, world));
    }
  }

  const title = el.querySelector('#nations-cities-title');
  if (title) title.textContent = `Ciudades · ${world.cities.length} en el mapa`;

  const cities = el.querySelector('#nations-cities');
  if (cities) {
    if (!world.cities.length) {
      const empty = document.createElement('p');
      empty.className = 'nations-empty';
      empty.textContent = 'No hay ciudades en el mapa.';
      cities.append(empty);
    } else {
      for (const city of world.cities) cities.append(buildCityRow(city, store.nations));
    }
  }

  const footer = el.querySelector('#nations-footer');
  if (footer) {
    const unaligned = citiesOf(null, world.cities).length;
    const label = store.nations.length === 1 ? 'nación' : 'naciones';
    footer.textContent = `${store.nations.length} ${label} · ${unaligned} sin asignar`;
  }

  el.querySelector('#nations-new')?.addEventListener('click', () => {
    const nation = createNation(`Nación ${getNationStore().nations.length + 1}`);
    commit();
    const input = el.querySelector<HTMLInputElement>(
      `[data-nation-id="${nation.id}"] .nation-name`,
    );
    input?.focus();
    input?.select();
  });

  // Icons for the freshly rendered markup.
  const lucide = (window as unknown as Record<string, unknown>)['lucide'];
  if (lucide) {
    (lucide as { createIcons: (opts: { icons: unknown; root: Element }) => void }).createIcons({
      icons: (lucide as Record<string, unknown>)['icons'],
      root: el,
    });
  }
}

/** Render the panel with the given world. `onChange` fires on every edit. */
export function renderNationsPanel(world: World, onChange?: () => void): void {
  _state.world = world;
  _state.onChange = onChange ?? null;
  render();
}

/** Wire the tab: re-render whenever the user opens the "Naciones" tab. */
export function initNationsPanel(world: World, onChange?: () => void): void {
  _state.world = world;
  _state.onChange = onChange ?? null;
  const tab = document.querySelector<HTMLElement>('.side-tab[data-tab="nations"]');
  tab?.addEventListener('click', () => render());
}
