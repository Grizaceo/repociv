import { beforeEach, describe, expect, it } from 'vitest';
import {
  activityColor,
  projectActivityMetadata,
  mergeActivityPages,
  activityEvents,
  eventKey,
  processKey,
  processesFor,
  confirmedOutcome,
  setActivityEvents,
  setActivityProcesses,
  selectActivity,
  activitySelection,
  type ActivityEvent,
} from './ui/activityCorrelation.ts';
const task = {
  type: 'TaskRunLinked',
  timestamp: 1,
  data: { runId: 'run1', commandId: 'run1', taskKey: 'repo::issue' },
};
const bound = {
  type: 'ProcessBound',
  timestamp: 2,
  data: { commandId: 'run1', pid: 10, processIdentity: 'boot:10:100' },
};
const done = { type: 'CommandCompleted', commandId: 'run1', timestamp: 3 };
const root = { pid: 10, ppid: 1, rootPid: 10, processIdentity: 'boot:10:100' };
const child = { pid: 11, ppid: 10, rootPid: 10, processIdentity: 'boot:11:101' };
beforeEach(() => {
  setActivityEvents([]);
  setActivityProcesses([]);
  selectActivity('');
});
describe('evidence-only activity projection', () => {
  it('joins explicit task/run and process evidence', () => {
    setActivityEvents([task, bound, done]);
    setActivityProcesses([root, child]);
    expect(eventKey(done)).toBe('task:repo::issue');
    expect(processKey(root)).toBe('task:repo::issue');
    expect(processKey(child)).toBe('task:repo::issue');
    expect(processesFor('task:repo::issue')).toHaveLength(2);
  });
  it('never infers by PID, timestamp, name or task-like metadata', () => {
    expect(processKey(root, [done], [root])).toBe('');
    expect(processKey(root, [{ ...bound, data: { commandId: 'run1', pid: 10 } }], [root])).toBe('');
    expect(eventKey({ type: 'other', timestamp: 2, data: { taskId: 'issue' } })).toBe('');
  });
  it('rejects reused PID, missing identity and a parent started after its child', () => {
    expect(processKey({ ...root, processIdentity: 'boot:10:200' }, [bound])).toBe('');
    expect(processKey({ ...root, processIdentity: 'newboot:10:100' }, [bound])).toBe('');
    expect(processKey({ ...child, processIdentity: null }, [bound], [root, child])).toBe('');
    expect(processKey({ ...child, processIdentity: 'boot:11:99' }, [bound], [root, child])).toBe(
      '',
    );
  });
  it('follows explicit nested ancestry, not arbitrary rootPid claims', () => {
    const grandchild = { pid: 12, ppid: 11, rootPid: 12, processIdentity: 'boot:12:102' };
    expect(processKey(grandchild, [bound], [root, child, grandchild])).toBe('run:run1');
    expect(processKey({ ...child, ppid: 999 }, [bound], [root, child])).toBe('');
  });
  it('fails closed on conflicting ownership even within the same task', () => {
    const other = { ...bound, data: { ...bound.data, commandId: 'run2' } };
    expect(
      processKey(
        root,
        [task, bound, other, { ...task, data: { ...task.data, runId: 'run2' } }],
        [root],
      ),
    ).toBe('');
    expect(
      eventKey(done, [task, { ...task, data: { ...task.data, taskKey: 'another::issue' } }]),
    ).toBe('run:run1');
  });
  it('retains history and selection when processes disappear, without inferring success', () => {
    setActivityEvents([task, bound]);
    setActivityProcesses([root]);
    selectActivity('task:repo::issue');
    setActivityProcesses([]);
    expect(activityEvents()).toHaveLength(2);
    expect(activitySelection()).toBe('task:repo::issue');
    expect(confirmedOutcome(bound)).toBe('Sin resultado terminal confirmado');
  });
  it('uses stable color across terminal history and multiple executions of a task', () => {
    const second = { ...task, data: { ...task.data, runId: 'run2' } };
    expect(activityColor(eventKey(done, [task]))).toBe(
      activityColor(eventKey({ ...done, commandId: 'run2' }, [second])),
    );
  });
  it('confirms only explicit terminal events and distinguishes task declarations', () => {
    expect(confirmedOutcome(done)).toContain('no valida la tarea');
    expect(confirmedOutcome({ ...done, type: 'CommandFailed' })).toBe('Comando fallido');
    expect(confirmedOutcome({ ...done, type: 'CommandCancelled' })).toBe('Comando cancelado');
    const phase: ActivityEvent = {
      type: 'TaskPhaseRecorded',
      timestamp: 4,
      data: { taskKey: 'repo::issue', phase: 'cancelled' },
    };
    expect(eventKey(phase)).toBe('task:repo::issue');
    expect(confirmedOutcome(phase)).toContain('no confirma salida');
    expect(confirmedOutcome({ ...phase, data: { phase: 'executing' } })).toContain(
      'no terminal confirmado',
    );
  });
});

it('drops content from legacy bridge rows before shared state', () => {
  const projected = projectActivityMetadata({
    type: 'CommandCompleted',
    timestamp: 1,
    data: {
      commandId: 'run',
      argv: 'SECRET',
      prompt: 'SECRET',
      result: 'SECRET',
      env: { token: 'SECRET' },
    },
  });
  expect(projected.data).toEqual({ commandId: 'run' });
  expect(JSON.stringify(projected)).not.toContain('SECRET');
});

it('retains loaded history across tail refreshes and deduplicates by canonical byte offset', () => {
  const old = { type: 'CommandCompleted', timestamp: 1, sourceOffset: 0, commandId: 'old' };
  const recent = { type: 'CommandStarted', timestamp: 2, sourceOffset: 100, commandId: 'new' };
  expect(mergeActivityPages([old, recent], [recent])).toEqual([old, recent]);
});
it('does not assign an unrelated command to the orchestrator', () => {
  expect(eventKey({ type: 'CommandStarted', timestamp: 1, commandId: 'chat-command' }, [])).toBe(
    'run:chat-command',
  );
});
it('rejects malformed colon-contaminated identity rather than inventing ancestry', () => {
  const malformed = { pid: 10, ppid: 1, rootPid: 10, processIdentity: 'boot:invalid:10:100' };
  expect(processKey(malformed, [], [malformed])).toBe('');
});
