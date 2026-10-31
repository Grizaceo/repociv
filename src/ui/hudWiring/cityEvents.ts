import type { GameState } from '../../game.ts';
import type { Renderer } from '../../renderer.ts';
import type { City, Unit } from '../../types.ts';
import {
  addSelectedRepoPath,
  autoCityCoord,
  fetchScannedRepos,
  type ScannedRepo,
} from '../../map.ts';
import { decodeRepoCityId, findCityByRef } from '../../externalAgents.ts';
import { findCityByWonderSelection, findNearbyCities } from '../../wonders/cityLookup.ts';
import { logEvent } from '../hud.ts';
import { showNotification } from '../notificationBanner.ts';
import { startPlacingRepo } from '../mapEditor.ts';
import { showUnitPanel } from '../index.ts';

interface CityEventsDeps {
  renderer: Renderer;
  state: GameState;
  enterLocalViewForCity: (city: City) => void;
  getFirstUserUnit: (state: GameState) => Unit | undefined;
}

export function wireCityEvents({
  renderer,
  state,
  enterLocalViewForCity,
  getFirstUserUnit,
}: CityEventsDeps): void {
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
        enterLocalViewForCity(fullCity);
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

  // ─── Wonder ↔ RepoCiv bidirectional focus (generic, any connected wonder) ──
  window.addEventListener('repociv:wonder-focus-city', (e: Event) => {
    const detail = (e as CustomEvent).detail as
      { cityId: string; mode: 'macro' | 'local' } | undefined;
    if (!detail?.cityId) return;
    _focusCityRequest({ cityId: detail.cityId, mode: detail.mode, source: 'Wonder focus' });
  });

  window.addEventListener('repociv:wonder-selection', (e: Event) => {
    const detail = (e as CustomEvent).detail as
      { nodeId: string; nodePath: string; nodeType: string } | undefined;
    if (!detail?.nodeId && !detail?.nodePath) return;
    _focusCityRequest({
      cityId: detail?.nodeId,
      nodePath: detail?.nodePath,
      source: `Wonder ${detail?.nodeType ?? 'selection'}`,
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

  window.addEventListener('repociv:open-local-view-request', (e: Event) => {
    const detail = (e as CustomEvent).detail as { cityId?: string; repoPath?: string } | undefined;
    if (!detail?.cityId) return;
    const city = state.world.cities.find((c) => c.id === detail.cityId);
    if (!city) return;
    enterLocalViewForCity(city);
  });

  window.addEventListener('repociv:city-mission-request', (e: Event) => {
    const detail = (e as CustomEvent).detail as { cityId?: string } | undefined;
    if (!detail?.cityId) return;
    const city = state.world.cities.find((c) => c.id === detail.cityId);
    if (!city) return;
    if (!state.selectedUnit) renderer.centerOn(city.coord);

    renderer.onCitySelect?.(city.id);
    _primeMissionComposerForCity(city);
    logEvent(`🧪 Mission composer preparado para ${city.name}`, 'info');
  });

  // Add the repo an off-map agent works on to the map: persist the selection
  // (the server resolves repo ids and registers the parent root), then either
  // auto-place it near its nation (or the capital) or hand it to the editor.
  async function addRepoToMap(repoId: string, mode: 'auto' | 'pick'): Promise<void> {
    try {
      await addSelectedRepoPath(repoId);
    } catch (error) {
      showNotification({
        type: 'error',
        title: 'No se pudo agregar el repo',
        body: String(error),
      });
      return;
    }
    const repos = await fetchScannedRepos().catch(() => [] as ScannedRepo[]);
    const repo = repos.find(
      (r) =>
        r.path === repoId || (r.repoPath !== undefined && r.repoPath === decodeRepoCityId(repoId)),
    );
    if (!repo) {
      showNotification({
        type: 'warn',
        title: 'Repo no encontrado',
        body: 'El repo quedó seleccionado, pero el escaneo aún no lo devuelve.',
      });
      return;
    }
    // Already a city on this map: nothing else to do.
    if (findCityByRef(state.world.cities, repoId)) return;
    if (mode === 'pick') {
      startPlacingRepo(renderer, state, repo);
      return;
    }
    const coord = autoCityCoord(state.world, repo);
    if (!coord) {
      showNotification({
        type: 'warn',
        title: 'Sin casilla libre',
        body: 'No hay casilla libre cerca para fundar la ciudad.',
      });
      return;
    }
    renderer.foundRepoCity(repo, coord);
  }

  window.addEventListener('repociv:add-repo-to-map', (e: Event) => {
    const detail = (e as CustomEvent).detail as
      { repoId?: string; mode?: 'auto' | 'pick' } | undefined;
    if (!detail?.repoId) return;
    void addRepoToMap(detail.repoId, detail.mode === 'pick' ? 'pick' : 'auto');
  });
}
