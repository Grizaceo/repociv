// ─── Idle agent finder (Age of Empires pattern) ─────────────────────────
import type { Unit } from '../types.ts';

/**
 * Cycles through idle units, advancing an internal index.
 * Resets when the set of idle unit IDs changes.
 */
export class IdleAgentFinder {
  private _index = 0;
  private _lastIdleIds: string[] = [];

  /** Returns the list of idle units from the given unit array. */
  static filterIdle(units: Unit[]): Unit[] {
    return units.filter((u) => u.state === 'idle');
  }

  /**
   * Get the next idle unit to focus on.
   * Returns null if no idle units exist.
   * The index wraps around and resets when the idle set changes.
   */
  nextIdle(units: Unit[]): Unit | null {
    const idle = IdleAgentFinder.filterIdle(units);
    if (idle.length === 0) {
      this._index = 0;
      this._lastIdleIds = [];
      return null;
    }

    const currentIds = idle.map((u) => u.id);
    const setChanged =
      this._lastIdleIds.length !== currentIds.length ||
      !currentIds.every((id, i) => this._lastIdleIds[i] === id);

    if (setChanged) {
      this._index = 0;
      this._lastIdleIds = currentIds;
    } else {
      this._index = (this._index + 1) % idle.length;
    }

    return idle[this._index] ?? null;
  }

  /** Peek at the current idle count without advancing. */
  idleCount(units: Unit[]): number {
    return IdleAgentFinder.filterIdle(units).length;
  }

  /** Reset the cycle (e.g. when entering local view). */
  reset(): void {
    this._index = 0;
    this._lastIdleIds = [];
  }
}

/** Shared singleton — both the HUD button and the `,` hotkey use this
 *  so the cycle index stays in sync regardless of input method. */
export const sharedIdleFinder = new IdleAgentFinder();
