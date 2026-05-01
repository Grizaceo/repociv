// ─── RepoCiv — Priority Panel UI (Phase 7b) ────────────────────────────────────
// Hotkey: P — shows the priority matrix for the local mission queue.
// Rendered as a right-side drawer in the RimWorld aesthetic.
import type { LocalMission } from '../types.ts';
import { sortByPriority, type PrioritizedMission } from '../priorityMatrix.ts';

let _panelEl: HTMLElement | null = null;

export function openPriorityPanel(missions: LocalMission[], onAssign: (missionId: string) => void) {
  const container = getOrCreatePanel();
  renderPanel(container, missions, onAssign);
  container.classList.remove('hidden');
}

export function closePriorityPanel() {
  _panelEl?.classList.add('hidden');
}

export function togglePriorityPanel(
  missions: LocalMission[],
  onAssign: (missionId: string) => void,
) {
  if (!_panelEl || _panelEl.classList.contains('hidden')) {
    openPriorityPanel(missions, onAssign);
  } else {
    closePriorityPanel();
  }
}

function getOrCreatePanel(): HTMLElement {
  if (_panelEl) return _panelEl;
  const el = document.createElement('div');
  el.id = 'priority-panel';
  el.className = 'side-panel hidden';
  document.body.appendChild(el);
  _panelEl = el;
  return el;
}

function renderPanel(
  container: HTMLElement,
  missions: LocalMission[],
  onAssign: (missionId: string) => void,
) {
  const now = Date.now();
  const sorted: PrioritizedMission[] = sortByPriority(missions, now);

  const PRIORITY_LABEL: Record<string, string> = {
    critical: 'CRIT',
    high: 'HIGH',
    normal: 'NORM',
    low: 'LOW',
  };

  const PRIORITY_COLOR: Record<string, string> = {
    critical: '#d44b4b',
    high: '#d48b4b',
    normal: '#c8a84b',
    low: '#5b9b5b',
  };

  const rows = sorted
    .map((pm) => {
      const age = Math.round((now - pm.assignedAt) / 1000);
      const ageStr = age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;
      const fileShort = pm.fileName.length > 22 ? pm.fileName.slice(0, 20) + '…' : pm.fileName;
      const statusColor =
        pm.status === 'complete'
          ? '#5b9b5b'
          : pm.status === 'walking' || pm.status === 'working'
            ? '#c8a84b'
            : '#888';
      const isDebt =
        pm.filePath.includes('/debt/') ||
        pm.filePath.includes('/legacy/') ||
        pm.filePath.includes('/stale/');
      const debtBadge = isDebt ? '<span class="badge-debt">DEBT</span>' : '';
      const testBadge =
        pm.fileName.includes('.test.') || pm.fileName.includes('.spec.')
          ? '<span class="badge-test">TEST</span>'
          : '';

      return `
      <div class="pm-row" data-mission-id="${pm.id}">
        <span class="pm-priority" style="color:${PRIORITY_COLOR[pm.priority]}">${PRIORITY_LABEL[pm.priority]}</span>
        <span class="pm-score">${pm.score.toFixed(1)}</span>
        <span class="pm-file" title="${pm.filePath}">${fileShort}</span>
        ${debtBadge}${testBadge}
        <span class="pm-status" style="color:${statusColor}">${pm.status}</span>
        <span class="pm-age">${ageStr}</span>
        ${pm.status === 'queued' ? `<button class="pm-assign-btn" data-id="${pm.id}" aria-label="Asignar misión ${pm.id}">▶</button>` : ''}
      </div>
    `;
    })
    .join('');

  container.innerHTML = `
    <div class="pm-header">
      <span class="pm-title">PRIORITY MATRIX</span>
      <span class="pm-hint">[P] close · click row to focus</span>
    </div>
    <div class="pm-columns">
      <span>P</span><span>Score</span><span>File</span><span></span><span>Status</span><span>Age</span>
    </div>
    <div class="pm-list">${rows}</div>
    <div class="pm-footer">${sorted.length} missions · sorted by urgency+age</div>
  `;

  // Attach assign-button handlers
  container.querySelectorAll<HTMLButtonElement>('.pm-assign-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (e.target as HTMLElement).dataset['id'];
      if (id) onAssign(id);
    });
  });
}
