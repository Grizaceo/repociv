// ─── RepoCiv — Bot roster → unit identity mapping ────────────────────────────
// Read-only consumption of the bridge's `/api/roster` endpoint. This module
// NEVER imports agentProfile.ts (the CRUD layer: upsert_profile / delete_profile
// / saveIdentity). It only reads the roster so units can render their Bot Mode
// identity (pet / face) on the hex grid AND in the assembly scene. Participation
// (sending to a room) lives in the chat panel and uses POST /api/rooms, not here.
//
// Contract (verified live, snake_case wire):
//   GET /api/roster?harness=hermes → 200
//     [{ name, is_bot, avatar_kind, avatar_url, pet, face_url }]
//   - avatar_kind ∈ { "pet", "face", "asset", null }
//       • "pet"  → real pet spritesheet (pets/<pet>/spritesheet.webp), `pet`
//                  carries {id, displayName, description}; avatar_url = spritesheet.
//       • "face" → real avatar.png (assets/avatar.png), face_url = that asset.
//       • "asset"→ legacy single PNG (e.g. old DAVI Desktop render); avatar_url set.
//       • null   → no identity on disk → caller falls back to the AGENT_ICONS glyph.
//   - DAVI is known in Hermes as "shadow-davi" (not "davi"); it carries a pet
//     ("Shadow" hedgehog) so avatar_kind is "pet" now, not "asset".
//
// resolveBotIdentity() is the SINGLE source of truth consumed by both the hex
// unit renderer (drawUnitAvatar) and the assembly scene (Among Us beans), so the
// same bot looks identical in both places — satisfying "identidad consistente".
import { bridgeUrl, bridgeHeaders } from './bridgeEnv.ts';

export type AvatarKind = 'pet' | 'face' | 'asset' | null;

export interface RosterPet {
  id: string;
  displayName: string;
  description: string;
}

export interface RosterEntry {
  name: string;
  is_bot: boolean;
  avatar_kind: AvatarKind;
  /** Bridge-relative path to the primary image (pet spritesheet or asset PNG). */
  avatar_url: string | null;
  /** Pet descriptor when avatar_kind === "pet". */
  pet: RosterPet | null;
  /** Bridge-relative path to the face avatar when avatar_kind === "face". */
  face_url: string | null;
}

/** Resolved identity for a unit/bot, consumed by every view. */
export interface BotIdentity {
  kind: AvatarKind;
  /** Final image URL to draw (already routed through bridgeUrl). */
  imageUrl: string | null;
  /** Human label for the bot (from pet.displayName when present, else name). */
  label: string;
  /** Pet descriptor (for assembly scene tooltip / description). */
  pet: RosterPet | null;
}

// Cache of the last roster fetch, keyed by lowercase normalized name.
let rosterCache: Map<string, RosterEntry> | null = null;
let rosterPromise: Promise<Map<string, RosterEntry>> | null = null;

// DAVI is known in Hermes as "shadow-davi"; the unit id may be "DAVI" or
// "SHADOW-DAVI". Normalize both sides so the lookup matches regardless.
function normalize(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Normalize a roster entry's name for O(1) lookup. */
function keyOf(entry: RosterEntry): string {
  return normalize(entry.name);
}

/**
 * Fetch (and cache) the Bot Mode roster from the bridge. Uses the bridge token
 * already configured in the frontend (bridgeHeaders). Never reads profile internals.
 */
export async function getRosterMap(
  harness = 'hermes',
): Promise<Map<string, RosterEntry>> {
  if (rosterCache) return rosterCache;
  if (rosterPromise) return rosterPromise;

  rosterPromise = (async () => {
    const resp = await fetch(bridgeUrl(`/api/roster?harness=${encodeURIComponent(harness)}`), {
      headers: bridgeHeaders(),
    });
    if (!resp.ok) {
      rosterPromise = null;
      throw new Error(`GET /api/roster → ${resp.status}`);
    }
    const data = (await resp.json()) as { profiles?: RosterEntry[] };
    const map = new Map<string, RosterEntry>();
    for (const entry of data.profiles ?? []) {
      map.set(keyOf(entry), entry);
    }
    rosterCache = map;
    return map;
  })();

  return rosterPromise;
}

/** Invalidate the cached roster (e.g. after a profile change). */
export function invalidateRosterCache(): void {
  rosterCache = null;
  rosterPromise = null;
}

/** Synchronous lookup from an already-fetched roster map (no network). */
export function findRosterEntry(map: Map<string, RosterEntry>, unitId: string): RosterEntry | null {
  return map.get(normalize(unitId)) ?? null;
}

/**
 * Resolve the single identity descriptor for a unit/bot. This is the ONE function
 * both the hex renderer and the assembly scene call, guaranteeing the same bot
 * looks identical in every view. Returns a `BotIdentity` whose `imageUrl` is the
 * bridge-routed URL to draw (or null → caller uses the AGENT_ICONS glyph).
 */
export function resolveBotIdentity(entry: RosterEntry | null): BotIdentity {
  if (!entry) {
    return { kind: null, imageUrl: null, label: '', pet: null };
  }
  switch (entry.avatar_kind) {
    case 'pet': {
      const url = entry.avatar_url ? bridgeUrl(entry.avatar_url) : null;
      return {
        kind: 'pet',
        imageUrl: url,
        label: entry.pet?.displayName ?? entry.name,
        pet: entry.pet,
      };
    }
    case 'face': {
      const url = entry.face_url ? bridgeUrl(entry.face_url) : null;
      return { kind: 'face', imageUrl: url, label: entry.name, pet: null };
    }
    case 'asset': {
      const url = entry.avatar_url ? bridgeUrl(entry.avatar_url) : null;
      return { kind: 'asset', imageUrl: url, label: entry.name, pet: null };
    }
    default:
      return { kind: null, imageUrl: null, label: entry.name, pet: null };
  }
}

/**
 * Resolve the avatar image URL for a unit, or null if it should fall back to the
 * existing AGENT_ICONS glyph. Kept for backward compatibility with callers that
 * only need the URL (e.g. the legacy hex badge). New views should use
 * resolveBotIdentity() to stay consistent with the assembly scene.
 */
export async function resolveAvatarUrl(unitId: string): Promise<string | null> {
  try {
    const map = await getRosterMap();
    const entry = map.get(normalize(unitId));
    return resolveBotIdentity(entry ?? null).imageUrl;
  } catch {
    return null;
  }
}

// ─── Image cache for drawn avatars ───────────────────────────────────────────
const imageCache = new Map<string, HTMLImageElement>();
const failedUrls = new Set<string>();

/**
 * Get a cached HTMLImageElement for an avatar URL, kicking off the load if needed.
 * Returns null until the image has loaded (callers draw the fallback until then).
 * A failed load is remembered so we don't retry every frame.
 */
export function getAvatarImage(url: string): HTMLImageElement | null {
  if (!url) return null;
  if (failedUrls.has(url)) return null;
  let img = imageCache.get(url);
  if (!img) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      /* marked ready on next getAvatarImage call */
    };
    img.onerror = () => {
      failedUrls.add(url);
      imageCache.delete(url);
    };
    img.src = url;
    imageCache.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** Drop the failed/loaded caches (call on logout or profile change). */
export function clearAvatarImages(): void {
  imageCache.clear();
  failedUrls.clear();
}
