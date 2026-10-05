// ─── Local view: agent activity overlay ────────────────────────────────────
// A unit standing at a workbench looks idle, but the agent behind it is doing
// several things at once — reading, editing, running commands, delegating. This
// module owns the *pure* half of that idea: how long an activity stays lit and
// which glyph represents it.
//
// Everything here is pure so it can be tested without a canvas. The draw call
// lives in isoLocalRenderer.ts (canvas-bound, covered by e2e screenshots).
//
// Slice 1 is deliberately ONE hardcoded glyph: the point is to prove the whole
// path — bridge emit → transport → client → pixel — end to end before we invest
// in a vocabulary. The per-tool table hangs off activityGlyphFor() in slice 2.

/** How long a tool call keeps the glyph lit. Long enough to read at a glance,
 *  short enough that a stale glyph never lies about what the agent is doing. */
export const ACTIVITY_TTL_MS = 1500;

/** The transient pulse drawn above a unit that just made a tool call. */
export interface LocalActivity {
  /** Raw tool name from the harness, kept for the chat/detail view. */
  toolName: string;
  /** Epoch ms of the call (Date.now() on the client that received it). */
  at: number;
}

export interface ActivityGlyph {
  glyph: string;
  color: string;
}

/** Slice 1: one glyph for every tool. Slice 2 replaces the body with a
 *  toolName → glyph table plus an explicit fallback for unknown tools. */
const SINGLE_GLYPH: ActivityGlyph = { glyph: '✳', color: '#ffd166' };

/**
 * Glyph for a tool name. Must always return something drawable: the tool list
 * is open-ended, and an unknown tool still needs an honest "something is
 * happening" mark rather than a blank.
 */
export function activityGlyphFor(toolName: string): ActivityGlyph {
  void toolName;
  return SINGLE_GLYPH;
}

/** True while the activity is still inside its TTL window. */
export function isActivityActive(activity: LocalActivity | null | undefined, now: number): boolean {
  if (!activity) return false;
  return now - activity.at < ACTIVITY_TTL_MS;
}

// ─── Attribution: which body in the office lights up ───────────────────────

/** The slice of LocalUnit this policy needs — kept structural so it stays
 *  testable without building a whole office. */
export interface LocalActivityUnit {
  id: string;
  macroUnitId: string;
  ephemeral?: boolean;
}

/**
 * Resolve which local unit a `unit_tool_call` addressed to `eventUnitId`
 * should light up.
 *
 * POLICY: the agent working in the repo. The harness stream attributes every
 * tool call to the parent macro unit, and that is the only attribution the
 * data supports — a background subagent's internal tool calls do NOT arrive as
 * separate stream events. They come back folded into the Task's own
 * `tool_result`; `subagent_tracker._tool_use_map` maps only the Task's own
 * `tool_use_id` to its subagent, which answers "whose result is this", never
 * "which child ran this tool".
 *
 * So when only ephemeral children remain, this returns null: lighting a child
 * on the parent's behalf would be a claim the stream cannot support, and a
 * pulse that lies is worse than no pulse.
 *
 * This is deliberately the one place the decision lives. The bridge event
 * keeps RepoCiv's macro semantics intact ("this unit is working in this
 * repo"); if per-child telemetry ever arrives, only this function moves.
 */
export function resolveActivityTarget<T extends LocalActivityUnit>(
  units: T[],
  eventUnitId: string,
): T | null {
  // The unit IS the event unit (the hero: its local id and macro id coincide).
  const exact = units.find((u) => u.id === eventUnitId);
  if (exact) return exact;

  // A macro unit standing in this office: prefer the non-ephemeral one — the
  // agent that owns the repo, not one of its delegates.
  const byMacro = units.filter((u) => u.macroUnitId === eventUnitId);
  return byMacro.find((u) => !u.ephemeral) ?? null;
}
