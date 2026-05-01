// ─── RepoCiv — Recovery Client ─────────────────────────────────────────────────
// Lightweight TypeScript client for the bridge recovery endpoints.
// All calls return typed responses; network errors are surfaced as plain Error.

import type { HarnessDescriptor } from './harnessRegistry';
import { bridgeHeaders, bridgeUrl } from './bridgeEnv.ts';

// ─── Env ──────────────────────────────────────────────────────────────────────
// ─── Health status helpers ───────────────────────────────────────────────────
// Maps server-side health status strings to the runtime health label.
// health.kind is the check mechanism; health.status is a free-form string.

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export function harnessHealthFromJson(raw: unknown): HealthStatus {
  if (raw === 'healthy') return 'healthy';
  if (raw === 'degraded') return 'degraded';
  if (raw === 'unhealthy') return 'unhealthy';
  return 'unknown';
}

export function recoveryModesFromJson(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

// ─── Shell command formatting ─────────────────────────────────────────────────
// Supports two object shapes:
//   - RecoveryPlan { command?, cwd? }   — internal bridge shape
//   - { shell_command?, rationale? }    — test / external shape

export function formatShellCommand(obj: Record<string, unknown>): string | null {
  const cmd =
    (obj['command'] as string | undefined) ?? (obj['shell_command'] as string | undefined);
  if (!cmd) return null;
  const cwd = obj['cwd'] as string | undefined;
  return cwd ? `cd ${cwd} && ${cmd}` : cmd;
}

// ─── Recovery request builder ─────────────────────────────────────────────────

export interface RecoveryRequest {
  harness_id: string;
  reason: string;
  command_type?: string;
  details?: string;
  target?: string;
}

export function buildRecoveryRequest(
  harnessId: string,
  reason: string,
  context: { command_type?: string; target?: string; details?: string } = {},
): RecoveryRequest {
  const req: RecoveryRequest = { harness_id: harnessId, reason };
  if (context.command_type !== undefined) req.command_type = context.command_type;
  if (context.details !== undefined) req.details = context.details;
  if (context.target !== undefined) req.target = context.target;
  return req;
}

// ─── Reason labels ─────────────────────────────────────────────────────────────

export const REASON_LABELS: Record<string, string> = {
  failure: 'FAILURE',
  timeout: 'TIMEOUT',
  error: 'ERROR',
  crashed: 'CRASHED',
  auto_recovery: 'AUTO-RECOVERY',
  manual: 'MANUAL RECOVERY',
  escalated: 'ESCALATED',
  unknown: 'UNKNOWN',
};

// ─── Internal fetch helper ────────────────────────────────────────────────────
async function _get<T>(path: string): Promise<T> {
  const res = await fetch(bridgeUrl(path), { headers: bridgeHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[recoveryClient] GET ${path} → ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

async function _post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(bridgeUrl(path), {
    method: 'POST',
    headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[recoveryClient] POST ${path} → ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// ─── API surface ──────────────────────────────────────────────────────────────

/** GET /harnesses — list all registered harnesses. */
export async function listHarnesses(): Promise<HarnessDescriptor[]> {
  return _get<HarnessDescriptor[]>('/harnesses');
}

/** GET /harnesses/:id — single harness detail. */
export async function getHarness(id: string): Promise<HarnessDescriptor> {
  return _get<HarnessDescriptor>(`/harnesses/${encodeURIComponent(id)}`);
}

// ─── Recovery plan types ──────────────────────────────────────────────────────
export interface RecoveryPlan {
  mode: string; // e.g. "copy_command", "tmux_attach", "view_logs"
  command?: string; // shell command to run (present for copy_command / tmux_attach)
  session?: string; // tmux session name (present for tmux_attach)
  notes?: string[]; // human-readable guidance
  harness_id: string;
  cwd?: string; // working directory for the command
}

/** POST /harnesses/:id/recovery-command
 *
 * Asks the bridge to build a recovery plan for a given harness.
 *
 * @param harnessId   — harness id from the registry
 * @param reason      — human-readable reason (shown in event timeline)
 * @param context     — optional failure context (command type, target, details)
 */
export async function requestRecoveryPlan(
  harnessId: string,
  reason: string,
  context: { command_type?: string; target?: string; details?: string } = {},
): Promise<RecoveryPlan> {
  return _post<RecoveryPlan>(`/harnesses/${encodeURIComponent(harnessId)}/recovery-command`, {
    reason,
    ...context,
  });
}

// ─── Re-export shared types for consumers ────────────────────────────────────
export type { HarnessDescriptor } from './harnessRegistry';
export type { HarnessHealth, RecoveryMode } from './harnessRegistry';
