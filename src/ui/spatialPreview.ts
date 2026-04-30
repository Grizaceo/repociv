// ─── RepoCiv — Spatial Preview & Context Menu (Fase 5) ───────────────────────
// Shows a confirmation card before any spatial gesture executes.
// Principle: no irreversible action from an accidental gesture.

import type { SpatialDirective, ContextMenuItem } from '../spatialDirectives.ts';
import type { CommandDraft } from '../commandSchema.ts';
import { COMMAND_RISK } from '../commandSchema.ts';
import { fetchSuggestions, cmdTypeLabel, successRateColor } from '../directiveLearner.ts';

// ─── Callbacks ────────────────────────────────────────────────────────────────
type ConfirmCb = (draft: CommandDraft) => void;
type CancelCb  = () => void;

// ─── Preview card ─────────────────────────────────────────────────────────────
let _previewEl: HTMLElement | null = null;
let _menuEl:    HTMLElement | null = null;

export function showDirectivePreview(
  directive: SpatialDirective,
  screenPos: { x: number; y: number },
  onConfirm: ConfirmCb,
  onCancel:  CancelCb,
) {
  hideDirectivePreview();
  hideContextMenu();

  const el = _getOrCreatePreview();
  const risk = COMMAND_RISK[directive.draft.type as keyof typeof COMMAND_RISK] ?? 'medium';
  const [riskColor, riskLabel] = _riskStyle(risk);
  const pct = Math.round(directive.confidence * 100);
  const needsApproval = risk === 'high' || risk === 'destructive';

  // "Nueva misión…" prompt: if promptUser in payload, show input
  const isPrompt = directive.draft.payload?.['promptUser'] === true;

  el.innerHTML = `
    <div class="sp-arrow"></div>
    <div class="sp-header">
      <span class="sp-gesture">${_gestureIcon(directive.gesture)}</span>
      <span class="sp-label">${_esc(directive.label)}</span>
      <span class="sp-conf" title="Confianza de interpretación">${pct}%</span>
    </div>
    <div class="sp-cmd">
      <span class="sp-cmd-type">${_esc(directive.draft.type)}</span>
      <span class="sp-risk" style="color:${riskColor}">${riskLabel}</span>
    </div>
    ${needsApproval ? '<div class="sp-approval-warn">⚠ Requiere aprobación manual</div>' : ''}
    ${isPrompt ? `
      <div class="sp-prompt-row">
        <input id="sp-mission-input" class="sp-input" type="text"
          placeholder="Describir misión…" autocomplete="off" />
      </div>` : ''}
    <div class="sp-actions">
      <button id="sp-confirm" class="sp-btn-confirm">✔ Confirmar</button>
      <button id="sp-cancel"  class="sp-btn-cancel">✗ Cancelar</button>
    </div>
    <div id="sp-suggestions" class="sp-suggestions"></div>
  `;

  _position(el, screenPos);
  el.classList.remove('hidden');

  // Async-fetch suggestions and inject if available (non-blocking)
  const agentId = String(directive.draft.payload?.['unit'] ?? 'DAVI');
  void fetchSuggestions(directive.gesture, agentId).then(suggestions => {
    const box = el.querySelector<HTMLElement>('#sp-suggestions');
    if (!box || suggestions.length === 0) return;
    box.innerHTML = `<div class="sp-sug-title">RepoCiv sugiere:</div>` +
      suggestions.map(s => {
        const color = successRateColor(s.successRate);
        const pctS  = Math.round(s.successRate * 100);
        return `<div class="sp-sug-item" data-type="${_esc(s.cmdType)}">
          <span class="sp-sug-label">${_esc(cmdTypeLabel(s.cmdType))}</span>
          <span class="sp-sug-rate" style="color:${color}">${pctS}% (${s.count}×)</span>
        </div>`;
      }).join('');
    // Clicking a suggestion swaps the draft type label (card still requires confirm)
    box.querySelectorAll<HTMLElement>('.sp-sug-item').forEach(item => {
      item.addEventListener('click', () => {
        const t = item.dataset['type'];
        if (t) {
          directive.draft = { ...directive.draft, type: t as never };
          el.querySelector('.sp-cmd-type')!.textContent = t;
          box.querySelectorAll('.sp-sug-item').forEach(i => i.classList.remove('sp-sug-active'));
          item.classList.add('sp-sug-active');
        }
      });
    });
  });

  // Focus prompt input if present
  const inp = el.querySelector<HTMLInputElement>('#sp-mission-input');
  if (inp) {
    inp.focus();
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        directive.draft.payload = { ...directive.draft.payload, mission: inp.value };
        _confirm(directive.draft, onConfirm, onCancel);
      }
      if (e.key === 'Escape') { hideDirectivePreview(); onCancel(); }
    });
  }

  el.querySelector('#sp-confirm')?.addEventListener('click', () => {
    if (inp) directive.draft.payload = { ...directive.draft.payload, mission: inp.value };
    _confirm(directive.draft, onConfirm, onCancel);
  });
  el.querySelector('#sp-cancel')?.addEventListener('click', () => {
    hideDirectivePreview();
    onCancel();
  });
}

function _confirm(draft: CommandDraft, onConfirm: ConfirmCb, onCancel: CancelCb) {
  hideDirectivePreview();
  onConfirm(draft);
  void onCancel; // unused but symmetrical
}

export function hideDirectivePreview() {
  _previewEl?.classList.add('hidden');
}

// ─── Context menu ─────────────────────────────────────────────────────────────
export function showContextMenu(
  items: ContextMenuItem[],
  screenPos: { x: number; y: number },
  onSelect: (draft: CommandDraft) => void,
) {
  hideContextMenu();
  hideDirectivePreview();

  const el = _getOrCreateMenu();
  el.innerHTML = items.map((item, i) => {
    const [riskColor] = _riskStyle(item.risk);
    return `
      <div class="cm-item" data-idx="${i}" tabindex="0">
        <span class="cm-icon">${_esc(item.icon)}</span>
        <span class="cm-label">${_esc(item.label)}</span>
        ${item.hotkey ? `<kbd class="cm-hotkey">${_esc(item.hotkey)}</kbd>` : ''}
        <span class="cm-risk-dot" style="background:${riskColor}" title="${item.risk}"></span>
      </div>
    `;
  }).join('');

  _position(el, screenPos);
  el.classList.remove('hidden');

  el.querySelectorAll<HTMLElement>('.cm-item').forEach((row, i) => {
    row.addEventListener('click', () => {
      const item = items[i]!;
      hideContextMenu();
      // If prompt: show preview instead of direct send
      if (item.draft.payload?.['promptUser']) {
        showDirectivePreview(
          {
            gesture: 'right_click', sourceCoord: { q: 0, r: 0 },
            shiftHeld: false, draft: item.draft,
            label: item.label, confidence: 1, userConfirmed: false,
          },
          screenPos, onSelect, () => {},
        );
      } else {
        onSelect(item.draft);
      }
    });
  });

  // Close on click outside
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) {
        hideContextMenu();
        document.removeEventListener('mousedown', close);
      }
    };
    document.addEventListener('mousedown', close);
  }, 50);
}

export function hideContextMenu() {
  _menuEl?.classList.add('hidden');
}

// ─── Drag ghost overlay on canvas ────────────────────────────────────────────
// Called by Renderer on each frame while dragging a unit.
export function renderDragGhost(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  unitColor: string,
  unitLabel: string,
) {
  ctx.save();
  ctx.globalAlpha = 0.65;
  ctx.beginPath();
  ctx.arc(screenX, screenY, 18, 0, Math.PI * 2);
  ctx.fillStyle = unitColor;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(unitLabel[0] ?? '?', screenX, screenY);
  ctx.restore();
}

// ─── Area-select rubber band overlay ─────────────────────────────────────────
export function renderAreaSelect(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  ctx.save();
  ctx.strokeStyle = '#c8a84b';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = 'rgba(200,168,75,0.08)';
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// ─── Hex highlight for drag target ────────────────────────────────────────────
export function renderDropTarget(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, size: number,
  valid: boolean,
) {
  ctx.save();
  ctx.strokeStyle = valid ? '#5b9b5b' : '#d45b5b';
  ctx.lineWidth = 3;
  ctx.shadowColor = valid ? '#5b9b5b' : '#d45b5b';
  ctx.shadowBlur = 12;
  _hexPath(ctx, cx, cy, size);
  ctx.stroke();
  ctx.restore();
}

function _hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    const x = cx + size * Math.cos(a);
    const y = cy + size * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────
function _getOrCreatePreview(): HTMLElement {
  if (_previewEl) return _previewEl;
  const el = document.createElement('div');
  el.id = 'spatial-preview';
  el.className = 'sp-card hidden';
  document.body.appendChild(el);
  _previewEl = el;
  return el;
}

function _getOrCreateMenu(): HTMLElement {
  if (_menuEl) return _menuEl;
  const el = document.createElement('div');
  el.id = 'context-menu';
  el.className = 'cm-menu hidden';
  document.body.appendChild(el);
  _menuEl = el;
  return el;
}

function _position(el: HTMLElement, pos: { x: number; y: number }) {
  // Show near cursor, nudge to stay in viewport
  el.style.position = 'fixed';
  el.style.left = '0';
  el.style.top  = '0';
  el.style.visibility = 'hidden';
  el.classList.remove('hidden');

  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const MARGIN = 12;

  let x = pos.x + 16;
  let y = pos.y - rect.height / 2;
  if (x + rect.width  > vw - MARGIN) x = pos.x - rect.width - 16;
  if (y + rect.height > vh - MARGIN) y = vh - rect.height - MARGIN;
  if (y < MARGIN) y = MARGIN;

  el.style.left = `${x}px`;
  el.style.top  = `${y}px`;
  el.style.visibility = 'visible';
}

function _gestureIcon(g: string): string {
  if (g === 'drag_unit_to_city')  return '→';
  if (g === 'drag_city_to_city')  return '⇌';
  if (g === 'area_select')        return '▣';
  if (g === 'right_click')        return '◈';
  return '⬡';
}

function _riskStyle(risk: string): [string, string] {
  if (risk === 'destructive') return ['#d44b4b', '☠ DESTRUCTIVO'];
  if (risk === 'high')        return ['#e8a040', '⚠ ALTO'];
  if (risk === 'medium')      return ['#c8a84b', '◆ MEDIO'];
  return ['#5b9b5b', '● BAJO'];
}

// ─── Drag tooltip (Fase 9) — suggestions during drag, before drop ──────────
let _tooltipEl: HTMLElement | null = null;
let _tooltipTimer: ReturnType<typeof setTimeout> | null = null;

export function showDragTooltip(
  gesture: string,
  agentId: string,
  screenPos: { x: number; y: number },
  dropTarget: { cityId?: string; cityName?: string } | undefined,
) {
  // Debounce: don't flash on every pixel
  if (_tooltipTimer) return;
  _tooltipTimer = setTimeout(() => { _tooltipTimer = null; }, 200);

  const ctx: Record<string, string> = {};
  if (dropTarget?.cityId) {
    ctx.cityId = dropTarget.cityId;
    ctx.cityName = dropTarget.cityName ?? '';
  }

  void fetchSuggestions(gesture, agentId, ctx).then(suggestions => {
    if (suggestions.length === 0) {
      hideDragTooltip();
      return;
    }
    const el = _getOrCreateTooltip();
    el.innerHTML = `<div class="dt-title">Sugerencias</div>` +
      suggestions.slice(0, 3).map((s, i) => {
        const color = successRateColor(s.successRate);
        const pct  = Math.round(s.successRate * 100);
        const label = cmdTypeLabel(s.cmdType);
        return `<div class="dt-item${i === 0 ? ' dt-top' : ''}">
          <span class="dt-label">${_esc(label)}</span>
          <span class="dt-rate" style="color:${color}">${pct}% (${s.count}×)</span>
        </div>`;
      }).join('');
    _position(el, screenPos);
    el.classList.remove('hidden');
  }).catch(() => { hideDragTooltip(); });
}

export function hideDragTooltip() {
  _tooltipEl?.classList.add('hidden');
}

function _getOrCreateTooltip(): HTMLElement {
  if (_tooltipEl) return _tooltipEl;
  const el = document.createElement('div');
  el.id = 'drag-tooltip';
  el.className = 'drag-tooltip hidden';
  document.body.appendChild(el);
  _tooltipEl = el;
  return el;
}

function _esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}
