import type { Axial } from '../hex.ts';
import type { City, Unit } from '../types.ts';
import { cityForRef } from '../externalAgents.ts';

/** Prefer the working city: units may stand on an adjacent hex or be walking. */
export function agentLocation(unit: Unit, cities: readonly City[]): Axial {
  return cityForRef(cities, unit.cityId ?? '')?.coord ?? unit.coord;
}
