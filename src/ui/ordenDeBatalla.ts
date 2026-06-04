// ─── Orden de batalla — subagent detachment panel ────────────────────────────
import type { GameState } from '../game.ts';
import type { Unit } from '../types.ts';
import { sortSubagentsForDisplay } from '../priorityMatrix.ts';
import { getSelectedConfig, isCursorTrackingAvailable } from './chat/modelSelector.ts';
import { isLayerVisible } from '../layers.ts';

let _highlightCb: ((unitId: string | null) => void) | null = null;

export function setOrdenHighlightCallback(cb: (unitId: string | null) => void): void {
  _highlightCb = cb;
}

function renderDiagnosticChecklist(unit: Unit): string {
  const { harness } = getSelectedConfig();
  const effectiveHarness = harness || 'auto';
  const cursorHarness = effectiveHarness === 'cursor';
  const cursorInstalled = isCursorTrackingAvailable();
  const opsOn = isLayerVisible('ops');

  const item = (ok: boolean, text: string) =>
    `<li class="orden-check ${ok ? 'orden-check--ok' : 'orden-check--todo'}">${ok ? '✓' : '○'} ${escapeHtml(text)}</li>`;

  return `
    <div class="orden-diagnostic">
      <div class="orden-diagnostic-title">Sin detachments — checklist</div>
      <ul class="orden-checklist">
        ${item(cursorHarness, 'Harness cursor seleccionado en el chat')}
        ${item(cursorInstalled, 'cursor-agent instalado (bridge /health)')}
        ${item(unit.state === 'working', 'Misión activa en esta unidad (working)')}
        ${item(true, 'Misión enviada vía RepoCiv (no solo Cursor IDE)')}
        ${item(true, 'Task con run_in_background=true en el agente')}
        ${item(opsOn, 'Capa Ops (H) activa para líneas punteadas')}
      </ul>
      <p class="orden-diagnostic-hint">Si todo está ✓ y sigue vacío, revisa el log del bridge por <code>[swarm]</code>.</p>
    </div>
  `;
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

  const rowHtml = (
    id: string,
    label: string,
    meta: string,
    status: string,
    ephemeralUnitId?: string,
  ) => {
    const peek = (state.subagentProgress.get(id) ?? []).slice(-2).join(' · ');
    return `
      <div class="orden-row" data-subagent="${id}" data-unit="${ephemeralUnitId ?? ''}">
        <span class="orden-status orden-status--${status}">${status.slice(0, 4)}</span>
        <span class="orden-label">${escapeHtml(label.slice(0, 48))}</span>
        <span class="orden-meta">${escapeHtml(meta)}</span>
        ${peek ? `<div class="orden-peek">${escapeHtml(peek)}</div>` : ''}
      </div>`;
  };

  const activeRows = active
    .map((s) =>
      rowHtml(
        s.id,
        s.label,
        `${s.kind} · ${s.risk}`,
        s.status,
        s.ephemeralUnitId,
      ),
    )
    .join('');

  const recentRows = recent
    .map((s) =>
      rowHtml(s.id, s.label, `${s.kind} · done`, s.status, s.ephemeralUnitId),
    )
    .join('');

  root.innerHTML = `
    <details class="orden-panel" open>
      <summary class="orden-title">Orden de batalla (${active.length} activos)</summary>
      ${
        showDiagnostic
          ? renderDiagnosticChecklist(unit)
          : `<div class="orden-section">
        ${activeRows || '<div class="orden-empty">Sin detachments activos</div>'}
      </div>`
      }
      ${
        recentRows
          ? `<div class="orden-recent-title">Recientes</div><div class="orden-section">${recentRows}</div>`
          : ''
      }
      <div class="orden-recall-row">
        <button type="button" class="orden-recall-btn" disabled title="Próximamente">Recall</button>
        <span class="orden-recall-hint">Cancelación real reservada para fase 6</span>
      </div>
    </details>
  `;

  root.querySelectorAll('.orden-row').forEach((el) => {
    el.addEventListener('click', () => {
      const subId = el.getAttribute('data-subagent');
      const unitId = el.getAttribute('data-unit');
      state.highlightedSubagentId = subId;
      if (unitId) _highlightCb?.(unitId);
    });
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
