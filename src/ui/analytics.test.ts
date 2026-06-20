import { beforeEach, describe, expect, it, vi } from 'vitest';

function stubStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
  });
  return store;
}

describe('local analytics', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('tracks hotkey usage in localStorage', async () => {
    const store = stubStorage();
    const analytics = await import('./analytics.ts');

    analytics.trackHotkey('F6:ledger');
    analytics.trackHotkey('F6:ledger');
    analytics.trackHotkey('P:priority');

    const saved = JSON.parse(store['repociv:analytics']!);
    expect(saved.hotkeysUsed).toEqual({
      'F6:ledger': 2,
      'P:priority': 1,
    });
  });

  it('reports panel usage over all KNOWN_PANELS, least-used first (poda view)', async () => {
    stubStorage();
    const analytics = await import('./analytics.ts');

    analytics.trackPanelOpen('observability');
    analytics.trackPanelOpen('observability');
    analytics.trackPanelOpen('approvals');

    const report = analytics.getPanelUsageReport();
    // Every canonical panel is present exactly once.
    expect(report.length).toBe(analytics.KNOWN_PANELS.length);
    expect(report.map((r) => r.panel).sort()).toEqual([...analytics.KNOWN_PANELS].sort());
    // Opened ones carry their counts.
    const byName = Object.fromEntries(report.map((r) => [r.panel, r.opens]));
    expect(byName['observability']).toBe(2);
    expect(byName['approvals']).toBe(1);
    // Sorted least-used first: a never-opened panel leads, the most-used trails.
    expect(report[0]!.opens).toBe(0);
    expect(report[report.length - 1]!.panel).toBe('observability');
    // Unused panels (poda candidates) are exactly the untouched ones.
    expect(report.filter((r) => r.opens === 0).length).toBe(analytics.KNOWN_PANELS.length - 2);
  });

  it('migrates older analytics payloads without hotkeys', async () => {
    const store = stubStorage({
      'repociv:analytics': JSON.stringify({
        sessions: 7,
        panelsOpened: { ledger: 3 },
        messagesSent: { DAVI: 2 },
        commandsIssued: 1,
        approvalsGiven: 0,
        citiesVisited: 4,
        missionsCompleted: 5,
        lastSession: '2026-05-30T00:00:00.000Z',
      }),
    });

    const analytics = await import('./analytics.ts');
    analytics.trackHotkey('T:terminal');

    const saved = JSON.parse(store['repociv:analytics']!);
    expect(saved.sessions).toBe(8);
    expect(saved.panelsOpened).toEqual({ ledger: 3 });
    expect(saved.hotkeysUsed).toEqual({ 'T:terminal': 1 });
    expect(saved.messagesSent).toEqual({ DAVI: 2 });
  });
});
