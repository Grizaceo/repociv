// ─── RepoCiv — Command Schema (TypeScript) ────────────────────────────────────
// Mirror of server/command_schema.py.
// UI creates Command drafts; bridge.py validates and applies policy.

export type CommandType =
  | 'inspect_repo'
  | 'read_file'
  | 'run_tests'
  | 'run_build'
  | 'edit_file'
  | 'create_branch'
  | 'git_commit'
  | 'delete_file'
  | 'execute_agent'
  | 'send_message'
  | 'unit_command'
  | 'quest_add'
  | 'e2e_probe';

export type Risk = 'low' | 'medium' | 'high' | 'destructive';

export type CommandStatus =
  | 'proposed'
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export interface CommandDraft {
  type: CommandType;
  target: string;
  payload?: Record<string, unknown>;
  created_by?: string;
}

export interface CommandResponse {
  ok: boolean;
  status: CommandStatus;
  commandId: string;
  reason?: string;
}

// ─── Per-type default risk (mirrors server/command_schema.py) ─────────────────
export const COMMAND_RISK: Record<CommandType, Risk> = {
  inspect_repo: 'low',
  read_file: 'low',
  run_tests: 'low',
  run_build: 'low',
  quest_add: 'low',
  e2e_probe: 'low',
  unit_command: 'medium',
  edit_file: 'medium',
  create_branch: 'medium',
  execute_agent: 'low',  // user-gated: the act of clicking/sending IS the approval
  git_commit: 'high',
  send_message: 'high',
  delete_file: 'destructive',
};

export function draftCommand(
  type: CommandType,
  target: string,
  payload?: Record<string, unknown>,
): CommandDraft {
  return { type, target, payload: payload ?? {}, created_by: 'user' };
}
