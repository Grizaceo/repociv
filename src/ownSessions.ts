// ─── Own sessions (RepoCiv's own) — rehydration on bridge (re)connect ────────
// Own-session units are born client-side (the wizard spawns them after the
// bridge accepts the session), so a page reload loses the unit while the
// session itself — canonical.json + transcript on the bridge, chat config in
// localStorage — keeps living. server/own_sessions.py snapshots that store
// (GET /api/own-sessions); this module replays the difference through the
// normal, validated event path, the same way externalAgents.ts does for the
// tracker's ext-* units.
//
// No despawn here: a session that is merely idle stays on the map (it is the
// chat's anchor). Only sessions deleted from the store disappear — and that
// cleanup is explicit user action, not a snapshot diff.

import { parseBridgeEvent } from './bridgeSchema.ts';
import { bridgeHeaders, bridgeUrl } from './bridgeEnv.ts';
import type { BridgeEvent } from './types.ts';

/** One row of GET /api/own-sessions `agents`. */
export interface OwnSessionRow {
  unit: string;
  civ: string;
  unitType: string;
  cityId: string;
  cityRepoPath?: string;
  mission?: string;
  lastActivityAt?: string;
  state: 'working' | 'idle' | 'unknown' | string;
}

/**
 * Pure: the bridge events that bring the map's own-session units in line with
 * the store snapshot — spawn missing ones, and despawn exactly one kind of
 * unit: sessions the store marks ``closed`` (explicit user action via
 * POST /api/own-sessions/<unit>/close). Idle/unknown/working sessions keep
 * their map anchor. Rows that do not validate as bridge events are skipped.
 */
export function ownSessionEvents(
  currentUnitIds: Iterable<string>,
  rows: readonly OwnSessionRow[],
): BridgeEvent[] {
  const closed = new Set(
    rows.filter((r) => r?.state === 'closed' && typeof r.unit === 'string').map((r) => r.unit),
  );
  const onMap = new Set(currentUnitIds);
  const raw: unknown[] = [];
  for (const row of rows) {
    if (typeof row?.unit !== 'string' || !row.unit) continue;
    if (closed.has(row.unit)) continue; // handled below: despawn, not spawn
    if (onMap.has(row.unit)) continue; // already materialized by the wizard
    if (row.state === 'working') continue; // mid-turn: the runner emits its own spawn/state stream
    raw.push({
      type: 'unit_spawn',
      unit: row.unit,
      civ: typeof row.civ === 'string' && row.civ ? row.civ : 'capital',
      hex: [0, 0], // unplaced: the handler stands it next to its repo city
      unitType: row.unitType,
      mission: row.mission,
      cityId: row.cityId,
    });
  }
  const despawned: string[] = [];
  for (const id of currentUnitIds) {
    if (closed.has(id) && !despawned.includes(id)) despawned.push(id);
  }
  for (const unit of despawned) raw.push({ type: 'unit_despawn', unit });
  return raw.map(parseBridgeEvent).filter((e): e is BridgeEvent => e !== null);
}

/** Own-session snapshot rows, or null when the bridge is unreachable/older. */
export async function fetchOwnSessions(): Promise<OwnSessionRow[] | null> {
  try {
    const res = await fetch(bridgeUrl('/api/own-sessions'), { headers: bridgeHeaders() });
    if (!res.ok) return null;
    const body = (await res.json()) as { agents?: unknown };
    return Array.isArray(body.agents) ? (body.agents as OwnSessionRow[]) : null;
  } catch {
    return null;
  }
}

/** Explicit retire: mark an own session closed server-side. True on 2xx. */
export async function closeOwnSession(unit: string): Promise<boolean> {
  try {
    const res = await fetch(bridgeUrl(`/api/own-sessions/${encodeURIComponent(unit)}/close`), {
      method: 'POST',
      headers: bridgeHeaders(),
      body: '{}',
    });
    return res.ok;
  } catch {
    return false;
  }
}