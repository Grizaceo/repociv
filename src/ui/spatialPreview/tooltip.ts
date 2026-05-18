// ─── Drag tooltip — suggestions during drag, before drop ──────────────────
import { fetchSuggestions, cmdTypeLabel, successRateColor } from '../../directiveLearner.ts';
import { escapeHtml, positionEl } from './helpers.ts';

let _tooltipEl: HTMLElement | null = null;
let _tooltipTimer: ReturnType<typeof setTimeout> | null = null;

function _getOrCreateTooltip(): HTMLElement {
  if (_tooltipEl) return _tooltipEl;
  const el = document.createElement('div');
  el.id = 'drag-tooltip';
  el.className = 'drag-tooltip hidden';
  document.body.appendChild(el);
  _tooltipEl = el;
  return el;
}

function hideDragTooltip(): void {
  _tooltipEl?.classList.add('hidden');
}

export function showDragTooltip(
  gesture: string,
  agentId: string,
  screenPos: { x: number; y: number },
  dropTarget: { cityId?: string; cityName?: string } | undefined,
): void {
  // Debounce: don't flash on every pixel
  if (_tooltipTimer) return;
  _tooltipTimer = setTimeout(() => {
    _tooltipTimer = null;
  }, 200);

  const ctx: Record<string, string> = {};
  if (dropTarget?.cityId) {
    ctx.cityId = dropTarget.cityId;
    ctx.cityName = dropTarget.cityName ?? '';
  }

  void fetchSuggestions(gesture, agentId, ctx)
    .then((suggestions) => {
      if (suggestions.length === 0) {
        hideDragTooltip();
        return;
      }
      const el = _getOrCreateTooltip();
      el.innerHTML =
        `<div class="dt-title">Sugerencias</div>` +
        suggestions
          .slice(0, 3)
          .map((s, i) => {
            const color = successRateColor(s.successRate);
            const pct = Math.round(s.successRate * 100);
            const label = cmdTypeLabel(s.cmdType);
            return `<div class="dt-item${i === 0 ? ' dt-top' : ''}">
          <span class="dt-label">${escapeHtml(label)}</span>
          <span class="dt-rate" style="color:${color}">${pct}% (${s.count}×)</span>
        </div>`;
          })
          .join('');
      positionEl(el, screenPos);
      el.classList.remove('hidden');
    })
    .catch(() => {
      hideDragTooltip();
    });
}
