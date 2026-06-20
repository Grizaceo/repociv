// ─── RepoCiv — Mission lifecycle ────────────────────────────────────────────
// Extracted from game.ts. A mission is a unit-anchored quest with a
// running/complete/failed status and timestamps. Lifecycle is
// short (start → complete/fail) and self-contained — no cross-state
// cleanup needed (no unit removal, no UI callback chain).
//
// Pattern: same as subagentManager.ts — class with explicit state +
// ops dependencies. GameState owns one instance and delegates.

import type { Mission } from './game.ts';

export interface MissionState {
  /** Active + historical missions by id. Never garbage-collected. */
  active: Map<string, Mission>;
}

export interface MissionOps {
  /** Bump the game-state change notification. */
  notify(): void;
}

export class MissionRegistry {
  constructor(
    readonly s: MissionState,
    readonly ops: MissionOps,
  ) {}

  start(id: string, unit: string, questName: string): void {
    this.s.active.set(id, {
      id,
      unit,
      questName,
      status: 'running',
      startedAt: Date.now(),
      completedAt: null,
    });
    this.ops.notify();
  }

  /** Returns true only on a real running→terminal transition, so callers can
   *  guard side effects (e.g. analytics) against duplicate/replayed events.
   *  Missions are never GC'd, so a re-delivered complete would otherwise
   *  re-fire; behaviour (status/notify) is unchanged. */
  complete(id: string, success: boolean): boolean {
    const m = this.s.active.get(id);
    if (!m) return false;
    const wasRunning = m.status === 'running';
    m.status = success ? 'complete' : 'failed';
    m.completedAt = Date.now();
    this.ops.notify();
    return wasRunning;
  }
}
