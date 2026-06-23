// ─── RepoCiv — Capital Palacio Panel (tabs from Wonder Registry) ──────────────
import { getAnalytics, getPanelUsageReport } from './analytics.ts';
import { getStoredEraLabel } from './eraSystem.ts';
import { mountGacetaWidget } from './gacetaWidget.ts';
import { openWonderVignette } from './wonderVignette.ts';
import { listWonders, getWonder, ensureWondersLoaded } from '../wonders/manifest.ts';
import type { WonderManifest } from '../wonders/types.ts';
import { renderCapabilityBadge, renderCapabilityPanel } from '../wonders/wonderBadges.ts';
import { WONDER_EXAMPLES, type WonderExample } from '../wonders/exampleTemplates.ts';
import { connectWonder, disconnectWonder, launchWonder } from '../wonders/wonderLauncher.ts';
import { showNotification } from './notificationBanner.ts';

const STORAGE_TAB = 'repociv-capital-tab';
let _panel: HTMLElement | null = null;

/** Tab entries built from registry: wonder tabs + fixed stats tab. */
interface TabEntry {
  id: string;
  label: string;
  icon: string;
  render: (container: HTMLElement) => void;
}

function _wonderIcon(id: string): string {
  return id === 'bibliotheca' ? '📚' : id === 'institutum' ? '🧪' : '🏛';
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

  // All non-gaceta wonders currently connected (from registry)
  for (const m of listWonders()) {
    if (m.id === 'gaceta') continue;
    const tabId = `tab-${m.id}`;
    tabs.push({
      id: tabId,
      label: m.title.split('/')[0]!.trim(),
      icon: _wonderIcon(m.id),
      render: (container) => _renderWonderTab(container, m),
    });
  }

  // Maravillas guide / catalog (always present) — connect new iframe services
  tabs.push({
    id: 'tab-wonders-guide',
    label: 'Maravillas',
    icon: '➕',
    render: _renderWondersGuide,
  });

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
let _tabMap: Map<string, TabEntry> = new Map();

export function openCapitalPanel() {
  if (_panel) {
    _panel.classList.remove('hidden');
    return;
  }
  _panel = document.createElement('div');
  _panel.id = 'capital-panel';
  _panel.className = 'capital-panel';

  _panel.innerHTML = `
    <div class="capital-header">
      <span class="capital-title">🏛 ${import.meta.env.VITE_CAPITAL_NAME || 'Capital'} — Centrum Operarum</span>
      <button class="capital-close" aria-label="Cerrar">✕</button>
    </div>
    <div class="capital-tabs"></div>
    <div class="capital-body"></div>
  `;
  document.body.appendChild(_panel);

  _rebuildTabsBar();
  _panel.querySelector('.capital-close')!.addEventListener('click', closeCapitalPanel);
  _panel.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.capital-tab');
    if (!t) return;
    const tabId = t.dataset['tab'] as string;
    if (!tabId) return;
    _switchTab(tabId);
  });
}

export function closeCapitalPanel() {
  if (_panel) _panel.classList.add('hidden');
}

/** Rebuild the tab bar from the current registry (used on open and after a
 *  connect/disconnect mutation). Keeps the active tab if it still exists,
 *  else falls back to the guide. */
function _rebuildTabsBar() {
  if (!_panel) return;
  const tabs = _buildTabs();
  _tabMap = new Map(tabs.map((t) => [t.id, t]));
  if (!_tabMap.has(_activeTab)) _activeTab = 'tab-wonders-guide';
  const bar = _panel.querySelector<HTMLElement>('.capital-tabs')!;
  bar.innerHTML = tabs
    .map(
      (t) =>
        `<div class="capital-tab ${_activeTab === t.id ? 'active' : ''}" data-tab="${t.id}">${t.icon} ${t.label}</div>`,
    )
    .join('');
  _renderTab(_activeTab);
}

function _switchTab(tab: string) {
  _activeTab = tab;
  localStorage.setItem(STORAGE_TAB, tab);
  if (!_panel) return;
  _panel.querySelectorAll('.capital-tab').forEach((el) => {
    el.classList.toggle('active', (el as HTMLElement).dataset['tab'] === tab);
  });
  _renderTab(tab);
}

function _renderTab(tabId: string) {
  if (!_panel) return;
  const body = _panel.querySelector<HTMLElement>('.capital-body')!;
  body.innerHTML = '';
  const entry = _tabMap.get(tabId);
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
  const short = m.title.split('/')[0]!.trim();
  const statsText =
    m.id === 'bibliotheca'
      ? 'Grafo de conocimiento: escaneando...'
      : m.id === 'institutum'
        ? `Labs activos: consulta en curso [${m.automationLevel}]`
        : `Servicio conectado [${m.kind} · ${m.automationLevel}]`;
  const canLaunch = m.kind === 'iframe';

  const badgesHtml = renderCapabilityBadge(m);
  const capPanelHtml = renderCapabilityPanel(m);

  container.innerHTML = `
    <div class="wonder-tab-content">
      <h2>${m.title}</h2>
      <div class="wonder-badges">${badgesHtml}</div>
      <p class="wonder-stat">${statsText}</p>
      <div class="wonder-tab-actions">
        <button class="wonder-enter-btn" data-act="open">Entrar a ${short}</button>
        ${canLaunch ? '<button class="wonder-launch-btn" data-act="launch">⚙️ Levantar servidor</button>' : ''}
        ${canLaunch ? `<button class="wonder-disconnect-btn" data-act="disconnect" data-id="${m.id}">Desconectar</button>` : ''}
      </div>
      <p class="wonder-launch-status" data-launch-status="${m.id}"></p>
      <div class="wonder-cap-panel">${capPanelHtml}</div>
    </div>
  `;
  container.querySelector<HTMLElement>('[data-act="open"]')!.addEventListener('click', () => {
    openWonderVignette(m);
  });
  const launchBtn = container.querySelector<HTMLElement>('[data-act="launch"]');
  launchBtn?.addEventListener('click', () => void _launchFromTab(m, container));
  const disconnectBtn = container.querySelector<HTMLElement>('[data-act="disconnect"]');
  disconnectBtn?.addEventListener('click', () => void _disconnectFromTab(m));
}

async function _launchFromTab(m: WonderManifest, container: HTMLElement) {
  const status = container.querySelector<HTMLElement>(`[data-launch-status="${m.id}"]`);
  if (status) status.textContent = '⚙️ Pidiendo al bridge que levante el servidor…';
  const res = await launchWonder(m.id);
  if (res.ok === false) {
    if (status) status.textContent = `✗ ${res.error_message ?? res.error ?? 'no se pudo levantar'}`;
    return;
  }
  if (status) {
    status.textContent =
      res.status === 'ready' || res.status === 'already_running'
        ? '✓ Servidor listo — abre la maravilla.'
        : `Estado: ${res.status}. Abre la maravilla para seguir el arranque.`;
  }
}

async function _disconnectFromTab(m: WonderManifest) {
  const res = await disconnectWonder(m.id);
  if (!res.ok) {
    showNotification({ type: 'error', title: 'No se pudo desconectar', body: res.error ?? m.id });
    return;
  }
  await ensureWondersLoaded();
  showNotification({
    type: 'success',
    title: 'Maravilla desconectada',
    body: `${m.title} ya no aparece en el mapa.`,
  });
  window.dispatchEvent(new CustomEvent('repociv:wonders-changed', { detail: {} }));
  _activeTab = 'tab-wonders-guide';
  _rebuildTabsBar();
}

function _renderWondersGuide(container: HTMLElement) {
  const wrap = document.createElement('div');
  wrap.className = 'wonders-guide';
  wrap.innerHTML = `
    <h2>➕ Conectar una Maravilla</h2>
    <p class="wonders-guide-intro">
      Una Maravilla es cualquier servicio web local apto para <strong>iframe</strong>
      (un dashboard, una app, un panel) que quieras tener a un clic dentro del mapa.
      RepoCiv puede además <strong>levantar su servidor por ti</strong> y embeberlo —
      sin abrir terminales. Nada viene pre-instalado: conecta lo que uses.
    </p>
    <p class="wonders-guide-intro" style="opacity:.85">
      Para conectar un servicio propio, deja un manifiesto en
      <code>~/.repociv/wonders/&lt;id&gt;.json</code> (ver
      <code>docs/CUSTOM_WONDERS.md</code>) y reinicia el bridge — o usa los
      ejemplos de abajo como punto de partida.
    </p>
    <h3 class="wonders-guide-h3">Ejemplos (repos públicos)</h3>
    <div class="wonders-example-cards"></div>
  `;
  container.appendChild(wrap);

  const cards = wrap.querySelector<HTMLElement>('.wonders-example-cards')!;
  for (const ex of WONDER_EXAMPLES) {
    cards.appendChild(_renderExampleCard(ex));
  }
}

function _renderExampleCard(ex: WonderExample): HTMLElement {
  const connected = getWonder(ex.manifest.id) !== undefined;
  const card = document.createElement('div');
  card.className = 'wonder-example-card';
  card.dataset['id'] = ex.manifest.id;
  card.innerHTML = `
    <div class="wec-head">
      <span class="wec-icon">${_wonderIcon(ex.manifest.id)}</span>
      <span class="wec-title">${ex.manifest.title}</span>
      ${connected ? '<span class="wec-badge wec-connected">Conectada ✓</span>' : '<span class="wec-badge">Ejemplo</span>'}
    </div>
    <p class="wec-desc">${ex.description}</p>
    <p class="wec-meta">
      <a class="wec-repo" href="${ex.repoUrl}" target="_blank" rel="noreferrer noopener">${ex.repoUrl.replace('https://', '')}</a>
    </p>
    <p class="wec-boot"><code>${ex.bootSummary}</code></p>
    <p class="wec-dir">repo: <code>${ex.defaultRepoDir}</code></p>
    <div class="wec-actions">
      ${
        connected
          ? `<button class="wec-btn wec-open" data-id="${ex.manifest.id}">Abrir</button>
             <button class="wec-btn wec-disconnect" data-id="${ex.manifest.id}">Desconectar</button>`
          : `<button class="wec-btn wec-connect" data-id="${ex.manifest.id}">Conectar</button>`
      }
    </div>
    <p class="wec-status" data-status="${ex.manifest.id}"></p>
  `;
  card
    .querySelector<HTMLElement>('.wec-connect')
    ?.addEventListener('click', () => void _connectExample(ex));
  card
    .querySelector<HTMLElement>('.wec-disconnect')
    ?.addEventListener('click', () => void _disconnectExample(ex));
  card.querySelector<HTMLElement>('.wec-open')?.addEventListener('click', () => {
    const m = getWonder(ex.manifest.id);
    if (m) openWonderVignette(m);
  });
  return card;
}

function _cardStatus(id: string, text: string) {
  const el = _panel?.querySelector<HTMLElement>(`[data-status="${id}"]`);
  if (el) el.textContent = text;
}

async function _connectExample(ex: WonderExample) {
  _cardStatus(ex.manifest.id, 'Conectando…');
  const res = await connectWonder(ex.manifest);
  if (!res.ok) {
    _cardStatus(ex.manifest.id, `✗ ${res.error ?? 'no se pudo conectar'}`);
    return;
  }
  await ensureWondersLoaded();
  showNotification({
    type: 'success',
    title: 'Maravilla conectada',
    body: `${ex.manifest.title} aparece en el mapa y como pestaña. RepoCiv está levantando su servidor…`,
  });
  window.dispatchEvent(
    new CustomEvent('repociv:wonders-changed', { detail: { connectedId: ex.manifest.id } }),
  );
  _activeTab = `tab-${ex.manifest.id}`;
  _rebuildTabsBar();
}

async function _disconnectExample(ex: WonderExample) {
  _cardStatus(ex.manifest.id, 'Desconectando…');
  const res = await disconnectWonder(ex.manifest.id);
  if (!res.ok) {
    _cardStatus(ex.manifest.id, `✗ ${res.error ?? 'no se pudo desconectar'}`);
    return;
  }
  await ensureWondersLoaded();
  showNotification({
    type: 'success',
    title: 'Maravilla desconectada',
    body: `${ex.manifest.title} ya no aparece en el mapa.`,
  });
  window.dispatchEvent(new CustomEvent('repociv:wonders-changed', { detail: {} }));
  _rebuildTabsBar();
}

function _renderStats(container: HTMLElement) {
  const a = getAnalytics();
  const era = getStoredEraLabel();
  const wonderCount = listWonders().length;
  const usage = getPanelUsageReport();
  const unused = usage.filter((u) => u.opens === 0);
  const podaRows = usage
    .map(
      (u) =>
        `<li class="poda-row${u.opens === 0 ? ' poda-unused' : ''}"><span class="poda-panel">${u.panel}</span><span class="poda-count">${u.opens}</span></li>`,
    )
    .join('');
  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-value">${Object.values(a.panelsOpened).reduce((s, v) => s + v, 0)}</div><div class="stat-label">Paneles abiertos</div></div>
      <div class="stat-card"><div class="stat-value">${Object.values(a.hotkeysUsed).reduce((s, v) => s + v, 0)}</div><div class="stat-label">Hotkeys usadas</div></div>
      <div class="stat-card"><div class="stat-value">${Object.values(a.messagesSent).reduce((s, v) => s + v, 0)}</div><div class="stat-label">Mensajes enviados</div></div>
      <div class="stat-card"><div class="stat-value">${a.commandsIssued}</div><div class="stat-label">Comandos emitidos</div></div>
      <div class="stat-card"><div class="stat-value">${a.approvalsGiven}</div><div class="stat-label">Aprobaciones</div></div>
      <div class="stat-card"><div class="stat-value">${era || 'Desconocida'}</div><div class="stat-label">Era actual</div></div>
      <div class="stat-card"><div class="stat-value">${wonderCount}</div><div class="stat-label">Maravillas registradas</div></div>
      <div class="stat-card"><div class="stat-value">${unused.length}/${usage.length}</div><div class="stat-label">Paneles sin uso</div></div>
    </div>
    <div class="poda-report">
      <div class="poda-title">Uso de superficie · candidatos a poda (0 = nunca abierto) · ver docs/SCOPE.md §"Roadmap de poda"</div>
      <ul class="poda-list">${podaRows}</ul>
    </div>
  `;
}
