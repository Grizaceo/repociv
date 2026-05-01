// ─── RepoCiv — Command Bus (frontend) ─────────────────────────────────────────
// Sends Command drafts to bridge.py /commands.
// Tracks pending commands and exposes a reactive store for the UI.

import type { CommandDraft, CommandResponse, CommandStatus } from './commandSchema.ts';
import { bridgeHeaders, bridgeUrl } from './bridgeEnv.ts';

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

export function subscribeCommands(cb: (commands: CommandRecord[]) => void): () => void {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

export function getCommands(): CommandRecord[] {
  return [..._commands.values()];
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
    return { ok: false, status: 'failed', commandId: '', reason: String(err) };
  }

  let data: CommandResponse;
  try {
    data = (await resp.json()) as CommandResponse;
  } catch {
    return { ok: false, status: 'failed', commandId: '', reason: `HTTP ${resp.status}` };
  }

  if (data.commandId) {
    const record: CommandRecord = {
      id: data.commandId,
      type: draft.type,
      target: draft.target,
      status: data.status,
      sentAt: Date.now(),
    };
    _commands.set(data.commandId, record);
    _notify();
  }

  return data;
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
    if (data.ok) updateCommandStatus(commandId, 'queued');
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
