import { describe, expect, it } from 'vitest';
import type { Unit } from '../types.ts';
import type { ExternalSessionRow } from '../externalAgents.ts';
import { ACTIVE_SESSION_DOCK_LIMIT, activeSessionDock, visibleSessionDock } from './agentDock.ts';

const unit = (id: string, props: Partial<Unit> = {}): Unit =>
  ({ id, name: id, type: 'hero', state: 'idle', coord: { q: 0, r: 0 }, ...props }) as Unit;

const external = (sessionId: string, props: Partial<ExternalSessionRow> = {}): ExternalSessionRow =>
  ({
    sessionId,
    agent: sessionId,
    model: '',
    repo: '',
    cityId: '',
    active: true,
    state: 'working',
    unit: `ext-${sessionId}`,
    unitType: 'hero',
    firstActivityAt: 0,
    lastActivityAt: 0,
    commandCount: 0,
    eventCount: 0,
    totalTokens: null,
    subagent: false,
    imported: true,
    ...props,
  }) as ExternalSessionRow;

describe('agentDock', () => {
  it('keeps persistent own units first and adds only active external sessions', () => {
    const dock = activeSessionDock(
      [unit('MAIN'), unit('subagent', { ephemeral: true }), unit('WORKER', { state: 'working' })],
      [external('cobalt', { agent: 'Cobalt' }), external('quiet', { active: false })],
    );

    expect(dock.map((item) => [item.kind, item.key, item.label, item.state])).toEqual([
      ['own', 'MAIN', 'MAIN', 'idle'],
      ['own', 'WORKER', 'WORKER', 'working'],
      ['external', 'cobalt', 'Cobalt', 'working'],
    ]);
  });

  it('makes every visible chip keyboard-addressable and reports the remainder', () => {
    const rows = Array.from({ length: ACTIVE_SESSION_DOCK_LIMIT + 2 }, (_, i) => external(`s${i}`));
    const dock = activeSessionDock([], rows);

    expect(visibleSessionDock(dock)).toHaveLength(ACTIVE_SESSION_DOCK_LIMIT);
    expect(dock.slice(ACTIVE_SESSION_DOCK_LIMIT)).toHaveLength(2);
  });
});
