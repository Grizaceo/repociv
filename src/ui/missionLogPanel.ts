// ─── Mission log — nested subagent tree (F10 / Enjambre tab) ─────────────────
import { bridgeUrl } from '../bridgeEnv.ts';

let _panelEl: HTMLElement | null = null;

export function initMissionLogPanel(): void {
  _panelEl = document.getElementById('mission-log-panel');
}

export async function openMissionLog(missionId: string): Promise<void> {
  if (!_panelEl) _panelEl = document.getElementById('mission-log-panel');
  if (!_panelEl) return;

  _panelEl.classList.remove('hidden');
  _panelEl.innerHTML = '<div class="ml-loading">Cargando árbol de misión…</div>';

  try {
    const res = await fetch(bridgeUrl(`/missions/${encodeURIComponent(missionId)}/tree`));
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as {
      mission?: { id?: string; agent?: string; outcome?: string };
      subagents?: Array<Record<string, string>>;
    };
    _panelEl.innerHTML = renderTree(missionId, data);
    _panelEl.querySelector('#ml-close')?.addEventListener('click', () => {
      _panelEl?.classList.add('hidden');
    });
    _panelEl.querySelectorAll('.ml-node').forEach((node) => {
      node.addEventListener('click', () => {
        const summary = node.getAttribute('data-summary');
        const detail = _panelEl?.querySelector('.ml-detail');
        if (detail) detail.textContent = summary ?? '';
      });
    });
  } catch {
    _panelEl.innerHTML = `<div class="ml-error">No se pudo cargar /missions/${missionId}/tree</div>`;
  }
}

function renderTree(
  missionId: string,
  data: {
    mission?: { id?: string; agent?: string; outcome?: string };
    subagents?: Array<Record<string, string>>;
  },
): string {
  const mission = data.mission ?? { id: missionId };
  const subs = data.subagents ?? [];
  const subRows = subs
    .map(
      (s) => `
    <div class="ml-node ml-node--child" data-summary="${esc(s.summary ?? '')}">
      <span class="ml-kind">${esc(s.kind ?? '?')}</span>
      <span class="ml-harness">${esc((s.harness ?? s.parent_harness ?? '').slice(0, 12))}</span>
      <span class="ml-label">${esc((s.label ?? s.id ?? '').slice(0, 60))}</span>
      <span class="ml-status">${esc(s.status ?? '')}</span>
    </div>`,
    )
    .join('');

  return `
    <div class="ml-header">
      <strong>Enjambre · ${esc(mission.id ?? missionId)}</strong>
      <button type="button" class="ml-close" id="ml-close">✕</button>
    </div>
    <div class="ml-root ml-node" data-summary="">
      <span class="ml-kind">mission</span>
      <span class="ml-label">${esc(mission.agent ?? 'agent')} · ${esc(mission.outcome ?? '…')}</span>
    </div>
    <div class="ml-children">${subRows || '<div class="ml-empty">Sin subagentes registrados</div>'}</div>
    <pre class="ml-detail"></pre>
  `;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
