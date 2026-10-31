import type { BridgeEvents } from '../../bridge.ts';
import type { GameState } from '../../game.ts';
import type { Renderer } from '../../renderer.ts';
import { tileKey } from '../../types.ts';
import {
  closeSidePanel,
  hideUnitPanel,
  loadFilesInfo,
  loadGitInfo,
  openCityPanel,
} from '../index.ts';
import { selectHero } from './spawn.ts';

interface SelectionDeps {
  renderer: Renderer;
  state: GameState;
  bridge: BridgeEvents;
}

export function wireSelection({ renderer, state, bridge }: SelectionDeps): void {
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

  renderer.onCitySelect = (cityId) => {
    _selectedCityId = cityId;
    const city = state.world.cities.find((c) => c.id === cityId);
    if (city) {
      const activeBuildings = state.world.buildings.filter((b) => b.cityId === cityId);
      const tile = state.world.tiles.get(tileKey(city.coord));
      // Show loading state immediately, then resolve asynchronously
      openCityPanel(city, activeBuildings, tile, state.lastFinishedMissionForCity(cityId));
      loadGitInfo(city);
      loadFilesInfo(city);
    }
    _publishWonderContext(cityId);
    window.dispatchEvent(
      new CustomEvent('repociv:city-selected', {
        detail: { cityId, repoPath: state.world.cities.find((c) => c.id === cityId)?.repoPath },
      }),
    );
  };
  _publishWonderContext(null);
}
