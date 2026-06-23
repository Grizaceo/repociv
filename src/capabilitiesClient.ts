// ─── RepoCiv — Capability Snapshot Client ────────────────────────────────────
// Fetches the capability model from the bridge at /api/agents/capabilities
// and caches it for sync access from hotkey handlers and UI renderers.
//
// The shape mirrors server/capabilities.py:capabilities_snapshot().
// TS never ships its own capability table — that was the source of the
// PR 1+3 drift. The server is the source of truth; this client mirrors it.

export interface CapabilitiesAgent {
  capabilities: string[];
  skills: string[];
  skillLabels: Record<string, string>;
  harness?: string;
  isProfile?: boolean;
}

export interface CapabilitiesSnapshot {
  agents: Record<string, CapabilitiesAgent>;
  repoRestrictions: Record<string, string[]>;
  skillRequirements: Record<string, string>;
  /**
   * Test-mode flag: when true, `agentCanDo` and `getSkillBadges` skip the
   * per-agent lookup and treat every agent as fully capable. Production
   * snapshots from the bridge never set this; only `setFullCapabilitiesForTesting`
   * flips it on. Keeps the production contract strict while letting
   * unrelated tests stay focused on what they're testing.
   */
  __testAnyAgent?: boolean;
}

const EMPTY_SNAPSHOT: CapabilitiesSnapshot = {
  agents: {},
  repoRestrictions: {},
  skillRequirements: {},
};

/**
 * Test helper: snapshot where any agent name maps to a full-capability entry.
 * Use this in tests that don't care about capability gating and just want
 * `canExecute(...)` to pass unless blocked by repo restrictions.
 */
const FULL_TEST_SNAPSHOT: CapabilitiesSnapshot = {
  agents: {},
  repoRestrictions: {
    legal: ['inspect_repo', 'read_file'],
    vault: ['inspect_repo', 'read_file'],
    secrets: ['inspect_repo', 'read_file'],
  },
  skillRequirements: {},
  __testAnyAgent: true,
};

export function setFullCapabilitiesForTesting(): void {
  cached = FULL_TEST_SNAPSHOT;
  lastFetched = Date.now();
}

/**
 * Test helper: build a snapshot where specific agents have the given
 * capability lists. Use when a test depends on the per-agent gate
 * (e.g. "scout cannot delete_file") instead of a blanket allow.
 */
export function setCapabilitiesForAgentsForTesting(
  agents: Record<
    string,
    { capabilities: string[]; skills?: string[]; skillLabels?: Record<string, string> }
  >,
): void {
  const agentsOut: Record<string, CapabilitiesAgent> = {};
  for (const [name, info] of Object.entries(agents)) {
    agentsOut[name] = {
      capabilities: info.capabilities,
      skills: info.skills ?? [],
      skillLabels: info.skillLabels ?? {},
    };
  }
  cached = {
    agents: agentsOut,
    repoRestrictions: {
      legal: ['inspect_repo', 'read_file'],
      vault: ['inspect_repo', 'read_file'],
      secrets: ['inspect_repo', 'read_file'],
    },
    skillRequirements: {},
  };
  lastFetched = Date.now();
}

let cached: CapabilitiesSnapshot = EMPTY_SNAPSHOT;
let lastFetched: number = 0;
const CACHE_TTL_MS = 30_000;
let inFlight: Promise<CapabilitiesSnapshot> | null = null;

export function getCapabilitiesSnapshot(): CapabilitiesSnapshot {
  return cached;
}

export function setCapabilitiesSnapshotForTesting(snapshot: CapabilitiesSnapshot): void {
  cached = snapshot;
  lastFetched = Date.now();
}

export function resetCapabilitiesSnapshotForTesting(): void {
  cached = EMPTY_SNAPSHOT;
  lastFetched = 0;
  inFlight = null;
}

export function isCapabilitiesSnapshotLoaded(): boolean {
  return Object.keys(cached.agents).length > 0;
}

export async function initCapabilities(
  fetchImpl: typeof fetch = fetch,
  bridgeBase: string = '',
): Promise<CapabilitiesSnapshot> {
  if (inFlight) return inFlight;
  const stale = Date.now() - lastFetched > CACHE_TTL_MS;
  if (!stale && cached !== EMPTY_SNAPSHOT) return cached;
  inFlight = (async () => {
    try {
      const res = await fetchImpl(`${bridgeBase}/api/agents/capabilities`, {
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error(`/api/agents/capabilities → HTTP ${res.status}`);
      }
      const data = (await res.json()) as CapabilitiesSnapshot;
      cached = data;
      lastFetched = Date.now();
      return data;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
