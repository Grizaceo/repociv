import { describe, expect, it } from 'vitest';
import type { AgentDockItem } from './agentDock.ts';
import { sessionLauncherSummary } from './sessionLauncherSummary.ts';

const own = (key: string, state = 'idle'): AgentDockItem => ({
  kind: 'own',
  key,
  label: key,
  state,
});

const external = (key: string, state = 'working'): AgentDockItem => ({
  kind: 'external',
  key,
  label: key,
  state,
});

describe('sessionLauncherSummary', () => {
  it('keeps the selected map unit as the compact strip context', () => {
    const summary = sessionLauncherSummary([own('MAIN'), external('cobalt')], 'MAIN');

    expect(summary).toMatchObject({ total: 2, active: 1, focus: own('MAIN') });
  });

  it('falls back to the most relevant active session when nothing on the map is selected', () => {
    const summary = sessionLauncherSummary([own('MAIN'), external('cobalt'), own('WORKER', 'working')], null);

    expect(summary).toMatchObject({ total: 3, active: 2, focus: external('cobalt') });
  });

  it('reports an empty strip without inventing a focus context', () => {
    expect(sessionLauncherSummary([], null)).toEqual({ total: 0, active: 0, focus: null });
  });
});
