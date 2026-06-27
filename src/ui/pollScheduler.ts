// ─── RepoCiv — Central poll scheduler (M6) ───────────────────────────────────
// One interval tick drives all UI/bridge polling. Callbacks register with their
// own cadence; ticks are skipped while document.hidden (Page Visibility API).

export type PollUnregister = () => void;

export interface RegisterPollOptions {
  /** Run fn once immediately on register (default true). */
  immediate?: boolean;
  /** Delay first run by this many ms (stagger concurrent polls). */
  phaseMs?: number;
}

interface PollEntry {
  id: string;
  fn: () => void | Promise<void>;
  intervalMs: number;
  nextDue: number;
}

const TICK_MS = 1_000;

const entries = new Map<string, PollEntry>();
let tickId: ReturnType<typeof setInterval> | null = null;
let visibilityBound = false;

function hasDocument(): boolean {
  return typeof document !== 'undefined';
}

function isPaused(): boolean {
  return hasDocument() && Boolean(document.hidden);
}

function ensureVisibilityListener(): void {
  if (visibilityBound || !hasDocument()) return;
  const add = document.addEventListener;
  if (typeof add !== 'function') return;
  visibilityBound = true;
  add.call(document, 'visibilitychange', () => {
    if (!document.hidden) onTick();
  });
}

function scheduleTick(): void {
  if (tickId != null) return;
  const sched = globalThis.setInterval;
  if (typeof sched !== 'function') return;
  tickId = sched(onTick, TICK_MS);
  ensureVisibilityListener();
}

function stopTick(): void {
  if (tickId == null) return;
  clearInterval(tickId);
  tickId = null;
}

function onTick(): void {
  if (isPaused()) return;
  const now = Date.now();
  for (const entry of entries.values()) {
    if (now >= entry.nextDue) {
      entry.nextDue = now + entry.intervalMs;
      void entry.fn();
    }
  }
}

/** Register a polling callback. Returns an unregister function. */
export function registerPoll(
  id: string,
  fn: () => void | Promise<void>,
  intervalMs: number,
  options: RegisterPollOptions = {},
): PollUnregister {
  const immediate = options.immediate ?? true;
  const phaseMs = options.phaseMs ?? 0;
  const now = Date.now();

  entries.set(id, {
    id,
    fn,
    intervalMs,
    nextDue: immediate ? now + intervalMs : now + phaseMs,
  });

  if (immediate && !isPaused()) void fn();

  scheduleTick();
  return () => unregisterPoll(id);
}

export function unregisterPoll(id: string): void {
  entries.delete(id);
  if (entries.size === 0) stopTick();
}

export function isPollRegistered(id: string): boolean {
  return entries.has(id);
}

/** Tests only — tear down all registrations and the master tick. */
export function resetPollSchedulerForTests(): void {
  entries.clear();
  stopTick();
  visibilityBound = false;
}
