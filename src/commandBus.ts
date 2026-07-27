// ─── RepoCiv — Command Bus (frontend) ─────────────────────────────────────────
// Sends Command drafts to bridge.py /commands.
// Tracks pending commands and exposes a reactive store for the UI.

import type { CommandDraft, CommandResponse, CommandStatus } from './commandSchema.ts';
import { bridgeHeaders, bridgeUrl } from './bridgeEnv.ts';
import { trackCommand, trackApproval } from './ui/analytics.ts';

// ─── In-flight command tracking ───────────────────────────────────────────────
export interface CommandRecord {
  id: string;
  type: string;
  target: string;
  status: CommandStatus;
  sentAt: number;
}

const _commands = new Map<string, CommandRecord>();
const _listeners = new Set<(commands: CommandRecord[]) => void>();

function _notify() {
  const snapshot = [..._commands.values()];
  for (const cb of _listeners) cb(snapshot);
}

// ─── Send a command draft to the bridge ───────────────────────────────────────
export async function sendCommand(draft: CommandDraft): Promise<CommandResponse> {
  let resp: Response;
  try {
    resp = await fetch(bridgeUrl('/commands'), {
      method: 'POST',
      headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(draft),
    });
  } catch (err) {
    return { ok: false, status: 'failed', commandId: '', reason: `network: ${String(err)}` };
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return { ok: false, status: 'failed', commandId: '', reason: `HTTP ${resp.status}` };
  }

  const data = body as Partial<CommandResponse> & { error?: string };

  // Bridge may reject with 4xx returning {error: "..."} only (no ok/status/reason).
  // Normalise those into the CommandResponse shape the UI expects.
  // (resp.ok may be undefined in test mocks — only treat 4xx/5xx as failure.)
  if (typeof resp.status === 'number' && resp.status >= 400) {
    return {
      ok: false,
      status: 'rejected',
      commandId: '',
      reason: data.error ?? `HTTP ${resp.status}`,
    };
  }
  if (data.ok === false) {
    return {
      ok: false,
      status: data.status ?? 'rejected',
      commandId: data.commandId ?? '',
      reason: data.reason ?? data.error,
    };
  }
  if (data.ok !== true) {
    return {
      ok: false,
      status: 'failed',
      commandId: '',
      reason: data.error ?? `malformed response: ${JSON.stringify(body).slice(0, 120)}`,
    };
  }

  if (data.commandId) {
    const record: CommandRecord = {
      id: data.commandId,
      type: draft.type,
      target: draft.target,
      status: data.status ?? 'queued',
      sentAt: Date.now(),
    };
    _commands.set(data.commandId, record);
    _notify();
    trackCommand();
  }

  return {
    ok: data.ok ?? false,
    status: data.status ?? 'failed',
    commandId: data.commandId ?? '',
    reason: data.reason,
  } as CommandResponse;
}

// ─── Update a command's status (called when bridge events arrive) ─────────────
export function updateCommandStatus(commandId: string, status: CommandStatus) {
  const rec = _commands.get(commandId);
  if (!rec) return;
  rec.status = status;
  _notify();
}

// ─── Approve / reject a waiting_approval command ─────────────────────────────
export async function approveCommand(commandId: string): Promise<boolean> {
  try {
    const resp = await fetch(bridgeUrl(`/approvals/${commandId}/approve`), {
      method: 'POST',
      headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
      body: '{}',
    });
    const data = (await resp.json()) as { ok: boolean };
    if (data.ok) {
      updateCommandStatus(commandId, 'queued');
      trackApproval();
    }
    return data.ok;
  } catch {
    return false;
  }
}

export async function rejectCommand(commandId: string): Promise<boolean> {
  try {
    const resp = await fetch(bridgeUrl(`/approvals/${commandId}/reject`), {
      method: 'POST',
      headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
      body: '{}',
    });
    const data = (await resp.json()) as { ok: boolean };
    if (data.ok) updateCommandStatus(commandId, 'rejected');
    return data.ok;
  } catch {
    return false;
  }
}
