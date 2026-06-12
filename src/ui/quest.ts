// ─── RepoCiv — Quest Board ────────────────────────────────────────────────────
import type { GameState, Mission } from '../game.ts';
import { bridgeUrl, bridgeHeaders } from '../bridgeEnv.ts';
import { trapFocus } from './focusTrap.ts';
import { DEFAULT_UNIT_NAME } from '../agentIdentity.ts';

let questFilter: 'all' | 'running' | 'complete' | 'failed' = 'all';
let _questCleanup: (() => void) | null = null;

export function openQuestBoard(state: GameState) {
  const panel = document.getElementById('quest-board');
  panel?.classList.remove('hidden');
  if (panel) {
    _questCleanup?.();
    _questCleanup = trapFocus(panel);
  }
  renderQuestBoard(state);
}

export function closeQuestBoard() {
  _questCleanup?.();
  _questCleanup = null;
  document.getElementById('quest-board')?.classList.add('hidden');
}

export function isQuestBoardOpen(): boolean {
  return !document.getElementById('quest-board')?.classList.contains('hidden');
}

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
      unit: DEFAULT_UNIT_NAME,
      questName: `[${r.id}] ${r.title}`,
      status: 'running' as const,
      startedAt: Date.now(),
      completedAt: null,
    }));
  } catch {
    return [];
  }
}

export async function fetchPersistedMissions(): Promise<Mission[]> {
  try {
    const res = await fetch(bridgeUrl('/missions'), { headers: bridgeHeaders() });
    if (!res.ok) return [];
    const raw = (await res.json()) as Array<{
      id: string;
      unit: string;
      questName: string;
      status: string;
      startedAt: number;
      completedAt: number | null;
    }>;
    return raw.map((r) => ({
      id: r.id,
      unit: r.unit,
      questName: r.questName,
      status: r.status as Mission['status'],
      startedAt: r.startedAt * 1000,
      completedAt: r.completedAt ? r.completedAt * 1000 : null,
    }));
  } catch {
    return [];
  }
}

export function renderQuestBoard(state: GameState, persisted: Mission[] = []) {
  const list = document.getElementById('quest-list');
  if (!list) return;
  const map = new Map<string, Mission>();
  for (const m of persisted) map.set(m.id, m);
  for (const m of state.missions.values()) map.set(m.id, m);
  let missions = Array.from(map.values()).sort((a, b) => b.startedAt - a.startedAt);
  if (questFilter !== 'all') missions = missions.filter((m) => m.status === questFilter);
  if (missions.length === 0) {
    list.innerHTML =
      '<div class="quest-empty">No hay misiones aún. Selecciona un héroe y dale una misión.</div>';
    return;
  }
  list.innerHTML = missions
    .map((m) => {
      const dur = m.completedAt
        ? Math.round((m.completedAt - m.startedAt) / 1000) + 's'
        : Math.round((Date.now() - m.startedAt) / 1000) + 's…';
      const when = new Date(m.startedAt).toLocaleString('es-CL', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
      });
      return `
      <div class="quest-item">
        <span class="quest-status ${m.status}"></span>
        <div>
          <div class="quest-name">${escapeHtml(m.questName)}</div>
          <div class="quest-meta">${escapeHtml(m.unit)} · ${when} · ${dur}${m.simulated ? ' · <span title="Misión simulada (bridge offline)">🎭 sim</span>' : ''}</div>
        </div>
        <div class="quest-meta">${m.status}</div>
      </div>
    `;
    })
    .join('');
}

export function wireQuestBoardTabs(state: GameState) {
  document.querySelectorAll<HTMLElement>('.quest-tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      document.querySelectorAll('.quest-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      questFilter = tab.dataset['filter'] as typeof questFilter;
      const persisted = await fetchPersistedMissions();
      renderQuestBoard(state, persisted);
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
