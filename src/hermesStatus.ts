// ─── RepoCiv — Hermes reachability (Fase 1 / audit 1.1) ─────────────────────
// Frontend mirror of server/hermes_status.py. The bridge owns the
// probe + 30s cache; the UI just calls the endpoint and renders a
// banner with the affected features when Hermes is down.

import { bridgeHeaders, bridgeUrl } from './bridgeEnv.ts';

export interface HermesStatus {
  /** True iff the probe returned 2xx with a parsable model list. */
  available: boolean;
  /** The base URL that was probed (after stripping /v1[/...]). */
  url: string;
  /** Wall-clock time of the actual probe, in milliseconds. */
  latencyMs: number;
  /** Populated when available=false: "http_401", "network: ...", "parse_error: ...". */
  error: string | null;
  /** Number of models in the response body, or null when the probe failed. */
  modelCount: number | null;
  /** Unix epoch (seconds) of the most recent probe. */
  checkedAt: number;
}

/** Default value used when the bridge call itself fails (network, parse). */
const FALLBACK: HermesStatus = {
  available: false,
  url: '',
  latencyMs: 0,
  error: 'bridge_unreachable',
  modelCount: null,
  checkedAt: 0,
};

/**
 * Fetch the current Hermes status from the bridge.
 *
 * The bridge probes Hermes with a 30s cache, so polling this every
 * few seconds is fine — the actual network probe happens at most
 * once per 30s.
 *
 * Never throws. On any failure (bridge down, parse error, etc.),
 * returns a ``FALLBACK`` object with ``available: false`` and
 * ``error: 'bridge_unreachable'`` so the UI can render the banner
 * even when the bridge itself is gone.
 */
export async function checkHermesStatus(signal?: AbortSignal): Promise<HermesStatus> {
  const url = bridgeUrl('/api/hermes/status');
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: bridgeHeaders(),
      signal,
    });
  } catch (e) {
    return { ...FALLBACK, error: `bridge_unreachable: ${(e as Error).message ?? e}` };
  }
  if (!res.ok) {
    return { ...FALLBACK, error: `http_${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return { ...FALLBACK, error: `parse_error: ${(e as Error).message ?? e}` };
  }
  return normalizeHermesStatus(body);
}

/**
 * Type-coerce an unknown body into a HermesStatus. Used by both the
 * network path above and by tests that feed in fixtures directly.
 *
 * Missing fields fall back to the FALLBACK default rather than
 * throwing — the UI must always be able to render the banner.
 */
export function normalizeHermesStatus(raw: unknown): HermesStatus {
  if (!raw || typeof raw !== 'object') return { ...FALLBACK };
  const o = raw as Record<string, unknown>;
  return {
    available: o['available'] === true,
    url: typeof o['url'] === 'string' ? o['url'] : '',
    latencyMs: typeof o['latencyMs'] === 'number' ? o['latencyMs'] : 0,
    error: typeof o['error'] === 'string' ? o['error'] : null,
    modelCount: typeof o['modelCount'] === 'number' ? o['modelCount'] : null,
    checkedAt: typeof o['checkedAt'] === 'number' ? o['checkedAt'] : 0,
  };
}

/**
 * Features that depend on Hermes being up. The banner lists these
 * inline so the user knows exactly what's affected and how to fix it.
 *
 * Keep this list narrow and high-signal — every entry should be
 * something the user would notice as missing.
 */
export interface AffectedFeature {
  id: string;
  label: string;
  /** Short explanation of how the feature is degraded. */
  impact: string;
}

export function listAffectedFeatures(): readonly AffectedFeature[] {
  return [
    {
      id: 'chat',
      label: 'Chat con agentes',
      impact: 'Los agentes no pueden responder a mensajes hasta que Hermes esté disponible.',
    },
    {
      id: 'model-picker',
      label: 'Selector de modelo / provider',
      impact: 'El inventario en vivo y los health dots quedan en "unknown".',
    },
    {
      id: 'agent-spawn',
      label: 'Spawn de unidades (WORKER, SCOUT)',
      impact: 'Los harnesses que rutean via Hermes no pueden arrancar.',
    },
    {
      id: 'task-orchestrator',
      label: 'Task orchestrator + approvals',
      impact: 'Las tareas que requieren inferencia quedan en cola sin progreso.',
    },
  ];
}

/**
 * The "how to fix it" steps shown inside the banner. Self-contained
 * so the user can act without leaving the UI.
 */
export function formatActivationSteps(): readonly string[] {
  return [
    '1. Asegúrate de que Hermes esté corriendo: `cd ~/.hermes && python -m server` (o tu launcher habitual).',
    '2. Si Hermes está en otro host o puerto, setea HERMES_URL en `.env` y reinicia el bridge.',
    '3. Si usas auth, setea HERMES_KEY en `.env` y reinicia el bridge.',
    '4. Refresca esta vista (Ctrl+R) — el cache del bridge expira cada 30s.',
  ];
}
