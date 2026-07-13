import { describe, expect, it } from 'vitest';

import {
  canCancelLifecycle,
  latestByCommand,
  lifecycleSnapshotEqual,
  lifecycleDetail,
  type LifecycleEvent,
} from './taskTimeline.ts';

function event(commandId: string, type: string, timestamp: number, data = {}): LifecycleEvent {
  return { id: `${commandId}-${timestamp}`, commandId, type, timestamp, actor: 'MAIN', data };
}

describe('canonical task timeline', () => {
  it('derives one latest state per command', () => {
    const latest = latestByCommand([
      event('a', 'CommandCreated', 1),
      event('b', 'CommandQueued', 2),
      event('a', 'CommandCompleted', 3, { status: 'completed' }),
    ]);
    expect(latest.get('a')?.type).toBe('CommandCompleted');
    expect(latest.get('b')?.type).toBe('CommandQueued');
  });

  it('recognizes an unchanged snapshot so polling keeps DOM stable', () => {
    const snapshot = [event('cmd-a', 'CommandCompleted', 2)];
    expect(lifecycleSnapshotEqual(snapshot, [...snapshot])).toBe(true);
    expect(lifecycleSnapshotEqual(snapshot, [event('cmd-a', 'CommandFailed', 3)])).toBe(false);
  });

  it('only offers cancellation for queued or waiting approval', () => {
    expect(canCancelLifecycle('CommandQueued')).toBe(true);
    expect(canCancelLifecycle('CommandWaitingApproval')).toBe(true);
    expect(canCancelLifecycle('CommandStarted')).toBe(false);
    expect(canCancelLifecycle('CommandCompleted')).toBe(false);
  });

  it('formats canonical terminal evidence', () => {
    expect(
      lifecycleDetail(
        event('a', 'CommandFailed', 3, {
          status: 'failed',
          error: 'adapter timeout',
          repoPath: '/repo/a',
        }),
      ),
    ).toBe('adapter timeout');
  });
});
