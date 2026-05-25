// ─── RepoCiv — Capital Palacio Panel (4 tabs) ────────────────────────────────
import type { WonderType } from '../types.ts';
import { getAnalytics } from './analytics.ts';
import { getStoredEraLabel } from './eraSystem.ts';
import { mountGacetaWidget } from './gacetaWidget.ts';
import { openWonderVignette } from './wonderVignette.ts';
import { getWonder, KNOWN_WONDER_TYPES } from '../wonders/manifest.ts';
import { renderCapabilityBadge, renderCapabilityPanel } from '../wonders/wonderBadges.ts';

const STORAGE_TAB = 'repociv-capital-tab';
let _panel: HTMLElement | null = null;
let _activeTab = localStorage.getItem(STORAGE_TAB) || 'tab-gaceta';

type TabId = 'tab-gaceta' | 'tab-biblio' | 'tab-labhub' | 'tab-stats';

export function openCapitalPanel() {
  if (_panel) { _panel.classList.remove('hidden'); return; }
  _panel = document.createElement('div');
  _panel.id = 'capital-panel';
  _panel.className = 'capital-panel';
  _panel.innerHTML = `
    <div class="capital-header">
      <span class="capital-title">🏛 Palacio Imperial — Centrum Operarum</span>
      <button class="capital-close" aria-label="Cerrar">✕</button>
    </div>
    <div class="capital-tabs">
      <div class="capital-tab ${_activeTab === 'tab-gaceta' ? 'active' : ''}" data-tab="tab-gaceta">📰 Gaceta</div>
      <div class="capital-tab ${_activeTab === 'tab-biblio' ? 'active' : ''}" data-tab="tab-biblio">📚 Bibliotheca</div>
      <div class="capital-tab ${_activeTab === 'tab-labhub' ? 'active' : ''}" data-tab="tab-labhub">🧪 Institutum</div>
      <div class="capital-tab ${_activeTab === 'tab-stats' ? 'active' : ''}" data-tab="tab-stats">🔭 Observatorium</div>
    </div>
    <div class="capital-body"></div>
  `;
  document.body.appendChild(_panel);
  _bindTabs();
  _renderTab(_activeTab as TabId);
  _panel.querySelector('.capital-close')!.addEventListener('click', closeCapitalPanel);
  _panel.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.capital-tab');
    if (!t) return;
    const tab = t.dataset['tab'] as TabId;
    if (!tab) return;
    _switchTab(tab);
  });
}

export function closeCapitalPanel() {
  if (_panel) _panel.classList.add('hidden');
}

function _bindTabs() {
  if (!_panel) return;
}

function _switchTab(tab: TabId) {
  _activeTab = tab;
  localStorage.setItem(STORAGE_TAB, tab);
  if (!_panel) return;
  _panel.querySelectorAll('.capital-tab').forEach((el) => {
    el.classList.toggle('active', (el as HTMLElement).dataset['tab'] === tab);
  });
  _renderTab(tab);
}

function _renderTab(tab: TabId) {
  if (!_panel) return;
  const body = _panel.querySelector<HTMLElement>('.capital-body')!;
  body.innerHTML = '';
  switch (tab) {
    case 'tab-gaceta':
      _renderGaceta(body);
      break;
    case 'tab-biblio':
      _renderWonderTab(body, 'bibliotheca');
      break;
    case 'tab-labhub':
      _renderWonderTab(body, 'institutum');
      break;
    case 'tab-stats':
      _renderStats(body);
      break;
  }
}

function _renderGaceta(container: HTMLElement) {
  const wrapper = document.createElement('div');
  wrapper.id = 'gaceta-panel-mount';
  wrapper.style.cssText = 'height:100%;display:flex;flex-direction:column;';
  container.appendChild(wrapper);
  mountGacetaWidget({ target: wrapper.id, mode: 'panel' });
}

function _renderWonderTab(container: HTMLElement, type: WonderType) {
  const m = getWonder(type);
  const title = m?.title ?? (type === 'bibliotheca' ? 'Bibliotheca Alexandrina' : 'Institutum Scientiarum');
  const automationLevel = m?.automationLevel ?? 'passive';
  const statsText = type === 'bibliotheca'
    ? 'Grafo de conocimiento: escaneando...'
    : `Labs activos: consulta en curso [${automationLevel}]`;
  const btnText = type === 'bibliotheca' ? 'Entrar a la Bibliotheca' : 'Entrar al Institutum';

  // Build capability badges from manifest
  const badgesHtml = m ? renderCapabilityBadge(m) : '';
  const capPanelHtml = m ? renderCapabilityPanel(m) : '';

  container.innerHTML = `
    <div class="wonder-tab-content">
      <h2>${title}</h2>
      <div class="wonder-badges">${badgesHtml}</div>
      <p class="wonder-stat">${statsText}</p>
      <button class="wonder-enter-btn" data-type="${type}">${btnText}</button>
      <div class="wonder-cap-panel">${capPanelHtml}</div>
    </div>
  `;
  container.querySelector('button')!.addEventListener('click', () => {
    openWonderVignette(type);
  });
}

function _renderStats(container: HTMLElement) {
  const a = getAnalytics();
  const era = getStoredEraLabel();
  // Count registered wonders
  const wonderCount = KNOWN_WONDER_TYPES.length;
  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-value">${Object.values(a.panelsOpened).reduce((s, v) => s + v, 0)}</div><div class="stat-label">Paneles abiertos</div></div>
      <div class="stat-card"><div class="stat-value">${Object.values(a.messagesSent).reduce((s, v) => s + v, 0)}</div><div class="stat-label">Mensajes enviados</div></div>
      <div class="stat-card"><div class="stat-value">${a.commandsIssued}</div><div class="stat-label">Comandos emitidos</div></div>
      <div class="stat-card"><div class="stat-value">${a.approvalsGiven}</div><div class="stat-label">Aprobaciones</div></div>
      <div class="stat-card"><div class="stat-value">${era || 'Desconocida'}</div><div class="stat-label">Era actual</div></div>
      <div class="stat-card"><div class="stat-value">${wonderCount}</div><div class="stat-label">Maravillas registradas</div></div>
    </div>
  `;
}
