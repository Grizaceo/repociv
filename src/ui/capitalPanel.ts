// ─── RepoCiv — Capital Palacio Panel (tabs from Wonder Registry) ──────────────
import { getAnalytics } from './analytics.ts';
import { getStoredEraLabel } from './eraSystem.ts';
import { mountGacetaWidget } from './gacetaWidget.ts';
import { openWonderVignette } from './wonderVignette.ts';
import { listWonders, getWonder, KNOWN_WONDER_TYPES } from '../wonders/manifest.ts';
import type { WonderManifest } from '../wonders/types.ts';
import { renderCapabilityBadge, renderCapabilityPanel } from '../wonders/wonderBadges.ts';

const STORAGE_TAB = 'repociv-capital-tab';
let _panel: HTMLElement | null = null;

/** Tab entries built from registry: wonder tabs + fixed stats tab. */
interface TabEntry {
  id: string;
  label: string;
  icon: string;
  render: (container: HTMLElement) => void;
}

function _buildTabs(): TabEntry[] {
  const tabs: TabEntry[] = [];

  // Gaceta first (always)
  tabs.push({
    id: 'tab-gaceta',
    label: 'Gaceta',
    icon: '📰',
    render: _renderGaceta,
  });

  // All non-gaceta wonders from registry
  for (const m of listWonders()) {
    if (m.id === 'gaceta') continue;
    const icon = m.id === 'bibliotheca' ? '📚' : m.id === 'institutum' ? '🧪' : '🏛';
    const tabId = `tab-${m.id}`;
    tabs.push({
      id: tabId,
      label: m.title.split('/')[0]!.trim(),
      icon,
      render: (container) => _renderWonderTab(container, m),
    });
  }

  // Stats tab always last
  tabs.push({
    id: 'tab-stats',
    label: 'Observatorium',
    icon: '🔭',
    render: _renderStats,
  });

  return tabs;
}

let _activeTab = localStorage.getItem(STORAGE_TAB) || 'tab-gaceta';

export function openCapitalPanel() {
  if (_panel) {
    _panel.classList.remove('hidden');
    return;
  }
  _panel = document.createElement('div');
  _panel.id = 'capital-panel';
  _panel.className = 'capital-panel';

  const tabs = _buildTabs();
  const tabsHtml = tabs
    .map(
      (t) =>
        `<div class="capital-tab ${_activeTab === t.id ? 'active' : ''}" data-tab="${t.id}">${t.icon} ${t.label}</div>`,
    )
    .join('');

  _panel.innerHTML = `
    <div class="capital-header">
      <span class="capital-title">🏛 ${import.meta.env.VITE_CAPITAL_NAME || 'Capital'} — Centrum Operarum</span>
      <button class="capital-close" aria-label="Cerrar">✕</button>
    </div>
    <div class="capital-tabs">${tabsHtml}</div>
    <div class="capital-body"></div>
  `;
  document.body.appendChild(_panel);

  const tabMap = new Map(tabs.map((t) => [t.id, t]));
  _renderTab(_activeTab, tabMap);
  _panel.querySelector('.capital-close')!.addEventListener('click', closeCapitalPanel);
  _panel.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.capital-tab');
    if (!t) return;
    const tabId = t.dataset['tab'] as string;
    if (!tabId) return;
    _switchTab(tabId, tabMap);
  });
}

export function closeCapitalPanel() {
  if (_panel) _panel.classList.add('hidden');
}

function _switchTab(tab: string, tabMap: Map<string, TabEntry>) {
  _activeTab = tab;
  localStorage.setItem(STORAGE_TAB, tab);
  if (!_panel) return;
  _panel.querySelectorAll('.capital-tab').forEach((el) => {
    el.classList.toggle('active', (el as HTMLElement).dataset['tab'] === tab);
  });
  _renderTab(tab, tabMap);
}

function _renderTab(tabId: string, tabMap: Map<string, TabEntry>) {
  if (!_panel) return;
  const body = _panel.querySelector<HTMLElement>('.capital-body')!;
  body.innerHTML = '';
  const entry = tabMap.get(tabId);
  if (entry) {
    entry.render(body);
  }
}

function _renderGaceta(container: HTMLElement) {
  const m = getWonder('gaceta');
  const badgesHtml = m ? renderCapabilityBadge(m) : '';
  const capPanelHtml = m ? renderCapabilityPanel(m) : '';

  if (m) {
    const header = document.createElement('div');
    header.className = 'gaceta-contract-header';
    header.innerHTML = `
      <div class="wonder-badges">${badgesHtml}</div>
      <div class="wonder-cap-panel">${capPanelHtml}</div>
    `;
    container.appendChild(header);
  }

  const wrapper = document.createElement('div');
  wrapper.id = 'gaceta-panel-mount';
  wrapper.style.cssText = 'height:100%;display:flex;flex-direction:column;';
  container.appendChild(wrapper);
  mountGacetaWidget({ target: wrapper.id, mode: 'panel' });
}

function _renderWonderTab(container: HTMLElement, m: WonderManifest) {
  const statsText =
    m.id === 'bibliotheca'
      ? 'Grafo de conocimiento: escaneando...'
      : `Labs activos: consulta en curso [${m.automationLevel}]`;
  const btnText = `Entrar a ${m.title.split('/')[0]!.trim()}`;

  const badgesHtml = renderCapabilityBadge(m);
  const capPanelHtml = renderCapabilityPanel(m);

  container.innerHTML = `
    <div class="wonder-tab-content">
      <h2>${m.title}</h2>
      <div class="wonder-badges">${badgesHtml}</div>
      <p class="wonder-stat">${statsText}</p>
      <button class="wonder-enter-btn" data-type="${m.id}">${btnText}</button>
      <div class="wonder-cap-panel">${capPanelHtml}</div>
    </div>
  `;
  container.querySelector('button')!.addEventListener('click', () => {
    openWonderVignette(m);
  });
}

function _renderStats(container: HTMLElement) {
  const a = getAnalytics();
  const era = getStoredEraLabel();
  const wonderCount = KNOWN_WONDER_TYPES.length;
  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-value">${Object.values(a.panelsOpened).reduce((s, v) => s + v, 0)}</div><div class="stat-label">Paneles abiertos</div></div>
      <div class="stat-card"><div class="stat-value">${Object.values(a.hotkeysUsed).reduce((s, v) => s + v, 0)}</div><div class="stat-label">Hotkeys usadas</div></div>
      <div class="stat-card"><div class="stat-value">${Object.values(a.messagesSent).reduce((s, v) => s + v, 0)}</div><div class="stat-label">Mensajes enviados</div></div>
      <div class="stat-card"><div class="stat-value">${a.commandsIssued}</div><div class="stat-label">Comandos emitidos</div></div>
      <div class="stat-card"><div class="stat-value">${a.approvalsGiven}</div><div class="stat-label">Aprobaciones</div></div>
      <div class="stat-card"><div class="stat-value">${era || 'Desconocida'}</div><div class="stat-label">Era actual</div></div>
      <div class="stat-card"><div class="stat-value">${wonderCount}</div><div class="stat-label">Maravillas registradas</div></div>
    </div>
  `;
}
