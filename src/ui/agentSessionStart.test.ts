import { describe, expect, it } from 'vitest';
import type { RepoCivProfile } from '../agentProfile.ts';
import { buildAgentSessionCommand, validateAgentSessionDraft } from './agentSessionStart.ts';

const hermesProfile: RepoCivProfile = {
  name: 'cobalt',
  display_name: 'Cobalt',
  harness: 'hermes',
  harness_ref: 'cobalt',
  provider: 'ollama-cloud',
  model: 'gpt-5.6-terra',
};

describe('agentSessionStart', () => {
  it('creates the canonical execute_agent command without exposing a local path', () => {
    expect(
      buildAgentSessionCommand({
        unitId: 'COBALT-2',
        profile: hermesProfile,
        cityId: 'repociv',
        mission: 'Audita el flujo de sesión.',
      }),
    ).toEqual({
      type: 'execute_agent',
      target: 'repociv',
      payload: {
        unit: 'COBALT-2',
        city: 'repociv',
        mission: 'Audita el flujo de sesión.',
        agentType: 'hero',
        harness: 'hermes',
        provider: 'ollama-cloud',
        model: 'gpt-5.6-terra',
        profile: '~/.hermes/profiles/cobalt',
      },
      created_by: 'agent-session-wizard',
    });
  });

  it('maps CLI profiles to their on-map unit type while keeping the same contract', () => {
    const profile: RepoCivProfile = { name: 'reviewer', harness: 'claude' };
    expect(
      buildAgentSessionCommand({
        unitId: 'REVIEWER',
        profile,
        cityId: 'care-de-caca',
        mission: 'Revisa el PR actual.',
      }).payload,
    ).toMatchObject({
      unit: 'REVIEWER',
      city: 'care-de-caca',
      agentType: 'claude',
      harness: 'claude',
      profile: '',
    });
  });

  it.each([
    [{ ...hermesProfile, name: '' }, 'repociv', 'Misión', 'Elegí un perfil válido.'],
    [hermesProfile, '', 'Misión', 'Elegí una ciudad del mapa.'],
    [hermesProfile, 'repociv', '   ', 'Escribí la misión inicial.'],
  ] as const)('rejects an incomplete wizard draft', (profile, cityId, mission, message) => {
    expect(validateAgentSessionDraft({ profile, cityId, mission })).toBe(message);
  });
});
