// ─── External agents (Suvadu) — rehydration on bridge (re)connect ───────────
// server/suvadu_tracker.py mirrors the Claude Code / Codex / Cursor sessions
// that Suvadu sees on this machine as ephemeral `ext-*` units, via plain
// unit_spawn / unit_state / unit_despawn events. Those events are
// fire-and-forget: a browser that connects (or reconnects) after a spawn would
// never see the unit. So on every connect the bridge client fetches the
// tracker snapshot (GET /api/external-agents) and replays the difference
// through the normal, validated event path.

import { parseBridgeEvent } from './bridgeSchema.ts';
import { bridgeHeaders, bridgeUrl } from './bridgeEnv.ts';
import type { BridgeEvent } from './types.ts';

/** Every unit owned by the Suvadu tracker has this id prefix. */
export const EXTERNAL_UNIT_PREFIX = 'ext-';

export function isExternalAgentUnit(unitId: string): boolean {
  return unitId.startsWith(EXTERNAL_UNIT_PREFIX);
}

/** One row of GET /api/external-agents `agents` (metadata only). */
export interface ExternalAgentRow {
  unit: string;
  unitType: string;
  cityId: string;
  state: string;
  mission?: string;
}

/**
 * Pure: the bridge events that bring the map's `ext-*` units in line with the
 * tracker snapshot — spawn missing ones, re-assert their state, despawn the
 * ones the tracker dropped while this client was not listening. Rows that do
 * not validate as bridge events are skipped.
 */
export function externalAgentEvents(
  currentUnitIds: Iterable<string>,
  rows: readonly ExternalAgentRow[],
): BridgeEvent[] {
  const onMap = new Set([...currentUnitIds].filter(isExternalAgentUnit));
  const wanted = new Set<string>();
  const raw: unknown[] = [];
  for (const row of rows) {
    if (typeof row?.unit !== 'string' || !isExternalAgentUnit(row.unit)) continue;
    wanted.add(row.unit);
    if (!onMap.has(row.unit)) {
      raw.push({
        type: 'unit_spawn',
        unit: row.unit,
        civ: 'capital',
        hex: [0, 0],
        unitType: row.unitType,
        mission: row.mission,
        cityId: row.cityId,
        ephemeral: true,
      });
    }
    raw.push({ type: 'unit_state', unit: row.unit, state: row.state });
  }
  for (const id of onMap) {
    if (!wanted.has(id)) raw.push({ type: 'unit_despawn', unit: id });
  }
  return raw.map(parseBridgeEvent).filter((e): e is BridgeEvent => e !== null);
}

/** Tracker snapshot rows, or null when the bridge is unreachable/older. */
export async function fetchExternalAgents(): Promise<ExternalAgentRow[] | null> {
  try {
    const res = await fetch(bridgeUrl('/api/external-agents'), { headers: bridgeHeaders() });
    if (!res.ok) return null;
    const body = (await res.json()) as { agents?: unknown };
    return Array.isArray(body.agents) ? (body.agents as ExternalAgentRow[]) : null;
  } catch {
    return null;
  }
}
