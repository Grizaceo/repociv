// ─── RepoCiv — Local Spatial Preview & Context Menu ─────────────────────────
// Floating DOM panels for the local (RimWorld) view.
// Pattern copied from spatialPreview.ts but tailored for grid interactions.

import type { LocalUnit, Workbench } from '../types.ts';

// ─── Tooltip elements ─────────────────────────────────────────────────────────
let _unitTooltipEl: HTMLElement | null = null;
let _wbTooltipEl: HTMLElement | null = null;
let _menuEl: HTMLElement | null = null;
let _previewEl: HTMLElement | null = null;
let _gitPanelEl: HTMLElement | null = null;

// ─── Unit tooltip ─────────────────────────────────────────────────────────────
export function showLocalUnitTooltip(unit: LocalUnit, screenPos: { x: number; y: number }) {
  const el = _getOrCreate(_unitTooltipEl, 'local-unit-tooltip', 'lt-tooltip');
  _unitTooltipEl = el;

  const roomLabel = unit.currentRoomId
    ? (unit.currentRoomId.split('/').pop() ?? unit.currentRoomId)
    : '—';
  const status: Record<string, string> = {
    idle_in_room: 'Idle',
    walking_to_workbench: 'Caminando → banco',
    walking_to_room: 'Caminando → sala',
    working_on_file: 'Trabajando',
    resting: 'Descansando',
  };

  el.innerHTML = `
    <div class="lt-arrow"></div>
    <div class="lt-header" style="color:${unit.color}">${unit.name}</div>
    <div class="lt-row">En: <b>${roomLabel}</b></div>
    <div class="lt-row">Estado: ${status[unit.state] ?? unit.state}</div>
    ${unit.currentWorkbenchId ? '<div class="lt-row">Archivo: ' + (unit.mission ?? '—') + '</div>' : ''}
  `;
  _position(el, screenPos);
  el.classList.remove('hidden');
}

export function hideLocalUnitTooltip() {
  _unitTooltipEl?.classList.add('hidden');
}

// ─── Workbench tooltip ────────────────────────────────────────────────────────
export function showLocalWorkbenchTooltip(wb: Workbench, screenPos: { x: number; y: number }) {
  const el = _getOrCreate(_wbTooltipEl, 'local-wb-tooltip', 'lt-tooltip');
  _wbTooltipEl = el;

  el.innerHTML = `
    <div class="lt-arrow"></div>
    <div class="lt-header">${_esc(wb.fileName)}</div>
    <div class="lt-row">Ext: <b>.${_esc(wb.extension)}</b></div>
    ${wb.isTest ? '<div class="lt-row" style="color:#c8a84b">🧪 Test file</div>' : ''}
  `;
  _position(el, screenPos);
  el.classList.remove('hidden');
}

export function hideLocalWorkbenchTooltip() {
  _wbTooltipEl?.classList.add('hidden');
}

// ─── Context menu (Gizmo) ─────────────────────────────────────────────────────
export type LocalMenuAction = string; // 'DAVI' | 'WORKER' | 'git' | 'code' | 'info'

export function showLocalContextMenu(
  wb: Workbench,
  idleAgents: Array<{ id: string; name: string; type: string }>,
  screenPos: { x: number; y: number },
  onSelect: (action: LocalMenuAction) => void,
) {
  hideLocalContextMenu();
  hideLocalMissionPreview();

  const el = _getOrCreate(_menuEl, 'local-context-menu', 'lt-menu');
  _menuEl = el;

  const items: string[] = [];

  // Agent dispatch items (only if idle agents exist)
  const dav = idleAgents.find((a) => a.id === 'DAVI' || a.name === 'DAVI');
  const wrk = idleAgents.find((a) => a.type === 'worker');

  items.push(`
    <div class="lt-item${dav ? '' : ' lt-disabled'}" data-action="DAVI">
      <span class="lt-icon">🧑‍🔧</span> Enviar DAVI
    </div>`);
  items.push(`
    <div class="lt-item${wrk ? '' : ' lt-disabled'}" data-action="WORKER">
      <span class="lt-icon">👷</span> Enviar WORKER
    </div>`);
  items.push(`
    <div class="lt-sep"></div>
    <div class="lt-item" data-action="git">
      <span class="lt-icon">📜</span> Ver git
    </div>`);
  items.push(`
    <div class="lt-item" data-action="code">
      <span class="lt-icon">👁️</span> Ver código
    </div>`);
  items.push(`
    <div class="lt-item" data-action="info">
      <span class="lt-icon">📋</span> Ver info
    </div>`);

  el.innerHTML =
    `
    <div class="lt-header">${_esc(wb.fileName)}</div>
    <div class="lt-arrow"></div>` + items.join('');
  _position(el, screenPos);
  el.classList.remove('hidden');

  el.querySelectorAll<HTMLElement>('.lt-item').forEach((row) => {
    if (row.classList.contains('lt-disabled')) return;
    row.addEventListener('click', () => {
      const action = row.dataset['action'] ?? '';
      hideLocalContextMenu();
      onSelect(action);
    });
  });

  // Close on click outside
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) {
        hideLocalContextMenu();
        document.removeEventListener('mousedown', close);
      }
    };
    document.addEventListener('mousedown', close);
  }, 50);
}


// ─── Mission confirmation preview ─────────────────────────────────────────────
export function showLocalMissionPreview(
  agentName: string,
  fileName: string,
  screenPos: { x: number; y: number },
  onConfirm: () => void,
  onCancel: () => void,
) {
  hideLocalMissionPreview();
  hideLocalContextMenu();

  const el = _getOrCreate(_previewEl, 'local-mission-preview', 'lt-preview');
  _previewEl = el;

  el.innerHTML = `
    <div class="lt-arrow"></div>
    <div class="lt-header">¿Enviar ${agentName} a ${_esc(fileName)}?</div>
    <div class="lt-actions">
      <button id="lt-confirm" class="lt-btn-confirm">✔ Confirmar</button>
      <button id="lt-cancel" class="lt-btn-cancel">✗ Cancelar</button>
    </div>
  `;
  _position(el, screenPos);
  el.classList.remove('hidden');

  el.querySelector('#lt-confirm')?.addEventListener('click', () => {
    hideLocalMissionPreview();
    onConfirm();
  });
  el.querySelector('#lt-cancel')?.addEventListener('click', () => {
    hideLocalMissionPreview();
    onCancel();
  });
}


// ─── Git panel for a single file ──────────────────────────────────────────────
export async function showGitForFile(
  repoId: string,
  filePath: string,
  screenPos: { x: number; y: number },
) {
  hideLocalContextMenu();

  const el = _getOrCreate(_gitPanelEl, 'local-git-panel', 'lt-git-panel');
  _gitPanelEl = el;

  // Show loading immediately
  el.innerHTML = `
    <div class="lt-arrow"></div>
    <div class="lt-header">📜 ${_esc(filePath.split('/').pop() ?? filePath)}</div>
    <div class="lt-git-body"><span class="lt-loading">Cargando git…</span></div>
  `;
  _position(el, screenPos);
  el.classList.remove('hidden');

  try {
    const res = await fetch(
      `/api/git/${encodeURIComponent(repoId)}?file=${encodeURIComponent(filePath)}`,
    );
    if (!res.ok) throw new Error('git fetch failed');
    const data = (await res.json()) as {
      log?: string[];
      blame?: Array<{ line: number; author: string; date: string }>;
    };

    const logHtml = (data.log ?? []).length
      ? `<div class="lt-git-section"><h5>Commits recientes</h5>${data.log!.map((l) => `<div class="lt-git-line">${_esc(l)}</div>`).join('')}</div>`
      : '';
    const blameHtml = (data.blame ?? []).length
      ? `<div class="lt-git-section"><h5>Blame (primeras líneas)</h5>${data.blame!.map((b) => `<div class="lt-git-line"><span class="lt-git-num">${b.line}</span> ${_esc(b.author)} · ${_esc(b.date)}</div>`).join('')}</div>`
      : '';

    el.querySelector('.lt-git-body')!.innerHTML =
      logHtml + blameHtml || '<div class="lt-git-empty">Sin historial git.</div>';
  } catch {
    el.querySelector('.lt-git-body')!.innerHTML =
      '<div class="lt-git-empty">No se pudo cargar git.</div>';
  }

  // Close on click outside
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) {
        el.classList.add('hidden');
        document.removeEventListener('mousedown', close);
      }
    };
    document.addEventListener('mousedown', close);
  }, 50);
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────
function _getOrCreate(ref: HTMLElement | null, id: string, cls: string): HTMLElement {
  if (ref) return ref;
  const el = document.createElement('div');
  el.id = id;
  el.className = `${cls} hidden`;
  document.body.appendChild(el);
  return el;
}

function _position(el: HTMLElement, pos: { x: number; y: number }) {
  el.style.position = 'fixed';
  el.style.left = '0';
  el.style.top = '0';
  el.style.visibility = 'hidden';
  el.classList.remove('hidden');

  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const MARGIN = 12;

  let x = pos.x + 16;
  let y = pos.y - rect.height / 2;
  if (x + rect.width > vw - MARGIN) x = pos.x - rect.width - 16;
  if (y + rect.height > vh - MARGIN) y = vh - rect.height - MARGIN;
  if (y < MARGIN) y = MARGIN;

  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.visibility = 'visible';
}

function _esc(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
