/** Attention is local to this page. No invented blocked/done state from silence. */
export interface AttentionInput {
  id: string;
  label: string;
  context: string;
  kind: 'own' | 'external';
  ref: string;
  state: 'working' | 'thinking' | 'idle';
  active: boolean;
  blocked?: boolean;
}
export type AttentionStatus = 'blocked' | 'unreviewed' | 'working' | 'thinking' | 'idle';
export interface AttentionEntry extends AttentionInput {
  status: AttentionStatus;
}
const PRIORITY: Record<AttentionStatus, number> = {
  blocked: 0,
  unreviewed: 1,
  working: 2,
  thinking: 3,
  idle: 4,
};
export const ATTENTION_LABELS: Record<AttentionStatus, string> = {
  blocked: 'Aprobación pendiente',
  unreviewed: 'Actividad pasó a reposo · sin revisar (no confirma éxito)',
  working: 'Trabajando',
  thinking: 'Sesión ocupada · puede estar pensando o esperando al usuario',
  idle: 'En reposo',
};

export class AgentAttention {
  private previous = new Map<string, AttentionInput['state']>();
  private unseen = new Set<string>();

  markSeen(id: string): void {
    this.unseen.delete(id);
  }

  update(inputs: readonly AttentionInput[]): AttentionEntry[] {
    const present = new Set(inputs.map((input) => input.id));
    for (const id of this.previous.keys()) {
      if (!present.has(id)) {
        this.previous.delete(id);
        this.unseen.delete(id);
      }
    }
    const result: AttentionEntry[] = [];
    for (const input of inputs) {
      if (this.previous.get(input.id) === 'working' && input.state === 'idle') {
        this.unseen.add(input.id);
      }
      if (input.state === 'working') this.unseen.delete(input.id);
      this.previous.set(input.id, input.state);
      const status = input.blocked
        ? 'blocked'
        : this.unseen.has(input.id)
          ? 'unreviewed'
          : input.state;
      if (input.active || input.blocked || status === 'unreviewed')
        result.push({ ...input, status });
    }
    return result.sort(
      (a, b) => PRIORITY[a.status] - PRIORITY[b.status] || a.id.localeCompare(b.id),
    );
  }
}
