import { describe, expect, it } from 'vitest';
import { AgentAttention, type AttentionInput } from './agentAttention.ts';

const entry = (id: string, state: AttentionInput['state'] = 'idle'): AttentionInput => ({
  id,
  label: id,
  context: 'repo',
  kind: 'own',
  ref: id,
  state,
  active: true,
});

describe('compact agent attention', () => {
  it('puts verified approvals first without treating thinking as blocked', () => {
    const tracker = new AgentAttention();
    const rows = tracker.update([
      entry('a', 'working'),
      entry('b', 'thinking'),
      { ...entry('c'), blocked: true },
    ]);
    expect(rows.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(rows[2]?.status).toBe('thinking');
  });
  it('marks observed working → idle as unreviewed, not initial idle', () => {
    const tracker = new AgentAttention();
    expect(tracker.update([entry('a')])[0]?.status).toBe('idle');
    tracker.update([entry('a', 'working')]);
    expect(tracker.update([entry('a')])[0]?.status).toBe('unreviewed');
    tracker.markSeen('a');
    expect(tracker.update([entry('a')])[0]?.status).toBe('idle');
  });
  it('does not call thinking → idle a completed turn', () => {
    const tracker = new AgentAttention();
    tracker.update([entry('a', 'thinking')]);
    expect(tracker.update([entry('a')])[0]?.status).toBe('idle');
  });
  it('retains an observed completion after leaving the active window, until reviewed', () => {
    const tracker = new AgentAttention();
    tracker.update([entry('a', 'working')]);
    expect(tracker.update([{ ...entry('a'), active: false }])[0]?.status).toBe('unreviewed');
    tracker.markSeen('a');
    expect(tracker.update([{ ...entry('a'), active: false }])).toEqual([]);
  });
  it('drops disappeared sessions and avoids phantom completions on reappearance', () => {
    const tracker = new AgentAttention();
    tracker.update([entry('a', 'working')]);
    tracker.update([]);
    expect(tracker.update([entry('a')])[0]?.status).toBe('idle');
  });
  it('uses stable ordering and excludes inactive history', () => {
    const tracker = new AgentAttention();
    const rows = tracker.update([entry('z'), entry('a'), { ...entry('old'), active: false }]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'z']);
  });
});
