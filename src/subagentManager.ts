// ─── RepoCiv — Subagent registry ────────────────────────────────────────────
// Extracted from game.ts. The Swarm Civ "subagent" concept is a
// long-running delegated task that produces a child unit and streams
// progress text. State is small (3 collections + 1 selected id) but the
// lifecycle is non-trivial: register → progress → complete/cancel with
// cleanup of the ephemeral unit and the local view counterpart.
//
// Pattern: class with explicit state + ops dependency objects. No
// inheritance from GameState, no circular type references. GameState
// owns one instance and delegates the public methods.

import type { SubagentRun } from './types.ts';

export interface SubagentState {
  /** Active subagent runs by id. Removed when the run completes. */
  active: Map<string, SubagentRun>;
  /** Recent completed runs, newest first, capped at 50. */
  completed: SubagentRun[] | null;
  /** Rolling text buffer (capped at 20 entries) per subagent id. */
  progress: Map<string, string[]>;
  /** Currently selected subagent (UI hint). Cleared on completion. */
  highlighted: string | null;
}

export interface SubagentOps {
  /** Bump the game-state change notification. */
  notify(): void;
  /** Remove the ephemeral unit associated with the run, if any. */
  removeUnit(id: string): boolean;
  /** Remove the local view counterpart of the ephemeral unit. */
  removeLocalUnit(id: string | undefined): void;
  /** Clear highlightedSubagentId if it matches the given id. */
  clearHighlight(id: string): void;
}

export class SubagentRegistry {
  constructor(
    readonly s: SubagentState,
    readonly ops: SubagentOps,
  ) {}

  register(run: SubagentRun): void {
    this.s.active.set(run.id, run);
    this.ops.notify();
  }

  update(id: string, patch: Partial<SubagentRun>): void {
    const existing = this.s.active.get(id);
    if (!existing) return;
    this.s.active.set(id, { ...existing, ...patch });
    this.ops.notify();
  }

  appendProgress(id: string, text: string): void {
    const buf = this.s.progress.get(id) ?? [];
    buf.push(text.slice(0, 256));
    if (buf.length > 20) buf.shift();
    this.s.progress.set(id, buf);
    const existing = this.s.active.get(id);
    if (existing) {
      this.s.active.set(id, { ...existing, lastProgressAt: Date.now() });
    }
    this.ops.notify();
  }

  complete(id: string, success: boolean, summary: string): void {
    this._finish(id, success ? 'complete' : 'failed', summary);
  }

  cancel(id: string, summary = 'cancelled'): void {
    this._finish(id, 'cancelled', summary);
  }

  private _finish(id: string, status: 'complete' | 'failed' | 'cancelled', summary: string): void {
    const run = this.s.active.get(id);
    if (!run) return;
    const finished: SubagentRun = {
      ...run,
      status,
      completedAt: Date.now(),
      summary,
    };
    this.s.active.delete(id);
    if (this.s.completed) {
      this.s.completed.unshift(finished);
      // Cap history at 50 (matches pre-refactor behavior in game.ts)
      if (this.s.completed.length > 50) {
        this.s.completed.length = 50;
      }
    }
    const ephemeralId = run.ephemeralUnitId ?? finished.ephemeralUnitId;
    this.ops.removeUnit(ephemeralId ?? '');
    this.ops.removeLocalUnit(ephemeralId);
    this.ops.clearHighlight(id);
    this.ops.notify();
  }

  resolveId(preferredId?: string | null, unitId?: string): string | null {
    if (
      preferredId &&
      (this.s.active.has(preferredId) || (this.s.completed ?? []).some((s) => s.id === preferredId))
    ) {
      return preferredId;
    }
    if (unitId) {
      const active = [...this.s.active.values()].filter(
        (s) => s.parentUnitId === unitId && s.status === 'running',
      );
      if (active.length) return active[0]!.id;
      const recent = (this.s.completed ?? []).filter((s) => s.parentUnitId === unitId);
      if (recent.length) return recent[0]!.id;
    }
    return this.s.highlighted;
  }
}
