// ─── RepoCiv — City lookup helpers ───────────────────────────────────────────
// Fuzzy resolution of an external selection (an id, a repo path, a node path)
// onto one of the map's cities. Used by the generic `repociv:focus-city-request`
// wiring and by any connected wonder that emits a selection.
import type { City } from '../types.ts';

export type CityBridgeCandidate = Pick<City, 'id' | 'name' | 'repoPath'>;

function _normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^(hermes|workspace|repos)/, '');
}

export function basenameFromPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function normalizeWonderLookup(value: string): string {
  return _normalizeToken(value);
}

export function findCityByWonderSelection(
  cities: CityBridgeCandidate[],
  nodeId: string,
  nodePath?: string,
): CityBridgeCandidate | null {
  const safeNodeId = nodeId.trim();
  const safeNodePath = nodePath?.trim() ?? '';
  const nodeBasename = basenameFromPath(safeNodePath);
  const normalizedNodeId = _normalizeToken(safeNodeId);
  const normalizedNodeBasename = _normalizeToken(nodeBasename);

  const exactChecks = [
    (city: CityBridgeCandidate) => city.id === safeNodeId,
    (city: CityBridgeCandidate) => city.id.toLowerCase() === safeNodeId.toLowerCase(),
    (city: CityBridgeCandidate) => city.name.toLowerCase() === safeNodeId.toLowerCase(),
    (city: CityBridgeCandidate) => !!safeNodePath && city.repoPath === safeNodePath,
    (city: CityBridgeCandidate) =>
      !!safeNodePath &&
      !!city.repoPath &&
      safeNodePath.startsWith(city.repoPath.replace(/\\/g, '/')),
    (city: CityBridgeCandidate) =>
      !!nodeBasename && basenameFromPath(city.repoPath ?? '') === nodeBasename,
    (city: CityBridgeCandidate) =>
      !!nodeBasename && city.name.toLowerCase() === nodeBasename.toLowerCase(),
    (city: CityBridgeCandidate) =>
      normalizedNodeId.length > 0 &&
      (_normalizeToken(city.id) === normalizedNodeId ||
        _normalizeToken(city.name) === normalizedNodeId),
    (city: CityBridgeCandidate) =>
      normalizedNodeBasename.length > 0 &&
      (_normalizeToken(city.id) === normalizedNodeBasename ||
        _normalizeToken(city.name) === normalizedNodeBasename ||
        _normalizeToken(basenameFromPath(city.repoPath ?? '')) === normalizedNodeBasename),
  ];

  for (const predicate of exactChecks) {
    const match = cities.find(predicate);
    if (match) return match;
  }

  return null;
}

export function findNearbyCities(
  cities: CityBridgeCandidate[],
  query: string,
  limit = 5,
): Array<{ city: CityBridgeCandidate; score: number }> {
  const normalizedQuery = _normalizeToken(query);
  if (!normalizedQuery) return [];

  const queryGrams = new Set<string>();
  for (let i = 0; i < normalizedQuery.length - 1; i += 1) {
    queryGrams.add(normalizedQuery.slice(i, i + 2));
  }

  return cities
    .map((city) => {
      const candidateSource = `${city.name} ${city.id} ${basenameFromPath(city.repoPath ?? '')}`;
      const normalizedCandidate = _normalizeToken(candidateSource);
      const candidateGrams = new Set<string>();
      for (let i = 0; i < normalizedCandidate.length - 1; i += 1) {
        candidateGrams.add(normalizedCandidate.slice(i, i + 2));
      }
      const intersectionSize = [...queryGrams].filter((gram) => candidateGrams.has(gram)).length;
      const unionSize = new Set([...queryGrams, ...candidateGrams]).size;
      const score = unionSize > 0 ? intersectionSize / unionSize : 0;
      return { city, score };
    })
    .filter((entry) => entry.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
