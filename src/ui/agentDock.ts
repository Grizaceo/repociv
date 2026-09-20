// ─── Active-session dock — shared roster semantics ───────────────────────────
// One ordered list drives the HUD chips, number keys and Tab traversal. F8 uses
// the same external-session source; the dock never treats a foreign row as a
// commandable RepoCiv unit.

import { sessionLabel, type ExternalSessionRow } from '../externalAgents.ts';
import type { Unit } from '../types.ts';

/** The first nine entries have direct number-key access (1–9). */
export const ACTIVE_SESSION_DOCK_LIMIT = 9;

export interface AgentDockItem {
  /** Own items select their unit; external items open F8's read-only transcript. */
  kind: 'own' | 'external';
  /** Unit id for own items, external session id for foreign items. */
  key: string;
  label: string;
  state: string;
}

/**
 * The session inventory is intentionally ordered own-first. That preserves the
 * existing 1–9 muscle memory, then makes foreign active sessions discoverable
 * without putting foreign `ext-*` entities on the command path.
 */
export function activeSessionDock(
  units: readonly Unit[],
  externalSessions: readonly ExternalSessionRow[] | null,
): AgentDockItem[] {
  const own = units
    .filter((unit) => !unit.ephemeral)
    .map<AgentDockItem>((unit) => ({
      kind: 'own',
      key: unit.id,
      label: unit.name,
      state: unit.state,
    }));
  const external = (externalSessions ?? [])
    .filter((session) => session.active)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.sessionId.localeCompare(b.sessionId))
    .map<AgentDockItem>((session) => ({
      kind: 'external',
      key: session.sessionId,
      label: sessionLabel(session),
      state: session.state,
    }));
  return [...own, ...external];
}

/** The exact slice that is rendered as numbered chips. */
export function visibleSessionDock(items: readonly AgentDockItem[]): AgentDockItem[] {
  return items.slice(0, ACTIVE_SESSION_DOCK_LIMIT);
}

export function sessionDockOverflowCount(items: readonly AgentDockItem[]): number {
  return Math.max(0, items.length - ACTIVE_SESSION_DOCK_LIMIT);
}
