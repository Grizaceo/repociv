// ─── RepoCiv — Relations Panel for Bibliotheca Graph Suggestions ─────────────
// Displays suggested relations between nodes, grouped by type.
// Non-invasive collapsible side panel — only active when graphSuggestions is enabled.
// Every relation MUST have evidence — no magic.

import type { SuggestionRelation } from '../wonders/types.ts';

// ─── Escaping helper ─────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

// ─── Relation type metadata ──────────────────────────────────────────────────

const RELATION_META: Record<string, { icon: string; label: string; color: string }> = {
  shared_dependency:     { icon: '🔗', label: 'Dependencia compartida',   color: 'var(--civ-movement, #4ecdc4)' },
  shared_entity:         { icon: '🏛', label: 'Entidad compartida',       color: 'var(--civ-gold, #c8a84b)' },
  temporal_coactivity:   { icon: '⏳', label: 'Coactividad temporal',     color: 'var(--civ-happiness, #e8c84b)' },
  conceptual_overlap:    { icon: '🧠', label: 'Solapamiento conceptual',   color: 'var(--civ-science, #4a9eff)' },
  imports_or_links:      { icon: '📎', label: 'Importa o enlaza',         color: 'var(--civ-food, #6bcf7f)' },
  same_lab_family:       { icon: '🧪', label: 'Misma familia de lab',     color: 'var(--civ-production, #d4824a)' },
  security_relevance:    { icon: '🛡', label: 'Relevancia de seguridad',  color: 'var(--state-error, #d46a4a)' },
  unknown_but_interesting: { icon: '💡', label: 'Desconocido pero interesante', color: 'var(--ui-text-dim, #8a7a5a)' },
};

function _relMeta(type: string): { icon: string; label: string; color: string } {
  return RELATION_META[type] ?? { icon: '❓', label: type, color: 'var(--ui-text-dim, #8a7a5a)' };
}

function _relScoreClass(score: number): string {
  if (score >= 0.7) return 'relation-score--high';
  if (score >= 0.4) return 'relation-score--mid';
  return 'relation-score--low';
}

function _actionLabel(action: string): string {
  switch (action) {
    case 'linkear':     return '🔗 Vincular';
    case 'ignorar':     return '🙈 Ignorar';
    case 'abrir_ambos': return '📂 Abrir ambos';
    case 'crear_nota':  return '📝 Crear nota';
    default:            return action;
  }
}

// ─── CSS injection (once) ────────────────────────────────────────────────────

let _stylesInjected = false;

function _injectStyles(): void {
  if (_stylesInjected) return;
  _stylesInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    .relations-panel {
      font-family: var(--font-ui, 'Outfit', system-ui, sans-serif);
      font-size: var(--text-sm, 13px);
      color: var(--civ-text-beige, #e8dcc8);
      background: rgba(8, 6, 4, 0.85);
      border: 1px solid var(--panel-border, rgba(200, 168, 75, 0.25));
      border-radius: var(--panel-radius, 6px);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: var(--shadow-deep, 0 16px 48px rgba(0,0,0,0.9));
      overflow: hidden;
      max-height: 480px;
      display: flex;
      flex-direction: column;
      transition: max-height 0.3s ease, opacity 0.3s ease;
    }
    .relations-panel.relations-panel--collapsed {
      max-height: 36px;
    }
    .relations-panel.relations-panel--empty {
      max-height: 120px;
    }

    .relations-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      border-bottom: 1px solid var(--panel-border, rgba(200, 168, 75, 0.25));
      cursor: pointer;
      user-select: none;
      flex-shrink: 0;
    }
    .relations-panel-header:hover {
      background: var(--panel-hover, rgba(240, 192, 80, 0.08));
    }
    .relations-panel-title {
      font-weight: 600;
      font-size: var(--text-xs, 12px);
      color: var(--ui-gold-bright, #e8c84b);
      letter-spacing: 0.05em;
    }
    .relations-panel-toggle {
      background: transparent;
      border: 1px solid var(--panel-border, rgba(200, 168, 75, 0.25));
      color: var(--ui-text-dim, #8a7a5a);
      width: 20px;
      height: 20px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .relations-panel-toggle:hover {
      color: var(--ui-gold-bright, #e8c84b);
      border-color: var(--ui-gold-bright, #e8c84b);
    }

    .relations-panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 6px 8px;
    }

    /* ── Group ── */
    .relation-group {
      margin-bottom: 8px;
    }
    .relation-group:last-child {
      margin-bottom: 0;
    }
    .relation-group-title {
      font-size: var(--text-2xs, 10px);
      font-weight: 600;
      color: var(--ui-text-dim, #8a7a5a);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      padding: 4px 2px 2px;
      border-bottom: 1px solid rgba(200, 168, 75, 0.1);
      margin-bottom: 4px;
    }

    /* ── Item ── */
    .relation-item {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 6px 6px;
      margin-bottom: 4px;
      border: 1px solid rgba(200, 168, 75, 0.1);
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.2);
      transition: background 0.15s ease;
    }
    .relation-item:hover {
      background: rgba(240, 192, 80, 0.06);
      border-color: rgba(200, 168, 75, 0.2);
    }
    .relation-item.relation-item--accepted {
      border-color: var(--state-success, #6bcf7f);
      background: rgba(107, 207, 127, 0.06);
    }
    .relation-item.relation-item--rejected {
      border-color: var(--state-error, #d46a4a);
      background: rgba(212, 106, 74, 0.06);
      opacity: 0.55;
    }

    .relation-item-header {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .relation-item-icon {
      font-size: 14px;
      flex-shrink: 0;
    }
    .relation-item-names {
      flex: 1;
      font-size: var(--text-xs, 12px);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .relation-item-names span {
      color: var(--ui-gold, #c8a84b);
    }

    /* ── Score bar ── */
    .relation-score {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .relation-score-bar {
      flex: 1;
      height: 4px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 2px;
      overflow: hidden;
    }
    .relation-score-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.4s ease;
    }
    .relation-score--high .relation-score-fill {
      background: var(--state-success, #6bcf7f);
    }
    .relation-score--mid .relation-score-fill {
      background: var(--state-warn, #e8c84b);
    }
    .relation-score--low .relation-score-fill {
      background: var(--state-error, #d46a4a);
    }
    .relation-score-label {
      font-size: var(--text-3xs, 9px);
      color: var(--ui-text-dim, #8a7a5a);
      min-width: 28px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    /* ── Evidence ── */
    .relation-evidence {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      margin-top: 2px;
    }
    .relation-evidence-item {
      font-size: var(--text-2xs, 10px);
      color: var(--ui-text-dim, #8a7a5a);
      background: rgba(255, 255, 255, 0.03);
      padding: 1px 5px;
      border-radius: 3px;
      border: 1px solid rgba(200, 168, 75, 0.08);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Actions ── */
    .relation-actions {
      display: flex;
      gap: 4px;
      margin-top: 4px;
      flex-wrap: wrap;
    }
    .relation-action-btn {
      font-size: var(--text-2xs, 10px);
      color: var(--ui-text-dim, #8a7a5a);
      background: transparent;
      border: 1px solid var(--panel-border, rgba(200, 168, 75, 0.25));
      border-radius: 3px;
      padding: 2px 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      line-height: 1.4;
    }
    .relation-action-btn:hover {
      color: var(--civ-text-beige, #e8dcc8);
      border-color: var(--ui-gold, #c8a84b);
      background: rgba(240, 192, 80, 0.1);
    }
    .relation-action-btn--accept {
      color: var(--state-success, #6bcf7f);
      border-color: rgba(107, 207, 127, 0.35);
    }
    .relation-action-btn--accept:hover {
      border-color: var(--state-success, #6bcf7f);
      background: rgba(107, 207, 127, 0.1);
    }
    .relation-action-btn--reject {
      color: var(--state-error, #d46a4a);
      border-color: rgba(212, 106, 74, 0.35);
    }
    .relation-action-btn--reject:hover {
      border-color: var(--state-error, #d46a4a);
      background: rgba(212, 106, 74, 0.1);
    }

    /* ── Empty state ── */
    .relations-panel--empty .relations-panel-body {
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 16px 12px;
    }
    .relations-panel-empty-text {
      font-size: var(--text-xs, 12px);
      color: var(--ui-text-dim, #8a7a5a);
      line-height: 1.5;
    }
    .relations-panel-empty-hint {
      font-size: var(--text-2xs, 10px);
      color: rgba(138, 122, 90, 0.6);
      margin-top: 4px;
    }

    /* ── Loading state ── */
    .relations-panel-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 20px 12px;
      font-size: var(--text-xs, 12px);
      color: var(--ui-text-dim, #8a7a5a);
    }
    .relations-panel-spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(200, 168, 75, 0.15);
      border-top-color: var(--ui-gold, #c8a84b);
      border-radius: 50%;
      animation: relations-spin 0.7s linear infinite;
    }
    @keyframes relations-spin {
      to { transform: rotate(360deg); }
    }

    /* ── Error state ── */
    .relations-panel-error {
      padding: 8px 10px;
      font-size: var(--text-2xs, 10px);
      color: var(--state-error, #d46a4a);
      text-align: center;
    }
  `;
  document.head.appendChild(style);
}

// ─── Internal state ──────────────────────────────────────────────────────────

let _mountContainer: HTMLElement | null = null;
let _collapsed = false;
let _options: {
  onAccept?: (rel: SuggestionRelation) => void;
  onReject?: (rel: SuggestionRelation) => void;
  onOpenBoth?: (rel: SuggestionRelation) => void;
  onGoToCity?: (rel: SuggestionRelation) => void;
} = {};

// ─── Exported render function ────────────────────────────────────────────────

export function renderRelationsPanel(
  relations: SuggestionRelation[],
  container: HTMLElement,
  options?: {
    onAccept?: (rel: SuggestionRelation) => void;
    onReject?: (rel: SuggestionRelation) => void;
    onOpenBoth?: (rel: SuggestionRelation) => void;
    onGoToCity?: (rel: SuggestionRelation) => void;
  },
): void {
  _injectStyles();
  _mountContainer = container;
  _options = options ?? {};

  if (relations.length === 0) {
    _renderEmpty();
    return;
  }

  const visible = relations.filter((r) => !r.rejected);
  if (visible.length === 0) {
    _renderEmpty();
    return;
  }

  _renderPanel(visible);
  _attachListeners(visible);
}

// ─── Sub-renders ─────────────────────────────────────────────────────────────

function _renderEmpty(): void {
  if (!_mountContainer) return;

  _mountContainer.innerHTML = `
    <div class="relations-panel relations-panel--empty">
      <div class="relations-panel-header">
        <span class="relations-panel-title">🔍 Sugerencias de grafo</span>
        <button class="relations-panel-toggle" aria-label="Colapsar">–</button>
      </div>
      <div class="relations-panel-body">
        <div class="relations-panel-empty-text">
          No se encontraron relaciones útiles todavía
          <div class="relations-panel-empty-hint">
            No hubo suficiente evidencia local para sugerir vínculos entre estas ciudades.
          </div>
        </div>
      </div>
    </div>
  `;

  _mountContainer
    .querySelector('.relations-panel-header')
    ?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('relations-panel-toggle')) return;
      _toggleCollapse();
    });

  _mountContainer
    .querySelector('.relations-panel-toggle')
    ?.addEventListener('click', (e) => {
      e.stopPropagation();
      _toggleCollapse();
    });
}

export function renderRelationsPanelLoading(container: HTMLElement): void {
  _injectStyles();
  container.innerHTML = `
    <div class="relations-panel">
      <div class="relations-panel-header">
        <span class="relations-panel-title">🔍 Sugerencias de grafo</span>
      </div>
      <div class="relations-panel-body">
        <div class="relations-panel-loading">
          <div class="relations-panel-spinner"></div>
          <span>Analizando relaciones locales...</span>
        </div>
      </div>
    </div>
  `;
}

export function renderRelationsPanelError(container: HTMLElement, message: string): void {
  _injectStyles();
  container.innerHTML = `
    <div class="relations-panel">
      <div class="relations-panel-header">
        <span class="relations-panel-title">🔍 Sugerencias de grafo</span>
      </div>
      <div class="relations-panel-body">
        <div class="relations-panel-error">⚠ ${esc(message)}</div>
      </div>
    </div>
  `;
}

// ─── Panel rendering ─────────────────────────────────────────────────────────

function _renderPanel(relations: SuggestionRelation[]): void {
  if (!_mountContainer) return;

  // Group by relation type
  const groups = new Map<string, SuggestionRelation[]>();
  for (const rel of relations) {
    const existing = groups.get(rel.relationType);
    if (existing) {
      existing.push(rel);
    } else {
      groups.set(rel.relationType, [rel]);
    }
  }

  const toggleSymbol = _collapsed ? '+' : '–';

  let groupsHtml = '';
  for (const [type, rels] of groups) {
    const meta = _relMeta(type);
    const items = rels
      .map((r) => {
        const accepted = r.accepted ? ' relation-item--accepted' : '';
        const rejected = r.rejected ? ' relation-item--rejected' : '';
        const scorePct = Math.round(Math.min(r.score, 1) * 100);
        const scoreClass = _relScoreClass(r.score);

        const evidenceHtml =
          r.evidence.length > 0
            ? r.evidence
                .map((e) => `<span class="relation-evidence-item">${esc(e)}</span>`)
                .join('')
            : '';

        const actionsHtml = r.suggestedActions
          .map((a) => {
            if (a === 'linkear') {
              return `<button class="relation-action-btn relation-action-btn--accept" data-action="accept" data-idx="${esc(r.fromId)}:${esc(r.toId)}">${_actionLabel(a)}</button>`;
            }
            if (a === 'ignorar') {
              return `<button class="relation-action-btn relation-action-btn--reject" data-action="reject" data-idx="${esc(r.fromId)}:${esc(r.toId)}">${_actionLabel(a)}</button>`;
            }
            if (a === 'abrir_ambos') {
              return `<button class="relation-action-btn" data-action="openboth" data-idx="${esc(r.fromId)}:${esc(r.toId)}">${_actionLabel(a)}</button>`;
            }
            return '';
          })
          .join('');
        const goToCityHtml = _options.onGoToCity
          ? `<button class="relation-action-btn" data-action="gocity" data-idx="${esc(r.fromId)}:${esc(r.toId)}">🧭 Ir a ciudad en RepoCiv</button>`
          : '';

        return `
          <div class="relation-item${accepted}${rejected}" data-from="${esc(r.fromId)}" data-to="${esc(r.toId)}">
            <div class="relation-item-header">
              <span class="relation-item-icon">${meta.icon}</span>
              <span class="relation-item-names">${esc(r.fromName)} <span>→</span> ${esc(r.toName)}</span>
            </div>
            <div class="relation-score ${scoreClass}">
              <div class="relation-score-bar">
                <div class="relation-score-fill" style="width:${scorePct}%"></div>
              </div>
              <span class="relation-score-label">${scorePct}%</span>
            </div>
            ${evidenceHtml ? `<div class="relation-evidence">${evidenceHtml}</div>` : ''}
            <div class="relation-actions">${actionsHtml}${goToCityHtml}</div>
          </div>
        `;
      })
      .join('');

    groupsHtml += `
      <div class="relation-group">
        <div class="relation-group-title" style="color:${meta.color}">${meta.icon} ${esc(meta.label)}</div>
        ${items}
      </div>
    `;
  }

  _mountContainer.innerHTML = `
    <div class="relations-panel">
      <div class="relations-panel-header">
        <span class="relations-panel-title">🔍 Sugerencias de grafo (${relations.length})</span>
        <button class="relations-panel-toggle" aria-label="Colapsar">${toggleSymbol}</button>
      </div>
      <div class="relations-panel-body">
        ${groupsHtml}
      </div>
    </div>
  `;

  // Apply collapsed state
  if (_collapsed) {
    _mountContainer.querySelector('.relations-panel')?.classList.add('relations-panel--collapsed');
    const body = _mountContainer.querySelector('.relations-panel-body') as HTMLElement | null;
    if (body) body.style.display = 'none';
  }
}

function _attachListeners(relations: SuggestionRelation[]): void {
  if (!_mountContainer) return;

  // Build lookup by composite key
  const relMap = new Map<string, SuggestionRelation>();
  for (const r of relations) {
    relMap.set(`${r.fromId}:${r.toId}`, r);
  }

  // Collapse toggle
  _mountContainer
    .querySelector('.relations-panel-header')
    ?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('relations-panel-toggle')) return;
      _toggleCollapse();
    });

  _mountContainer
    .querySelector('.relations-panel-toggle')
    ?.addEventListener('click', (e) => {
      e.stopPropagation();
      _toggleCollapse();
    });

  // Action buttons
  _mountContainer.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const el = e.currentTarget as HTMLElement;
      const action = el.dataset['action'] as string;
      const idx = el.dataset['idx'] as string;
      const rel = relMap.get(idx);
      if (!rel) return;

      if (action === 'accept' && _options.onAccept) {
        rel.accepted = true;
        rel.rejected = false;
        _options.onAccept(rel);
        renderRelationsPanel(relations, _mountContainer!, _options);
      } else if (action === 'reject' && _options.onReject) {
        rel.rejected = true;
        rel.accepted = false;
        _options.onReject(rel);
        renderRelationsPanel(relations, _mountContainer!, _options);
      } else if (action === 'openboth' && _options.onOpenBoth) {
        _options.onOpenBoth(rel);
      } else if (action === 'gocity' && _options.onGoToCity) {
        _options.onGoToCity(rel);
      }
    });
  });
}

function _toggleCollapse(): void {
  _collapsed = !_collapsed;
  if (!_mountContainer) return;
  const panel = _mountContainer.querySelector('.relations-panel');
  const body = _mountContainer.querySelector('.relations-panel-body') as HTMLElement | null;
  if (!panel) return;

  panel.classList.toggle('relations-panel--collapsed', _collapsed);
  if (body) {
    body.style.display = _collapsed ? 'none' : '';
  }

  const toggle = _mountContainer.querySelector('.relations-panel-toggle');
  if (toggle) toggle.textContent = _collapsed ? '+' : '–';
}
