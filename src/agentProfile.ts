// ─── RepoCiv — Agent Profile API ─────────────────────────────────────────────
// Client-side module for CRUD operations on RepoCivProfile.
//
// Profiles are stored server-side in ~/.repociv/config.json via the bridge API.
// This module provides:
//   - In-memory cache (avoids re-fetching on every render)
//   - load / save / delete profile via bridge REST
//   - loadIdentity / saveIdentity per profile
//   - listHarnessOptions for harness_ref picker

import { bridgeUrl, bridgeHeaders } from './bridgeEnv.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export type HarnessId = 'hermes' | 'claude' | 'codex' | 'cursor' | 'openclaw';
export type IdentityMode = 'native' | 'managed';

export interface RepoCivProfile {
  name: string;
  harness: HarnessId;
  harness_ref?: string;
  display_name?: string;
  model?: string;
  provider?: string;
  personality?: string;
  system_prompt?: string;
  slot_order?: number;
  identity_mode?: IdentityMode;
  profile_path?: string;
}

export interface ProfileIdentity {
  content: string;
  path: string;
  exists: boolean;
  error?: string;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

let _profileCache: Record<string, RepoCivProfile> | null = null;
let _cacheDirty = false;

// ─── Harness display metadata ─────────────────────────────────────────────────

export const HARNESS_META: Record<HarnessId, { label: string; emoji: string }> = {
  hermes: { label: 'Hermes', emoji: '⚡' },
  claude: { label: 'Claude Code', emoji: '🤖' },
  codex: { label: 'Codex', emoji: '📝' },
  cursor: { label: 'Cursor', emoji: '🎯' },
  openclaw: { label: 'OpenClaw', emoji: '🦞' },
};

export const VALID_HARNESSES: HarnessId[] = ['hermes', 'claude', 'codex', 'cursor', 'openclaw'];

// ─── Profile CRUD ─────────────────────────────────────────────────────────────

/** Load all profiles from the bridge. Returns a name→profile map. */
export async function loadProfiles(): Promise<Record<string, RepoCivProfile>> {
  const resp = await fetch(bridgeUrl('/api/profiles'), {
    headers: bridgeHeaders(),
  });
  if (!resp.ok) throw new Error(`GET /api/profiles → ${resp.status}`);
  const data = (await resp.json()) as { profiles: Record<string, Omit<RepoCivProfile, 'name'>> };
  const profiles: Record<string, RepoCivProfile> = {};
  for (const [name, entry] of Object.entries(data.profiles ?? {})) {
    profiles[name] = { name, ...entry };
  }
  _profileCache = profiles;
  _cacheDirty = false;
  return profiles;
}

/** Return cached profiles (or load if empty). */
export async function getProfiles(): Promise<Record<string, RepoCivProfile>> {
  if (_profileCache !== null && !_cacheDirty) return _profileCache;
  return loadProfiles();
}

/** Return profiles sorted by slot_order, then name. */
export async function getSortedProfiles(): Promise<RepoCivProfile[]> {
  const map = await getProfiles();
  return Object.values(map).sort((a, b) => {
    const sa = a.slot_order ?? 99;
    const sb = b.slot_order ?? 99;
    return sa !== sb ? sa - sb : a.name.localeCompare(b.name);
  });
}

/** Save (create or update) a profile. */
export async function saveProfile(profile: RepoCivProfile): Promise<RepoCivProfile> {
  const resp = await fetch(bridgeUrl('/api/profiles'), {
    method: 'POST',
    headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  const data = (await resp.json()) as { profile?: RepoCivProfile; error?: string };
  if (!resp.ok) throw new Error(data.error ?? `POST /api/profiles → ${resp.status}`);
  _cacheDirty = true;
  const saved = { name: profile.name, ...(data.profile ?? {}) } as RepoCivProfile;
  if (_profileCache) _profileCache[profile.name] = saved;
  return saved;
}

/** Delete a profile by name. */
export async function deleteProfile(name: string): Promise<void> {
  const resp = await fetch(bridgeUrl('/api/profiles/delete'), {
    method: 'POST',
    headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!resp.ok) {
    const data = (await resp.json()) as { error?: string };
    throw new Error(data.error ?? `DELETE profile ${name} → ${resp.status}`);
  }
  _cacheDirty = true;
  if (_profileCache) delete _profileCache[name];
}

/** Invalidate the in-memory cache (use after external changes). */
export function invalidateProfileCache(): void {
  _profileCache = null;
  _cacheDirty = false;
}

// ─── Identity (Alma) I/O ──────────────────────────────────────────────────────

/** Load the identity (Alma) content for a profile. */
export async function loadIdentity(name: string): Promise<ProfileIdentity> {
  const resp = await fetch(bridgeUrl(`/api/profiles/${encodeURIComponent(name)}/identity`), {
    headers: bridgeHeaders(),
  });
  if (!resp.ok) throw new Error(`GET /api/profiles/${name}/identity → ${resp.status}`);
  return resp.json() as Promise<ProfileIdentity>;
}

/** Save the identity (Alma) content for a profile. */
export async function saveIdentity(
  name: string,
  content: string,
): Promise<{ ok: boolean; path: string }> {
  const resp = await fetch(bridgeUrl(`/api/profiles/${encodeURIComponent(name)}/identity`), {
    method: 'POST',
    headers: { ...bridgeHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const data = (await resp.json()) as { ok?: boolean; path?: string; error?: string };
  if (!resp.ok)
    throw new Error(data.error ?? `POST /api/profiles/${name}/identity → ${resp.status}`);
  return { ok: !!data.ok, path: data.path ?? '' };
}

// ─── Harness options ──────────────────────────────────────────────────────────

/** List available harness_ref values for a profile (for the ref picker). */
export async function listHarnessOptions(name: string): Promise<string[]> {
  const resp = await fetch(bridgeUrl(`/api/profiles/${encodeURIComponent(name)}/harness-options`), {
    headers: bridgeHeaders(),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as { options?: string[] };
  return data.options ?? [];
}

// ─── Runtime chatConfig merge ─────────────────────────────────────────────────
// The unit panel stores per-unit harness/model/provider in localStorage.
// This helper merges a RepoCivProfile into that runtime config.

export function profileToChatConfig(profile: RepoCivProfile): {
  harness: string;
  provider: string;
  model: string;
} {
  return {
    harness: profile.harness,
    provider: profile.provider ?? '',
    model: profile.model ?? '',
  };
}
