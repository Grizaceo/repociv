// ─── RepoCiv — Wonder auto-start client ──────────────────────────────────────
// Thin TS wrapper over the bridge endpoints added in F2
// (POST /api/wonders/{id}/launch, GET /api/wonders/{id}/launch-status).
//
// Three entry points:
//   - launchWonder(id)              — fire one launch, return current status
//   - pollWonderUntilReady(id,...)  — poll launch-status until ready or timeout
//   - ensureWondersUp(ids,...)      — batch: launch + poll each, fire-and-forget
//
// Errors are surfaced as {ok:false, code, error, ...} rather than thrown —
// callers (wonderVignette, bootstrap) handle them via state, not exceptions.

import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';

export type WonderLaunchStatusValue =
  | 'offline'
  | 'starting'
  | 'degraded'
  | 'ready'
  | 'error'
  | 'already_running';

export interface WonderLaunchStatus {
  ok: boolean;
  id: string;
  status: WonderLaunchStatusValue;
  ready: boolean;
  api_ready: boolean;
  ui_ready: boolean;
  pids: Record<string, number>;
  started_at: number | null;
  api_url: string;
  ui_url: string;
  log_tail: string;
  error: string | null;
  /** True if the entry was adopted from a manually-started server (F2 audit B). */
  external?: boolean;
  /** Pass-through for HTTP errors (4xx/5xx). */
  code?: string;
  error_message?: string;
}

export interface LaunchOptions {
  /** Total wait for "ready" or "degraded" (ms). Default 60_000. */
  timeoutMs?: number;
  /** Poll interval (ms). Default 1500. */
  intervalMs?: number;
  /** Abort signal — lets the caller cancel the poll. */
  signal?: AbortSignal;
  /** Optional notifier for status changes during the poll. */
  onUpdate?: (status: WonderLaunchStatus) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 1_500;

/** POST /api/wonders/{id}/launch → 200 launch status, or 4xx {ok:false,...}. */
export async function launchWonder(id: string): Promise<WonderLaunchStatus> {
  const url = bridgeUrl(`/api/wonders/${encodeURIComponent(id)}/launch`);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
    });
  } catch (e) {
    return {
      ok: false,
      id,
      status: 'error',
      ready: false,
      api_ready: false,
      ui_ready: false,
      pids: {},
      started_at: null,
      api_url: '',
      ui_url: '',
      log_tail: '',
      error: 'network',
      error_message: `failed to reach bridge: ${(e as Error).message ?? e}`,
    };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      id,
      status: 'error',
      ready: false,
      api_ready: false,
      ui_ready: false,
      pids: {},
      started_at: null,
      api_url: '',
      ui_url: '',
      log_tail: '',
      error: String(body.code ?? 'launch_failed'),
      error_message: String(body.error ?? `HTTP ${res.status}`),
      code: String(body.code ?? `http_${res.status}`),
    };
  }
  return body as unknown as WonderLaunchStatus;
}

/** GET /api/wonders/{id}/launch-status → current status. */
export async function getWonderLaunchStatus(
  id: string,
): Promise<WonderLaunchStatus> {
  const url = bridgeUrl(`/api/wonders/${encodeURIComponent(id)}/launch-status`);
  const res = await fetch(url, { headers: bridgeHeaders() });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return body as unknown as WonderLaunchStatus;
}

/** POST /api/wonders/{id}/stop. */
export async function stopWonder(id: string): Promise<{ ok: boolean; id: string; error?: string }> {
  const url = bridgeUrl(`/api/wonders/${encodeURIComponent(id)}/stop`);
  const res = await fetch(url, {
    method: 'POST',
    headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
  });
  return (await res.json().catch(() => ({ ok: false, id }))) as { ok: boolean; id: string; error?: string };
}

/** Poll launch-status until the wonder is fully ready, or timeout.

    Behaviour (F3.1 fix for audit hallazgos F3-1 + F3-2):
      - The poll returns when ``status === 'ready'`` OR
        ``status === 'already_running'`` (a previous launch is live
        and adoptable). The cold-start "ready" includes both api and
        ui being up.
      - It does NOT return on ``degraded`` (only one of api/ui up)
        because the vignette mounts an iframe based on the UI URL
        and we want the full app, not a partial render. Continuing
        to poll on degraded lets the Vite cold-compile finish.
      - It does NOT cut on ``error`` either — with the backend
        grace-period (F3.1-A) the transient "npm-died-but-children-
        coming-up" window is now reported as ``starting`` not
        ``error``, so the poller keeps waiting through that.
      - Returns the LAST observed status when the deadline elapses
        (typically ``starting`` or ``degraded``).

    The grace period lives in the backend (20s); the client is
    patient up to ``timeoutMs``.
    */
export async function pollWonderUntilReady(
  id: string,
  opts: LaunchOptions = {},
): Promise<WonderLaunchStatus> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  // First call: launch (idempotent — if already running or adopted, this
  // returns the current status without spawning again).
  let status = await launchWonder(id);
  if (opts.onUpdate) opts.onUpdate(status);
  if (isFullyReady(status)) return status;
  if (isTerminalRejection(status)) return status;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return status;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    status = await getWonderLaunchStatus(id);
    if (opts.onUpdate) opts.onUpdate(status);
    if (isFullyReady(status)) return status;
    // Note: we keep polling on "starting", "degraded" AND "error"
    // (during the backend grace period, "error" can briefly appear
    // when npm dies before the children bind). Only the deadline
    // or a real 4xx (unknown_wonder, remote_rejected) ends the wait.
  }
  return status; // timeout — return the last status (likely "starting")
}

/** Fire-and-forget: launch + poll each id in the background. */
export function ensureWondersUp(
  ids: readonly string[],
  opts: LaunchOptions = {},
): void {
  for (const id of ids) {
    pollWonderUntilReady(id, opts).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn(`[wonderLauncher] ensureWondersUp(${id}) failed:`, e);
    });
  }
}

function isFullyReady(s: WonderLaunchStatus): boolean {
  // "ready"         — api + ui both up
  // "already_running" — adopted, we recorded an external entry; safe
  //                    to mount because the launcher already saw both
  //                    endpoints healthy at adoption time.
  return s.status === 'ready' || s.status === 'already_running';
}

function isTerminalRejection(s: WonderLaunchStatus): boolean {
  // 4xx errors mean we'll never succeed by waiting — bail out so the
  // caller can show an empty state with the right copy.
  if (s.ok === false && s.code) {
    return (
      s.code === 'unknown_wonder' ||
      s.code === 'remote_rejected' ||
      s.code === 'repo_not_found' ||
      s.code === 'http_404' ||
      s.code === 'http_403' ||
      s.code === 'http_412'
    );
  }
  return false;
}

/** localStorage helpers for the autoStartWonders flag (default ON). */
const AUTO_START_KEY = 'repociv:auto-start-wonders';

export function isAutoStartWondersEnabled(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_START_KEY);
    if (raw === null) return true; // default ON
    return raw !== 'false';
  } catch {
    return true;
  }
}

export function setAutoStartWondersEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_START_KEY, enabled ? 'true' : 'false');
  } catch {
    // localStorage unavailable (private mode, etc.) — silently ignore
  }
}
