import { describe, expect, it, vi } from 'vitest';
import type { ExternalSessionRow } from '../externalAgents.ts';
import { composerState, performExternalSend } from './agentsPanel.ts';

function session(props: Partial<ExternalSessionRow> = {}): ExternalSessionRow {
  return {
    sessionId: 'codex-1',
    source: 'suvadu',
    agent: 'codex',
    model: 'gpt-5-codex',
    repo: 'repociv',
    cityId: 'capital',
    active: true,
    state: 'working',
    unit: 'ext-codex-1',
    unitType: 'codex',
    firstActivityAt: 0,
    lastActivityAt: 0,
    commandCount: 0,
    eventCount: 0,
    totalTokens: null,
    subagent: false,
    imported: true,
    liveChat: { state: 'available', transport: 'codex-queue', reason: null },
    ...props,
  };
}

describe('external-session composer capability', () => {
  it('enables a live session only when its capability is available', () => {
    expect(composerState(session())).toMatchObject({ enabled: true, mode: 'live' });
    expect(
      composerState(
        session({
          liveChat: {
            state: 'probe_required',
            transport: 'codex-queue',
            reason: 'codex_probe_pending',
          },
        }),
      ),
    ).toMatchObject({
      enabled: false,
      mode: 'disabled',
      hint: expect.stringMatching(/verificar/i),
    });
    expect(
      composerState(
        session({
          liveChat: { state: 'unavailable', transport: null, reason: 'unsupported_session_source' },
        }),
      ),
    ).toMatchObject({
      enabled: false,
      mode: 'disabled',
      hint: expect.stringMatching(/disponible/i),
    });
  });

  it.each([true, false])(
    'keeps quiet sessions on the existing reply path even when mapped active=%s',
    (active) => {
      expect(
        composerState(
          session({
            active,
            state: 'idle',
            liveChat: { state: 'unavailable', transport: null, reason: 'codex_queue_unavailable' },
          }),
        ),
      ).toMatchObject({ enabled: true, mode: 'reply' });
    },
  );

  it('disables the composer synchronously while one submit is pending', () => {
    expect(composerState(session(), { sending: true })).toMatchObject({
      enabled: false,
      mode: 'live',
      hint: expect.stringMatching(/no se reintenta/i),
    });
  });
});

describe('performExternalSend', () => {
  it.each(['accepted', 'completed'] as const)(
    'uses live POST semantics and refreshes the transcript after %s',
    async (state) => {
      const sendLive = vi.fn().mockResolvedValue({
        state,
        transport: 'codex-queue',
        requestId: `req-${state}`,
      });
      const sendReply = vi.fn();
      const refresh = vi.fn().mockResolvedValue(undefined);

      await expect(
        performExternalSend(session(), 'seguí', { sendLive, sendReply, refresh }),
      ).resolves.toEqual({ ok: true, mode: 'live' });
      expect(sendLive).toHaveBeenCalledTimes(1);
      expect(sendLive).toHaveBeenCalledWith('codex-1', 'seguí');
      expect(sendReply).not.toHaveBeenCalled();
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves a live upstream error and does not retry or refresh', async () => {
    const error = { error: 'transport_failed', detail: 'queue rejected' };
    const sendLive = vi.fn().mockResolvedValue(error);
    const sendReply = vi.fn();
    const refresh = vi.fn();

    await expect(
      performExternalSend(session(), 'seguí', { sendLive, sendReply, refresh }),
    ).resolves.toEqual({ ok: false, error: 'transport_failed' });
    expect(sendLive).toHaveBeenCalledTimes(1);
    expect(sendReply).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'uses POST /reply semantics for a quiet session even when mapped active=%s',
    async (active) => {
      const sendLive = vi.fn();
      const sendReply = vi.fn().mockResolvedValue({
        state: 'running',
        startedAt: 1,
        finishedAt: null,
        error: '',
      });
      const refresh = vi.fn();
      const quiet = session({ active, state: 'idle' });

      await expect(
        performExternalSend(quiet, 'continuá', { sendLive, sendReply, refresh }),
      ).resolves.toMatchObject({ ok: true, mode: 'reply' });
      expect(sendReply).toHaveBeenCalledWith('codex-1', 'continuá');
      expect(sendLive).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    },
  );
});
