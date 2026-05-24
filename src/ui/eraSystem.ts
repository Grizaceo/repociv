// ─── RepoCiv — Imperial Era Progression ───────────────────────────────────

export interface EraDefinition {
  name: string;
  label: string;
  requirements: {
    cities?: number;
    missions?: number;
    agentTypes?: number;
    daysActive?: number;
  };
}

const ERAS: EraDefinition[] = [
  { name: 'Era I', label: 'ERA I — FUNDACIÓN', requirements: {} },
  { name: 'Era II', label: 'ERA II — EXPANSIÓN', requirements: { cities: 3, missions: 5, agentTypes: 3 } },
  { name: 'Era III', label: 'ERA III — CONSOLIDACIÓN', requirements: { cities: 6, missions: 20, agentTypes: 5 } },
  { name: 'Era IV', label: 'ERA IV — DOMINIO', requirements: { cities: 10, missions: 50, daysActive: 7 } },
  { name: 'Era V', label: 'ERA V — LEGADO', requirements: { cities: 15, missions: 100, daysActive: 30 } },
];

export function getCurrentEraIndex(metrics: {
  cityCount: number;
  missionCount: number;
  distinctAgentTypes: number;
  daysActive: number;
}): number {
  for (let i = ERAS.length - 1; i >= 0; i--) {
    const req = ERAS[i]!.requirements;
    if (
      (!req.cities || metrics.cityCount >= req.cities) &&
      (!req.missions || metrics.missionCount >= req.missions) &&
      (!req.agentTypes || metrics.distinctAgentTypes >= req.agentTypes) &&
      (!req.daysActive || metrics.daysActive >= req.daysActive)
    ) return i;
  }
  return 0;
}

export function getEraLabel(index: number): string {
  return ERAS[Math.min(index, ERAS.length - 1)]?.label ?? 'ERA I — FUNDACIÓN';
}

/** Render era badge in top bar */
export function updateEraDisplay(metrics: Parameters<typeof getCurrentEraIndex>[0]) {
  const idx = getCurrentEraIndex(metrics);
  const label = getEraLabel(idx);
  const el = document.getElementById('era-display');
  if (el) el.textContent = label;
  // store for next boot
  try {
    localStorage.setItem('repociv:eraIndex', String(idx));
    localStorage.setItem('repociv:eraLabel', label);
  } catch { /* noop */ }
  return label;
}

export function getStoredEraLabel(): string {
  try {
    return localStorage.getItem('repociv:eraLabel') ?? 'ERA I — FUNDACIÓN';
  } catch { return 'ERA I — FUNDACIÓN'; }
}
