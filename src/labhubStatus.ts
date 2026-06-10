// ─── RepoCiv — LabHub Status (Fase 5A: Real Contract + Fallback) ─────────────
// Source of truth for lab/experiment status per city.
// Uses real backend endpoint /api/labhub/status/{cityId} when Institutum is online.
// Falls back to local inference from game state when offline.
// Fallback source is explicitly marked for UI transparency.

import type { GameState } from './game.ts';
import type { City, Building, Unit } from './types.ts';
import { WONDER_INSTITUTUM_URL } from './wonderEnv.ts';
import { bridgeUrl, bridgeHeaders } from './bridgeEnv.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export type LabRisk = 'low' | 'medium' | 'high';
export type LabStatusState = 'idle' | 'running';
export type LabDataSource = 'live' | 'inferred';

export interface CityLabStatus {
  cityId: string;
  labId: string;
  status: LabStatusState;
  risk: LabRisk;
  writeLock: boolean;
  lastMetric: string;
  startedAt: string | null;
  links: {
    labhub?: string | null;
    logs?: string | null;
  };
  source: LabDataSource;
  institutumOnline: boolean;
}

// ─── Backend Contract Fetch ──────────────────────────────────────────────────

/** Fetch lab status for a single city from the backend.
 *  Returns null on failure/offline to trigger fallback inference. */
export async function fetchCityLabStatus(
  cityId: string,
  repoPath?: string,
): Promise<CityLabStatus | null> {
  try {
    const params = new URLSearchParams();
    if (repoPath) params.set('repoPath', repoPath);
    const url = `${bridgeUrl(`/api/labhub/status/${encodeURIComponent(cityId)}`)}${params.toString() ? '?' + params.toString() : ''}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: bridgeHeaders(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as CityLabStatus;
    // Normalize source
    data.source = data.source === 'live' ? 'live' : 'inferred';
    data.institutumOnline = data.institutumOnline ?? false;
    return data;
  } catch {
    return null;
  }
}

// ─── Local Inference Fallback ────────────────────────────────────────────────

function activeBuildingsForCity(state: GameState, cityId: string): Building[] {
  return state.world.buildings.filter((b) => b.cityId === cityId && b.state === 'building');
}

function activeUnitsForCity(state: GameState, cityId: string): Unit[] {
  return state
    .getAllUnits()
    .filter((u) => u.cityId === cityId && (u.state === 'working' || u.state === 'building'));
}

function riskFromSignals(activeBuildings: Building[], activeUnits: Unit[]): LabRisk {
  if (activeBuildings.length >= 2 || activeUnits.length >= 2) return 'high';
  if (activeBuildings.length >= 1 || activeUnits.length >= 1) return 'medium';
  return 'low';
}

function startedAtFromBuildings(activeBuildings: Building[]): string | null {
  const timestamps = activeBuildings
    .map((b) => b.sourceProcess?.startTime)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
  if (timestamps.length === 0) return null;
  return new Date(Math.min(...timestamps)).toISOString();
}

function logsPathForCity(city: City): string | undefined {
  const repoPath = city.repoPath?.trim();
  if (!repoPath) return undefined;
  return `${repoPath}/logs`;
}

/** Infer lab status from local game state. Used only as fallback when Institutum
 *  is offline or unreachable. */
export function inferCityLabStatus(state: GameState, city: City): CityLabStatus | null {
  const activeBuildings = activeBuildingsForCity(state, city.id);
  const activeUnits = activeUnitsForCity(state, city.id);
  if (activeBuildings.length === 0 && activeUnits.length === 0) return null;

  const firstBuilding = activeBuildings[0];
  const firstUnit = activeUnits[0];
  const labId = firstBuilding?.id ?? firstUnit?.id ?? `${city.id}-active`;
  const status = activeBuildings.length > 0 || activeUnits.length > 0 ? 'running' : 'idle';
  const lastMetricParts = [] as string[];
  if (activeBuildings.length > 0)
    lastMetricParts.push(`${activeBuildings.length} build(s) activas`);
  if (activeUnits.length > 0) lastMetricParts.push(`${activeUnits.length} unidad(es) trabajando`);
  if (firstBuilding) lastMetricParts.push(`principal=${firstBuilding.name}`);

  return {
    cityId: city.id,
    labId,
    status,
    risk: riskFromSignals(activeBuildings, activeUnits),
    writeLock: false,
    lastMetric: lastMetricParts.join(' · '),
    startedAt: startedAtFromBuildings(activeBuildings),
    links: {
      labhub: WONDER_INSTITUTUM_URL,
      logs: logsPathForCity(city),
    },
    source: 'inferred',
    institutumOnline: false,
  };
}

// ─── Smart Resolver (try real first, fallback to infer) ─────────────────────

/** Fetch via backend first; fallback to local inference if offline. */
export async function resolveCityLabStatus(
  state: GameState,
  city: City,
): Promise<CityLabStatus | null> {
  // Try backend contract first
  const live = await fetchCityLabStatus(city.id, city.repoPath);
  if (live && live.source === 'live') {
    return live;
  }
  // Fallback to local inference
  return inferCityLabStatus(state, city);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function formatLabStatusLabel(status: CityLabStatus | null): string {
  if (!status) return 'Sin experimento activo';
  const risk = status.risk.toUpperCase();
  const sourceLabel =
    status.source === 'live'
      ? 'Institutum'
      : status.institutumOnline
        ? 'live (sin datos)'
        : 'inferido local';
  return `${status.status.toUpperCase()} · riesgo ${risk} · ${sourceLabel}`;
}

export function formatLabSourceLabel(status: CityLabStatus): string {
  if (status.source === 'live') return '📡 Institutum';
  if (status.institutumOnline) return '📡 Institutum (sin datos para esta ciudad)';
  return '🔌 Inferencia local (Institutum offline)';
}

export function buildLabActionWarning(status: CityLabStatus, actionLabel: string): string {
  const age = status.startedAt ? `\nInicio: ${status.startedAt}` : '';
  const lock = status.writeLock ? '\nwriteLock=true (bloqueo fuerte declarado).' : '';
  const sourceNote =
    status.source === 'inferred' ? '\n⚠ Status inferido localmente — Institutum offline.' : '';
  return [
    `Hay trabajo vivo en ${status.cityId}.`,
    `Acción: ${actionLabel}.`,
    `Riesgo: ${status.risk}.`,
    `Señal: ${status.lastMetric || status.labId}.`,
    age,
    lock,
    sourceNote,
    '',
    '¿Continuar igual?',
  ]
    .filter(Boolean)
    .join('\n');
}
