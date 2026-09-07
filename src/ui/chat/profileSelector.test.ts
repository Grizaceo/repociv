import { describe, expect, it } from 'vitest';

import {
  findMatchingProfile,
  filterProfilesByHarness,
  findMatchingNativeProfile,
} from './profileSelector.ts';
import type { RepoCivProfile } from '../../agentProfile.ts';

const PROFILES: RepoCivProfile[] = [
  {
    name: 'davi',
    harness: 'hermes',
    provider: 'ollama-cloud',
    model: 'deepseek-v4-flash',
    slot_order: 0,
  },
  {
    name: 'lexo',
    harness: 'claude',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    slot_order: 1,
  },
  {
    name: 'auto-profile',
    harness: 'hermes',
    // provider/model undefined → "auto" (matches only an equally-empty config)
    slot_order: 2,
  },
];

describe('findMatchingProfile', () => {
  it('matches a profile whose harness/provider/model equal the config exactly', () => {
    expect(
      findMatchingProfile(PROFILES, {
        harness: 'hermes',
        provider: 'ollama-cloud',
        model: 'deepseek-v4-flash',
      }),
    ).toEqual(PROFILES[0]);
  });

  it('returns null when the config diverges from every profile', () => {
    expect(
      findMatchingProfile(PROFILES, {
        harness: 'hermes',
        provider: 'ollama-cloud',
        model: 'deepseek-v4-pro', // different model
      }),
    ).toBeNull();
  });

  it('matches a profile with empty provider/model only against an equally-empty config', () => {
    expect(findMatchingProfile(PROFILES, { harness: 'hermes', provider: '', model: '' })).toEqual(
      PROFILES[2],
    );
    // A config with a provider must NOT match the auto profile.
    expect(
      findMatchingProfile(PROFILES, { harness: 'hermes', provider: 'openai-api', model: '' }),
    ).toBeNull();
  });

  it('normalizes harness ids (claude ↔ claude-code) on both sides', () => {
    // Profile stores HarnessId 'claude'; chat config stores registry id.
    expect(
      findMatchingProfile(PROFILES, {
        harness: 'claude-code',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      }),
    ).toEqual(PROFILES[1]);
    // And the reverse: registry id in the profile, HarnessId in the config.
    // (Defensive: the server normalizes profiles to HarnessId, but the
    // matcher should not break if a registry id ever lands in storage.)
    const registryStored: RepoCivProfile[] = [
      {
        name: 'r',
        harness: 'claude-code' as RepoCivProfile['harness'],
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
    ];
    expect(
      findMatchingProfile(registryStored, {
        harness: 'claude',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      }),
    ).toEqual(registryStored[0]);
  });

  it('is insensitive to whitespace around stored provider/model values', () => {
    const padded: RepoCivProfile[] = [
      { name: 'p', harness: 'hermes', provider: ' ollama-cloud ', model: ' m ' },
    ];
    expect(
      findMatchingProfile(padded, { harness: 'hermes', provider: 'ollama-cloud', model: 'm' }),
    ).toEqual(padded[0]);
  });

  it('returns null for an empty profile list', () => {
    expect(findMatchingProfile([], { harness: 'hermes', provider: '', model: '' })).toBeNull();
  });
});

describe('filterProfilesByHarness', () => {
  it('keeps only profiles whose harness matches (registry id form)', () => {
    // Panel harness selector uses registry ids: 'claude-code' filters the
    // 'claude' profile (normalized) and drops hermes ones.
    const filtered = filterProfilesByHarness(PROFILES, 'claude-code');
    expect(filtered.map((p) => p.name)).toEqual(['lexo']);
  });

  it('keeps only hermes profiles when the panel harness is hermes', () => {
    const filtered = filterProfilesByHarness(PROFILES, 'hermes');
    expect(filtered.map((p) => p.name).sort()).toEqual(['auto-profile', 'davi']);
  });

  it('shows every profile when the harness is auto or empty', () => {
    expect(filterProfilesByHarness(PROFILES, 'auto')).toHaveLength(PROFILES.length);
    expect(filterProfilesByHarness(PROFILES, '')).toHaveLength(PROFILES.length);
  });

  it('returns nothing for an unknown harness', () => {
    expect(filterProfilesByHarness(PROFILES, 'codex')).toHaveLength(0);
  });

  it('does not mutate the input list', () => {
    const snapshot = [...PROFILES];
    filterProfilesByHarness(PROFILES, 'claude-code');
    expect(PROFILES).toEqual(snapshot);
  });
});

describe('findMatchingNativeProfile', () => {
  const NATIVE = ['main', 'lexo-alpha', 'procurador'];

  it('matches the canonical ~/.hermes/profiles/<name> path', () => {
    expect(findMatchingNativeProfile(NATIVE, '~/.hermes/profiles/lexo-alpha')).toBe('lexo-alpha');
  });

  it('matches an absolute path ending in /profiles/<name>', () => {
    expect(findMatchingNativeProfile(NATIVE, '/home/gris/.hermes/profiles/main')).toBe('main');
  });

  it('returns null for an empty or unknown path', () => {
    expect(findMatchingNativeProfile(NATIVE, '')).toBeNull();
    expect(findMatchingNativeProfile(NATIVE, '~/.hermes/profiles/unknown')).toBeNull();
    expect(findMatchingNativeProfile([], '~/.hermes/profiles/main')).toBeNull();
  });
});
