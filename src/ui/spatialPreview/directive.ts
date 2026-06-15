// ─── Directive confirmation card + right-click context menu ────────────────
import type { SpatialDirective, ContextMenuItem } from '../../spatialDirectives.ts';
import type { CommandDraft } from '../../commandSchema.ts';
import { COMMAND_RISK } from '../../commandSchema.ts';
import { fetchSuggestions, cmdTypeLabel, successRateColor } from '../../directiveLearner.ts';
import { escapeHtml, positionEl, gestureIcon, riskStyle } from './helpers.ts';

type ConfirmCb = (draft: CommandDraft) => void;
type CancelCb = () => void;

let _previewEl: HTMLElement | null = null;
let _menuEl: HTMLElement | null = null;

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

function _confirm(draft: CommandDraft, onConfirm: ConfirmCb, onCancel: CancelCb): void {
  hideDirectivePreview();
  onConfirm(draft);
  void onCancel; // unused but symmetrical
}

export function showDirectivePreview(
  directive: SpatialDirective,
  screenPos: { x: number; y: number },
  onConfirm: ConfirmCb,
  onCancel: CancelCb,
): void {
  hideDirectivePreview();
  hideContextMenu();

  const el = _getOrCreatePreview();
  const risk = COMMAND_RISK[directive.draft.type as keyof typeof COMMAND_RISK] ?? 'medium';
  const [riskColor, riskLabel] = riskStyle(risk);
  const pct = Math.round(directive.confidence * 100);
  const needsApproval = risk === 'high' || risk === 'destructive';

  // "Nueva misión…" prompt: if promptUser in payload, show input
  const isPrompt = directive.draft.payload?.['promptUser'] === true;

  el.innerHTML = `
    <div class="sp-arrow"></div>
    <div class="sp-header">
      <span class="sp-gesture">${gestureIcon(directive.gesture)}</span>
      <span class="sp-label">${escapeHtml(directive.label)}</span>
      <span class="sp-conf" title="Confianza de interpretación">${pct}%</span>
    </div>
    <div class="sp-cmd">
      <span class="sp-cmd-type">${escapeHtml(directive.draft.type)}</span>
      <span class="sp-risk" style="color:${riskColor}">${riskLabel}</span>
    </div>
    ${needsApproval ? '<div class="sp-approval-warn">⚠ Requiere aprobación manual</div>' : ''}
    ${
      isPrompt
        ? `
      <div class="sp-prompt-row">
        <input id="sp-mission-input" class="sp-input" type="text"
          placeholder="Describir misión…" autocomplete="off" />
      </div>`
        : ''
    }
    <div class="sp-actions">
      <button id="sp-confirm" class="sp-btn-confirm" aria-label="Confirmar acción">✔ Confirmar</button>
      <button id="sp-cancel"  class="sp-btn-cancel" aria-label="Cancelar acción">✗ Cancelar</button>
    </div>
    <div id="sp-suggestions" class="sp-suggestions"></div>
  `;

  positionEl(el, screenPos);
  el.classList.remove('hidden');

  // Async-fetch suggestions and inject if available (non-blocking)
  const agentId = String(directive.draft.payload?.['unit'] ?? 'MAIN');
  void fetchSuggestions(directive.gesture, agentId).then((suggestions) => {
    const box = el.querySelector<HTMLElement>('#sp-suggestions');
    if (!box || suggestions.length === 0) return;
    box.innerHTML =
      `<div class="sp-sug-title">RepoCiv sugiere:</div>` +
      suggestions
        .map((s) => {
          const color = successRateColor(s.successRate);
          const pctS = Math.round(s.successRate * 100);
          return `<div class="sp-sug-item" data-type="${escapeHtml(s.cmdType)}">
          <span class="sp-sug-label">${escapeHtml(cmdTypeLabel(s.cmdType))}</span>
          <span class="sp-sug-rate" style="color:${color}">${pctS}% (${s.count}×)</span>
        </div>`;
        })
        .join('');
    // Clicking a suggestion swaps the draft type label (card still requires confirm)
    box.querySelectorAll<HTMLElement>('.sp-sug-item').forEach((item) => {
      item.addEventListener('click', () => {
        const t = item.dataset['type'];
        if (t) {
          directive.draft = { ...directive.draft, type: t as never };
          el.querySelector('.sp-cmd-type')!.textContent = t;
          box.querySelectorAll('.sp-sug-item').forEach((i) => i.classList.remove('sp-sug-active'));
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
      if (e.key === 'Escape') {
        hideDirectivePreview();
        onCancel();
      }
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

export function hideDirectivePreview(): void {
  _previewEl?.classList.add('hidden');
}

export function showContextMenu(
  items: ContextMenuItem[],
  screenPos: { x: number; y: number },
  onSelect: (draft: CommandDraft) => void,
): void {
  hideContextMenu();
  hideDirectivePreview();

  const el = _getOrCreateMenu();
  el.innerHTML = items
    .map((item, i) => {
      const [riskColor] = riskStyle(item.risk);
      return `
      <div class="cm-item" data-idx="${i}" tabindex="0">
        <span class="cm-icon">${escapeHtml(item.icon)}</span>
        <span class="cm-label">${escapeHtml(item.label)}</span>
        ${item.hotkey ? `<kbd class="cm-hotkey">${escapeHtml(item.hotkey)}</kbd>` : ''}
        <span class="cm-risk-dot" style="background:${riskColor}" title="${item.risk}"></span>
      </div>
    `;
    })
    .join('');

  positionEl(el, screenPos);
  el.classList.remove('hidden');

  el.querySelectorAll<HTMLElement>('.cm-item').forEach((row, i) => {
    row.addEventListener('click', () => {
      const item = items[i]!;
      hideContextMenu();
      // Handle action-based items (legacy unit context menu)
      if (item.action) {
        item.action();
        return;
      }
      // If prompt: show preview instead of direct send
      if (item.draft?.payload?.['promptUser']) {
        showDirectivePreview(
          {
            gesture: 'right_click',
            sourceCoord: { q: 0, r: 0 },
            shiftHeld: false,
            draft: item.draft!,
            label: item.label,
            confidence: 1,
            userConfirmed: false,
          },
          screenPos,
          onSelect,
          () => {},
        );
      } else if (item.draft) {
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

export function hideContextMenu(): void {
  _menuEl?.classList.add('hidden');
}
