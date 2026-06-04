// ─── Orden de batalla — subagent detachment panel ────────────────────────────
import type { GameState } from '../game.ts';
import type { SubagentRun, Unit } from '../types.ts';
import { sortSubagentsForDisplay } from '../priorityMatrix.ts';
import { getSelectedConfig, isSwarmTrackingAvailable } from './chat/modelSelector.ts';
import { isLayerVisible } from '../layers.ts';
import { openSubagentSession, recallSubagent } from './subagentSessionPanel.ts';
import { appendSystemMessage } from './chat/history.ts';

let _highlightCb: ((unitId: string | null) => void) | null = null;

export function setOrdenHighlightCallback(cb: (unitId: string | null) => void): void {
  _highlightCb = cb;
}

export type OrdenDisplayStatus = 'pending' | 'working' | 'done' | 'failed' | 'cancelled';

export function displayStatus(s: SubagentRun): OrdenDisplayStatus {
  if (s.status === 'proposed') return 'pending';
  if (s.status === 'running') return 'working';
  if (s.status === 'cancelled') return 'cancelled';
  if (s.status === 'failed') return 'failed';
  return 'done';
}

function statusChipLabel(d: OrdenDisplayStatus): string {
  switch (d) {
    case 'pending':
      return 'Pendiente';
    case 'working':
      return 'Trabajando';
    case 'done':
      return 'Hecho';
    case 'failed':
      return 'Falló';
    case 'cancelled':
      return 'Recall';
  }
}

function harnessLabel(s: SubagentRun): string {
  return (s.harness ?? s.parentHarness ?? '').slice(0, 16);
}

function renderDiagnosticChecklist(unit: Unit): string {
  const { harness } = getSelectedConfig();
  const effectiveHarness = harness && harness !== 'auto' ? harness : 'auto';
  const trackingHarness =
    effectiveHarness === 'auto' ? 'cursor o claude-code' : effectiveHarness;
  const trackingOk =
    effectiveHarness === 'auto'
      ? isSwarmTrackingAvailable('cursor') || isSwarmTrackingAvailable('claude-code')
      : isSwarmTrackingAvailable(effectiveHarness);
  const opsOn = isLayerVisible('ops');

  const item = (ok: boolean, text: string) =>
    `<li class="orden-check ${ok ? 'orden-check--ok' : 'orden-check--todo'}">${ok ? '✓' : '○'} ${escapeHtml(text)}</li>`;

  return `
    <div class="orden-diagnostic">
      <div class="orden-diagnostic-title">Sin detachments — checklist</div>
      <ul class="orden-checklist">
        ${item(trackingOk, `Harness del padre soporta tracking (${trackingHarness})`)}
        ${item(unit.state === 'working', 'Misión activa en esta unidad (working)')}
        ${item(true, 'Misión enviada vía RepoCiv (no solo Cursor IDE)')}
        ${item(true, 'Task con run_in_background=true en el agente')}
        ${item(opsOn, 'Capa Ops (H) activa para líneas punteadas')}
      </ul>
      <p class="orden-diagnostic-hint">Badge Swarm en el chat indica tracking por harness. Log bridge: <code>[swarm]</code>.</p>
    </div>
  `;
}

export function bindOrdenDeBatalla(state: GameState): void {
  state.subscribe(() => {
    if (state.selectedUnit) renderOrdenDeBatalla(state, state.selectedUnit);
  });
}

export function renderOrdenDeBatalla(state: GameState, unit: Unit): void {
  const root = document.getElementById('orden-de-batalla');
  if (!root) return;
  const active = sortSubagentsForDisplay(state.getSubagentsOfUnit(unit.id));
  const recent = state.completedSubagents
    .filter((s) => s.parentUnitId === unit.id)
    .slice(0, 10);

  const showDiagnostic =
    active.length === 0 && recent.length === 0 && unit.state === 'working';

  if (active.length === 0 && recent.length === 0 && !showDiagnostic) {
    root.classList.add('hidden');
    root.innerHTML = '';
    return;
  }

  root.classList.remove('hidden');

  const rowHtml = (s: SubagentRun, recentRow = false) => {
    const d = displayStatus(s);
    const peekLines = (state.subagentProgress.get(s.id) ?? []).slice(-2);
    const subtitle =
      peekLines.length > 0 ? peekLines[peekLines.length - 1] : s.label;
    const h = harnessLabel(s);
    const meta = h ? `${s.kind} · ${s.risk} · ${h}` : `${s.kind} · ${s.risk}`;
    return `
      <div class="orden-row" data-subagent="${s.id}" data-unit="${s.ephemeralUnitId ?? ''}">
        <span class="orden-status orden-status--${d}">${statusChipLabel(d)}</span>
        <span class="orden-label">${escapeHtml((recentRow ? s.label : subtitle).slice(0, 48))}</span>
        <span class="orden-meta">${escapeHtml(meta)}</span>
        ${peekLines.length && !recentRow ? `<div class="orden-peek">${escapeHtml(peekLines.join(' · '))}</div>` : ''}
      </div>`;
  };

  const activeRows = active.map((s) => rowHtml(s)).join('');
  const recentRows = recent.map((s) => rowHtml(s, true)).join('');
  const highlightId = state.highlightedSubagentId;
  const recallTarget =
    highlightId && active.some((s) => s.id === highlightId && s.status === 'running')
      ? highlightId
      : active.find((s) => s.status === 'running')?.id;
  const canRecall = !!recallTarget;

  root.innerHTML = `
    <details class="orden-panel" open>
      <summary class="orden-title">Orden de batalla (${active.length} activos)</summary>
      ${
        active.length > 0
          ? `<div class="orden-section orden-section--active" aria-live="polite">${activeRows}</div>`
          : ''
      }
      ${showDiagnostic ? renderDiagnosticChecklist(unit) : ''}
      ${
        recentRows
          ? `<div class="orden-recent-title">Recientes</div><div class="orden-section">${recentRows}</div>`
          : ''
      }
      <div class="orden-recall-row">
        <button type="button" class="orden-recall-btn" ${canRecall ? '' : 'disabled'} data-recall="${recallTarget ?? ''}" title="Cancelar subagente en ejecución">Recall</button>
        <button type="button" class="orden-session-btn" data-session="${highlightId ?? active[0]?.id ?? recent[0]?.id ?? ''}" title="Ver sesión (Alt+↑)">Sesión</button>
        <span class="orden-recall-hint">${canRecall ? 'Recall · /subagent · Alt+↑' : 'Selecciona fila activa para Recall'}</span>
      </div>
    </details>
  `;

  root.querySelectorAll('.orden-row').forEach((el) => {
    el.classList.toggle('orden-row--selected', el.getAttribute('data-subagent') === highlightId);
    el.addEventListener('click', () => {
      const subId = el.getAttribute('data-subagent');
      const unitId = el.getAttribute('data-unit');
      state.highlightedSubagentId = subId;
      if (unitId) _highlightCb?.(unitId);
      renderOrdenDeBatalla(state, unit);
    });
    el.addEventListener('dblclick', () => {
      const subId = el.getAttribute('data-subagent');
      if (subId) openSubagentSession(subId);
    });
  });

  root.querySelector('.orden-recall-btn')?.addEventListener('click', async () => {
    const sid = root.querySelector<HTMLButtonElement>('.orden-recall-btn')?.dataset['recall'];
    if (!sid) return;
    const result = await recallSubagent(sid);
    appendSystemMessage(unit.id, result.ok ? `✓ Recall: ${result.message}` : `❌ Recall: ${result.message}`);
  });

  root.querySelector('.orden-session-btn')?.addEventListener('click', () => {
    const sid = root.querySelector<HTMLButtonElement>('.orden-session-btn')?.dataset['session'];
    if (sid) openSubagentSession(sid);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function hideOrdenDeBatalla(): void {
  const root = document.getElementById('orden-de-batalla');
  if (root) {
    root.classList.add('hidden');
    root.innerHTML = '';
  }
}
