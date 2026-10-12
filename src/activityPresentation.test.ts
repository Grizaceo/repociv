import { describe, expect, it } from 'vitest';
import { presentActivities, type PresentedProcess } from './ui/activityPresentation.ts';
import type { ActivityEvent } from './ui/activityCorrelation.ts';
const process = (pid: number, ppid = 1): PresentedProcess => ({
  pid,
  ppid,
  rootPid: 10,
  processIdentity: `boot:${pid}:${pid * 10}`,
  name: 'hermes',
  state: 'S',
  family: 'Hermes',
  role: ppid === 1 ? 'agent' : 'descendant',
});
const identity = (commandId: string, data: Record<string, unknown> = {}): ActivityEvent => ({
  type: 'ExecutionIdentityRecorded',
  timestamp: 1,
  commandId,
  data: { commandId, commandType: 'execute_agent', harness: 'hermes', ...data },
});
const bound = (commandId: string, pid = 10): ActivityEvent => ({
  type: 'ProcessBound',
  timestamp: 2,
  commandId,
  data: { processIdentity: `boot:${pid}:${pid * 10}` },
});
describe('evidence-only human activity presentation', () => {
  it('uses explicit unit without equating it to profile', () => {
    const [a] = presentActivities(
      [process(10), process(11, 10)],
      [identity('one', { unitId: 'WORKER-2' }), bound('one')],
    );
    expect(a!.title).toBe('WORKER-2');
    expect(a!.profile).toBe('');
    expect(a!.processes).toHaveLength(2);
  });
  it('knows harness without fabricating profile or owner', () => {
    const [a] = presentActivities([], [identity('one')]);
    expect(a!.harness).toBe('Hermes');
    expect(a!.unit).toBe('');
    expect(a!.profile).toBe('');
    expect(a!.agent).toBe('');
  });
  it('shows an explicit agent/profile without unit', () => {
    const [a] = presentActivities(
      [],
      [identity('one', { profileName: 'reviewer', agentName: 'Reviewer' })],
    );
    expect(a!.title).toBe('Reviewer');
    expect(a!.profile).toBe('reviewer');
    expect(a!.unit).toBe('');
  });
  it('groups OS descendants without calling family a harness/owner', () => {
    const groups = presentActivities([process(10), process(11, 10), process(12, 11)], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.processes).toHaveLength(3);
    expect(groups[0]!.harness).toBe('');
    expect(groups[0]!.unit).toBe('');
  });
  it('keeps command history when the process has ended', () => {
    const [a] = presentActivities(
      [],
      [identity('one'), { type: 'CommandCompleted', commandId: 'one', timestamp: 3 }],
    );
    expect(a!.processes).toHaveLength(0);
    expect(a!.status).toContain('Comando completado');
  });
  it('closes ambiguous ownership conservatively', () => {
    const [a] = presentActivities(
      [],
      [identity('one', { unitId: 'A' }), identity('one', { unitId: 'B' })],
    );
    expect(a!.unit).toBe('');
    expect(a!.identityWarning).toContain('ambigua');
  });
  it('never accepts a legacy agentId as unit identity', () => {
    const [a] = presentActivities(
      [process(10)],
      [{ ...bound('one'), data: { ...bound('one').data, agentId: 'WORKER' } }],
    );
    expect(a!.unit).toBe('');
    expect(a!.agent).toBe('');
  });
  it('does not collapse separate runs of the same task', () => {
    const link = (runId: string): ActivityEvent => ({
      type: 'TaskRunLinked',
      timestamp: 1,
      data: { runId, taskKey: 'repo::issue' },
    });
    const groups = presentActivities(
      [process(10), process(20)],
      [identity('one'), identity('two'), link('one'), link('two'), bound('one'), bound('two', 20)],
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key)).toEqual(['task:repo::issue', 'task:repo::issue']);
    expect(groups.map((g) => g.processes.length)).toEqual([1, 1]);
  });
  it('does not correlate ambiguous bindings or recycled/different-boot parents', () => {
    const groups = presentActivities(
      [process(10), { ...process(11, 10), processIdentity: 'other:11:110' }],
      [identity('one'), identity('two'), bound('one'), bound('two')],
    );
    expect(groups.filter((g) => g.commandId).every((g) => !g.processes.length)).toBe(true);
    expect(groups.filter((g) => !g.commandId)).toHaveLength(2);
  });
  it('keeps opaque unit identifiers out of primary titles', () => {
    const [a] = presentActivities(
      [],
      [identity('one', { unitId: 'bdbfa3f7-8274-4328-bb90-915b87c4c83d' })],
    );
    expect(a!.title).toBe('Ejecución de agente');
    expect(a!.unit).not.toBe('');
  });
  it('keeps consistent unit evidence across changing dispatch attempts', () => {
    const [a] = presentActivities(
      [],
      [
        identity('one', { harness: 'hermes-cli', profileName: 'worker', unitId: 'WORKER-2' }),
        identity('one', { harness: 'claude', unitId: 'WORKER-2' }),
      ],
    );
    expect(a!.unit).toBe('WORKER-2');
    expect(a!.profile).toBe('');
    expect(a!.harness).toBe('Hermes CLI → Claude Code · intentos registrados');
    expect(a!.identityWarning).toBe('');
  });
  it('preserves independently known fields when unit evidence is ambiguous', () => {
    const [a] = presentActivities(
      [],
      [
        identity('one', { unitId: 'A', profileName: 'worker', agentName: 'Worker' }),
        identity('one', { unitId: 'B', profileName: 'worker', agentName: 'Worker' }),
      ],
    );
    expect(a!.unit).toBe('');
    expect(a!.agent).toBe('Worker');
    expect(a!.profile).toBe('worker');
    expect(a!.harness).toBe('Hermes');
    expect(a!.title).toBe('Worker');
  });
});
