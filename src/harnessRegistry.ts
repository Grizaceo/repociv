// ─── RepoCiv — Harness Registry Loader ───────────────────────────────────────
// Loads and validates shared/harness-registry.json at runtime.
// Provides narrow helpers: getHarness, listHarnesses, findHarnessForCommand.

// Vite resolves this to the raw file contents at both dev and build time.
import harnessRegistryRaw from '../shared/harness-registry.json' with { type: 'json' };
const _raw = harnessRegistryRaw as unknown;

// ─── Types ────────────────────────────────────────────────────────────────────

export type HarnessKind = 'reference' | 'agent_runtime' | 'sandbox' | 'local_cli' | 'bridge';

export type HarnessTransport = 'none' | 'cli' | 'http' | 'plugin' | 'sandbox';

export type TrustLevel =
  | 'reference_only'
  | 'read_only'
  | 'local_cli'
  | 'sandboxed'
  | 'privileged_external';

export type RecoveryMode = 'copy_command' | 'tmux_attach' | 'view_logs' | 'no_recovery_available';

export interface RecoveryDescriptor {
  cwd?: string;
  command?: string;
  session?: string;
  notes?: string[];
}

export interface HarnessHealth {
  kind: 'static' | 'command' | 'http';
  status?: string;
  command?: string;
  url?: string;
}

export interface HarnessDescriptor {
  id: string;
  label: string;
  kind: HarnessKind;
  trustLevel: TrustLevel;
  transport: HarnessTransport;
  health: HarnessHealth;
  recoveryModes: RecoveryMode[];
  allowedActions: string[];
  blockedActions: string[];
  recovery?: Record<string, RecoveryDescriptor>;
}

// ─── Schema version ───────────────────────────────────────────────────────────

interface HarnessRegistryFile {
  version: string;
  harnesses: HarnessDescriptor[];
}

// ─── Validation ───────────────────────────────────────────────────────────────

function assertString(val: unknown, field: string): string {
  if (typeof val !== 'string') {
    throw new Error(`Invalid harness registry: "${field}" must be a string, got ${typeof val}`);
  }
  return val;
}

function assertStringArray(val: unknown, field: string): string[] {
  if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
    throw new Error(
      `Invalid harness registry: "${field}" must be string[], got ${JSON.stringify(val)}`,
    );
  }
  return val;
}

const TRUST_LEVELS = new Set([
  'reference_only',
  'read_only',
  'local_cli',
  'sandboxed',
  'privileged_external',
]);
const KINDS = new Set(['reference', 'agent_runtime', 'sandbox', 'local_cli', 'bridge']);
const TRANSPORTS = new Set(['none', 'cli', 'http', 'plugin', 'sandbox']);
const HEALTH_KINDS = new Set(['static', 'command', 'http']);
const RECOVERY_MODES = new Set([
  'copy_command',
  'tmux_attach',
  'view_logs',
  'no_recovery_available',
]);

function validateEntry(entry: unknown, id: string): HarnessDescriptor {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Invalid harness entry "${id}": must be an object`);
  }
  const e = entry as Record<string, unknown>;

  const trustLevel = assertString(e.trustLevel ?? e.trust_level, 'trustLevel');
  if (!TRUST_LEVELS.has(trustLevel)) {
    throw new Error(`Invalid harness "${id}": unknown trust_level "${trustLevel}"`);
  }

  const kind = assertString(e.kind, 'kind');
  if (!KINDS.has(kind)) {
    throw new Error(`Invalid harness "${id}": unknown kind "${kind}"`);
  }

  const transport = assertString(e.transport, 'transport');
  if (!TRANSPORTS.has(transport)) {
    throw new Error(`Invalid harness "${id}": unknown transport "${transport}"`);
  }

  const health = e.health as Record<string, unknown>;
  if (!health || typeof health !== 'object') {
    throw new Error(`Invalid harness "${id}": missing or invalid "health"`);
  }
  const healthKind = assertString(health.kind, 'health.kind');
  if (!HEALTH_KINDS.has(healthKind)) {
    throw new Error(`Invalid harness "${id}": unknown health.kind "${healthKind}"`);
  }

  const recoveryModes = assertStringArray(e.recoveryModes ?? e.recovery_modes, 'recoveryModes');
  for (const m of recoveryModes) {
    if (!RECOVERY_MODES.has(m as RecoveryMode)) {
      throw new Error(`Invalid harness "${id}": unknown recovery_mode "${m}"`);
    }
  }

  return {
    id: assertString(e.id, 'id'),
    label: assertString(e.label, 'label'),
    kind: kind as HarnessKind,
    trustLevel: trustLevel as TrustLevel,
    transport: transport as HarnessTransport,
    health: {
      kind: healthKind as HarnessHealth['kind'],
      status: health.status as string | undefined,
      command: health.command as string | undefined,
      url: health.url as string | undefined,
    },
    recoveryModes: recoveryModes as RecoveryMode[],
    allowedActions: assertStringArray(e.allowedActions ?? e.allowed_actions, 'allowedActions'),
    blockedActions: assertStringArray(e.blockedActions ?? e.blocked_actions, 'blockedActions'),
    recovery: (e.recovery as Record<string, RecoveryDescriptor> | undefined) ?? undefined,
  };
}

// ─── Load & validate ─────────────────────────────────────────────────────────

function load(): HarnessDescriptor[] {
  const data = _raw as HarnessRegistryFile;
  if (!data || !Array.isArray(data.harnesses)) {
    throw new Error('Invalid harness registry: missing or non-array "harnesses" field');
  }
  return data.harnesses.map((e) =>
    validateEntry(e, ((e as unknown as Record<string, unknown>).id as string) ?? '?'),
  );
}

let _cache: HarnessDescriptor[] | null = null;

function getAll(): HarnessDescriptor[] {
  if (!_cache) _cache = load();
  return _cache;
}

// ─── Public helpers ──────────────────────────────────────────────────────────

/** Return a single harness by id, or null if not found. */
export function getHarness(id: string): HarnessDescriptor | null {
  return getAll().find((h) => h.id === id) ?? null;
}

/** Return all registered harnesses, sorted highest→lowest trust with id tiebreaker. */
export function listHarnesses(): HarnessDescriptor[] {
  const pref = ['privileged_external', 'local_cli', 'sandboxed', 'read_only', 'reference_only'];
  return [...getAll()].sort((a, b) => {
    const levelDiff = pref.indexOf(a.trustLevel) - pref.indexOf(b.trustLevel);
    if (levelDiff !== 0) return levelDiff;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Return the harness that should execute a given command action,
 * or null if no harness explicitly allows it.
 * Strategy: find first harness where the action appears in allowedActions
 * (blockedActions are authoritative — reference_only blocks everything not in allowed).
 */
export function findHarnessForCommand(action: string): HarnessDescriptor | null {
  const candidates = getAll().filter(
    (h) => h.allowedActions.includes(action) && !h.blockedActions.includes(action),
  );
  if (candidates.length === 0) return null;
  // Prefer non-reference harnesses; within same trust level prefer capable transport
  const nonRef = candidates.filter((h) => h.trustLevel !== 'reference_only');
  const pool = nonRef.length > 0 ? nonRef : candidates;
  const pref = ['privileged_external', 'local_cli', 'sandboxed', 'read_only', 'reference_only'];
  pool.sort((a, b) => pref.indexOf(a.trustLevel) - pref.indexOf(b.trustLevel));
  return pool[0] ?? null;
}

/** Invalidate the in-memory cache (useful for testing). */
export function _resetCache(): void {
  _cache = null;
}
