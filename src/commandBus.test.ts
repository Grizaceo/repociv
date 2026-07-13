import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { trackCommand, trackApproval } = vi.hoisted(() => ({
  trackCommand: vi.fn(),
  trackApproval: vi.fn(),
}));

vi.mock('./bridgeEnv.ts', () => ({
  bridgeUrl: (path: string) => `/bridge${path}`,
  bridgeHeaders: (extra: Record<string, string> = {}) => ({
    ...extra,
    'X-RepoCiv-Token': 'unit-token',
  }),
}));
vi.mock('./ui/analytics.ts', () => ({ trackCommand, trackApproval }));

import { approveCommand, rejectCommand, sendCommand, updateCommandStatus } from './commandBus.ts';

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    status,
    json: vi.fn(async () => payload),
  } as unknown as Response;
}

describe('commandBus', () => {
  beforeEach(() => {
    trackCommand.mockClear();
    trackApproval.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits a token-authenticated command and tracks a canonical id', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, status: 'waiting_approval', commandId: 'cmd-1' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const draft = { type: 'run_tests', target: 'repo', payload: { scope: 'unit' } } as const;

    const result = await sendCommand(draft);

    expect(result.commandId).toBe('cmd-1');
    expect(fetchMock).toHaveBeenCalledWith('/bridge/commands', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RepoCiv-Token': 'unit-token',
      },
      body: JSON.stringify(draft),
    });
    expect(trackCommand).toHaveBeenCalledOnce();
    updateCommandStatus('cmd-1', 'running');
  });

  it('returns a failed response when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );

    const result = await sendCommand({ type: 'run_tests', target: 'repo' });

    expect(result).toMatchObject({ ok: false, status: 'failed', commandId: '' });
    expect(result.reason).toContain('offline');
  });

  it('returns the HTTP status when the response is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 502,
        json: vi.fn(async () => Promise.reject(new Error('html'))),
      })),
    );

    const result = await sendCommand({ type: 'run_build', target: 'repo' });

    expect(result).toEqual({ ok: false, status: 'failed', commandId: '', reason: 'HTTP 502' });
  });

  it('approves and rejects through authenticated endpoints', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await sendCommand({ type: 'run_tests', target: 'repo' });

    await expect(approveCommand('cmd-1')).resolves.toBe(true);
    await expect(rejectCommand('cmd-1')).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith('/bridge/approvals/cmd-1/approve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RepoCiv-Token': 'unit-token',
      },
      body: '{}',
    });
    expect(fetchMock).toHaveBeenCalledWith('/bridge/approvals/cmd-1/reject', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RepoCiv-Token': 'unit-token',
      },
      body: '{}',
    });
    expect(trackApproval).toHaveBeenCalledOnce();
  });

  it('returns false when approval transport fails or bridge rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    await expect(approveCommand('missing')).resolves.toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false })),
    );
    await expect(rejectCommand('missing')).resolves.toBe(false);
  });
});
