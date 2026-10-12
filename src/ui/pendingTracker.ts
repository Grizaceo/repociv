// ─── RepoCiv — Pending tracker → missions bridge ─────────────────────────────
// Pending tracker items are loaded at boot so the mission badges and
// task panel still reflect real pending work.
import type { Mission } from '../game.ts';
import { bridgeUrl, bridgeHeaders } from '../bridgeEnv.ts';

export async function fetchPendingTracker(): Promise<Mission[]> {
  try {
    const res = await fetch(bridgeUrl('/pending'), { headers: bridgeHeaders() });
    if (!res.ok) return [];
    const raw = (await res.json()) as Array<{
      id: string;
      title: string;
      priority: string;
      state: string;
      stateText: string;
      detail: string;
    }>;
    return raw.map((r) => ({
      id: `pending-${r.id}`,
      unit: 'MAIN',
      questName: `[${r.id}] ${r.title}`,
      status: 'running' as const,
      startedAt: Date.now(),
      completedAt: null,
    }));
  } catch {
    return [];
  }
}
