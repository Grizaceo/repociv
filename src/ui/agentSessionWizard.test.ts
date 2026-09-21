import { describe, expect, it, vi } from 'vitest';
import type { RepoCivProfile } from '../agentProfile.ts';
import { startAgentSession } from './agentSessionWizard.ts';

const profile: RepoCivProfile = {
  name: 'cobalt',
  harness: 'hermes',
  harness_ref: 'cobalt',
};

const draft = {
  profile,
  cityId: 'repociv',
  mission: 'Revisá la misión.',
};

describe('startAgentSession', () => {
  it('preserves an explicit bridge rejection for the dialog to render', async () => {
    const startSession = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'La ciudad no está disponible.' });

    await expect(startAgentSession(startSession, draft)).resolves.toEqual({
      ok: false,
      reason: 'La ciudad no está disponible.',
    });
  });

  it('turns a transport rejection into a recoverable dialog result', async () => {
    const startSession = vi.fn().mockRejectedValue(new Error('bridge unavailable'));

    await expect(startAgentSession(startSession, draft)).resolves.toEqual({
      ok: false,
      reason: 'No pude hablar con el bridge.',
    });
  });
});
