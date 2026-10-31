// ─── RepoCiv — Nations (map-edit layer) ─────────────────────────────────────
//
// A nation is an editorial layer over the real workspace: it groups cities
// (repos) and the units working on them under one flag color. Nothing here
// touches the filesystem or the agent runtime — it only changes how the map
// reads.
//
// Persistence lives in localStorage (like `manualLayout.ts` and `layers.ts`):
// the map is regenerated from the workspace scan on every load, so the nation
// layer has to be re-applied after each world generation. `applyNationsToWorld`
// does exactly that.

import type { City, Nation, Unit, World } from './types.ts';

export const NATION_STORE_KEY = 'repociv:nations:v1';

/** Editorial flag palette — heraldic hues that read on the golden-hour terrain. */
export const NATION_PALETTE: string[] = [
  '#4a70b8', // azul heráldico
  '#c74d47', // rojo óxido
  '#3d948c', // verdemar
  '#825c9f', // púrpura apagado
  '#d9873d', // ámbar quemado
  '#5c9957', // verde bandera
  '#c9708c', // rosa palo
  '#deb854', // oro viejo
  '#54a0c2', // celeste
  '#99a852', // oliva
];

export interface NationStore {
  version: 1;
  nations: Nation[];
  /** cityKey → nationId. Cities without an entry are unaligned. */
  assignments: Record<string, string>;
}

const EMPTY_STORE: NationStore = { version: 1, nations: [], assignments: {} };

/** Stable key for a city across reloads: the repo path when known, else the id. */
export function cityKey(city: Pick<City, 'id' | 'repoPath'>): string {
  return city.repoPath ?? city.id;
}

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'nacion';
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

/** Parse '#rrggbb' into RGB 0-1 (what the renderers consume). */
export function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

/** RGB 0-1 → '#rrggbb' (what the DOM and the store consume). */
export function rgb01ToHex(rgb: [number, number, number]): string {
  const part = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

/** '#rrggbb' → 'rgba(r, g, b, a)' for the 2D canvas. */
export function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb01(hex);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

function parseStore(raw: string | null): NationStore {
  if (!raw) return { ...EMPTY_STORE, assignments: {}, nations: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<NationStore>;
    if (parsed.version !== 1) return { ...EMPTY_STORE, assignments: {}, nations: [] };
    const nations = Array.isArray(parsed.nations)
      ? parsed.nations.filter(
          (n): n is Nation =>
            typeof n?.id === 'string' &&
            typeof n?.name === 'string' &&
            isHexColor(n?.color) &&
            typeof n?.createdAt === 'number',
        )
      : [];
    const assignments: Record<string, string> = {};
    if (parsed.assignments && typeof parsed.assignments === 'object') {
      for (const [key, value] of Object.entries(parsed.assignments)) {
        if (typeof value === 'string' && nations.some((n) => n.id === value))
          assignments[key] = value;
      }
    }
    return { version: 1, nations, assignments };
  } catch {
    return { ...EMPTY_STORE, assignments: {}, nations: [] };
  }
}

let _cache: NationStore | null = null;

/** Cached store. Loads from localStorage on first use. */
export function getNationStore(): NationStore {
  if (_cache) return _cache;
  if (!canUseLocalStorage()) {
    _cache = { ...EMPTY_STORE, assignments: {}, nations: [] };
    return _cache;
  }
  _cache = parseStore(window.localStorage.getItem(NATION_STORE_KEY));
  return _cache;
}

export function loadNationStore(): NationStore {
  return getNationStore();
}

export function saveNationStore(store: NationStore): void {
  _cache = store;
  if (!canUseLocalStorage()) return;
  window.localStorage.setItem(NATION_STORE_KEY, JSON.stringify(store));
}

/** Drop the in-memory cache (tests, and after an external write). */
export function resetNationStoreCache(): void {
  _cache = null;
}

function persist(): NationStore {
  const store = getNationStore();
  saveNationStore(store);
  return store;
}

/** Next free flag color for a new nation, skipping colors already in use. */
export function nextNationColor(existing: Nation[] = getNationStore().nations): string {
  const used = new Set(existing.map((n) => n.color.toLowerCase()));
  for (const color of NATION_PALETTE) {
    if (!used.has(color.toLowerCase())) return color;
  }
  return NATION_PALETTE[existing.length % NATION_PALETTE.length]!;
}

export function createNation(name: string, color?: string): Nation {
  const store = getNationStore();
  const trimmed = name.trim() || 'Nación';
  const nation: Nation = {
    id: `nation-${slugify(trimmed)}-${Date.now().toString(36)}`,
    name: trimmed,
    color: isHexColor(color) ? color : nextNationColor(store.nations),
    createdAt: Date.now(),
  };
  store.nations.push(nation);
  persist();
  return nation;
}

export function updateNation(id: string, patch: { name?: string; color?: string }): Nation | null {
  const store = getNationStore();
  const nation = store.nations.find((n) => n.id === id);
  if (!nation) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) nation.name = patch.name.trim();
  if (isHexColor(patch.color)) nation.color = patch.color;
  persist();
  return nation;
}

/** Remove a nation. Every city assigned to it becomes unaligned. */
export function deleteNation(id: string): boolean {
  const store = getNationStore();
  const idx = store.nations.findIndex((n) => n.id === id);
  if (idx === -1) return false;
  store.nations.splice(idx, 1);
  for (const [key, value] of Object.entries(store.assignments)) {
    if (value === id) delete store.assignments[key];
  }
  persist();
  return true;
}

/** Assign a city to a nation (or unalign it with `null`). */
export function assignCityToNation(key: string, nationId: string | null): void {
  const store = getNationStore();
  if (nationId === null) {
    delete store.assignments[key];
  } else {
    if (!store.nations.some((n) => n.id === nationId)) return;
    store.assignments[key] = nationId;
  }
  persist();
}

export function nationById(id: string | undefined): Nation | null {
  if (!id) return null;
  return getNationStore().nations.find((n) => n.id === id) ?? null;
}

export function nationForCity(city: Pick<City, 'id' | 'repoPath' | 'nationId'>): Nation | null {
  if (city.nationId) {
    const byId = nationById(city.nationId);
    if (byId) return byId;
  }
  const assigned = getNationStore().assignments[cityKey(city)];
  return assigned ? nationById(assigned) : null;
}

/** Effective territory/border color: the nation color wins over the city color. */
export function territoryColorFor(city: City): [number, number, number] {
  const nation = nationForCity(city);
  if (nation) return hexToRgb01(nation.color);
  return city.color ?? [0.725, 0.588, 0.329];
}

/** Nation color as CSS hex, or null when the city is unaligned. */
export function nationColorHexFor(city: Pick<City, 'id' | 'repoPath' | 'nationId'>): string | null {
  return nationForCity(city)?.color ?? null;
}

/** Nation of a unit: its own assignment, else the nation of the city it works in. */
export function nationForUnit(
  unit: Pick<Unit, 'id' | 'cityId'>,
  cities: Pick<City, 'id' | 'repoPath' | 'nationId'>[],
): Nation | null {
  const city = cities.find((c) => c.id === unit.cityId);
  return city ? nationForCity(city) : null;
}

/**
 * Re-apply the stored nation layer onto a freshly generated world.
 * Called right after `generateWorld()` and whenever the layer changes.
 */
export function applyNationsToWorld(world: World): void {
  const store = getNationStore();
  for (const city of world.cities) {
    const assigned = store.assignments[cityKey(city)];
    if (assigned && store.nations.some((n) => n.id === assigned)) {
      city.nationId = assigned;
    } else {
      delete city.nationId;
    }
  }
}

/** Cities grouped by nation id. Cities without a nation land under `null`. */
export function citiesByNation(world: World): Map<string | null, City[]> {
  const grouped = new Map<string | null, City[]>();
  for (const city of world.cities) {
    const key = city.nationId ?? null;
    const list = grouped.get(key) ?? [];
    list.push(city);
    grouped.set(key, list);
  }
  return grouped;
}
