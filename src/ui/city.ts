// ─── RepoCiv — City Panel ─────────────────────────────────────────────────────
import type { City, Building, District } from '../types.ts';

const DISTRICT_ICON: Record<string, string> = {
  campus:     '🎓',
  industrial: '⚙',
  commercial: '💰',
  encamp:     '⚔',
  aqueduct:   '💧',
};

export function openCityPanel(city: City, activeBuildings: Building[]) {
  const panel = document.getElementById('city-panel');
  if (!panel) return;
  panel.classList.remove('hidden');

  const star = document.getElementById('city-panel-star');
  if (star) { city.isCapital ? star.classList.remove('hidden') : star.classList.add('hidden'); }

  const setId = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  setId('city-panel-name', city.name);
  setId('city-panel-pop', `${city.population.toLocaleString()} archivos · ${city.territory.length} hexes`);

  renderOverview(city);
  renderDistricts(city.districts);
  renderBuildings(city.buildings, activeBuildings);

  // Reset to first tab
  panel.querySelectorAll('.city-tab').forEach(t => t.classList.remove('active'));
  panel.querySelectorAll('.city-pane').forEach(p => p.classList.remove('active'));
  panel.querySelector('.city-tab')?.classList.add('active');
  panel.querySelector('.city-pane')?.classList.add('active');
}

export function closeCityPanel() {
  document.getElementById('city-panel')?.classList.add('hidden');
}

export function isCityPanelOpen(): boolean {
  return !document.getElementById('city-panel')?.classList.contains('hidden');
}

export function wireCityPanel() {
  document.getElementById('city-panel-close')?.addEventListener('click', closeCityPanel);

  document.querySelectorAll<HTMLElement>('.city-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.city-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.city-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset['ctab']!;
      document.querySelector(`.city-pane[data-cpane="${name}"]`)?.classList.add('active');
    });
  });
}

function renderOverview(city: City) {
  const el = document.getElementById('city-overview');
  if (!el) return;
  const proj = city.currentProject;
  el.innerHTML = `
    <div class="city-stat-grid">
      <div class="city-stat">
        <div class="city-stat-label">Población</div>
        <div class="city-stat-value">${city.population.toLocaleString()}</div>
      </div>
      <div class="city-stat">
        <div class="city-stat-label">Territorio</div>
        <div class="city-stat-value">${city.territory.length} hexes</div>
      </div>
      <div class="city-stat">
        <div class="city-stat-label">Distritos</div>
        <div class="city-stat-value">${city.districts.length}</div>
      </div>
      <div class="city-stat">
        <div class="city-stat-label">Coord</div>
        <div class="city-stat-value city-mono">${city.coord.q},${city.coord.r}</div>
      </div>
    </div>
    ${proj ? `
    <div class="city-project">
      <div class="city-section-label">Proyecto actual</div>
      <div class="city-project-name">${esc(proj.name)}</div>
      <div class="city-progress-bar">
        <div class="city-progress-fill ${proj.type === 'wonder' ? 'wonder' : ''}"
             style="width:${Math.min(100, proj.progress)}%"></div>
      </div>
      <div class="city-project-meta">${Math.round(proj.progress)}% · ${proj.type}</div>
    </div>` : '<div class="city-empty">Sin proyecto en curso</div>'}
  `;
}

function renderDistricts(districts: District[]) {
  const el = document.getElementById('city-districts');
  if (!el) return;
  if (districts.length === 0) {
    el.innerHTML = '<div class="city-empty">Sin distritos</div>';
    return;
  }
  el.innerHTML = districts.map(d => `
    <div class="city-district-row">
      <span class="city-district-icon">${DISTRICT_ICON[d.type] ?? '◈'}</span>
      <div class="city-district-info">
        <div class="city-district-name">${esc(d.name)}</div>
        <div class="city-district-type">${d.type} · ${d.coord.q},${d.coord.r}</div>
      </div>
    </div>
  `).join('');
}

function renderBuildings(cityBuildings: Building[], activeBuildings: Building[]) {
  const el = document.getElementById('city-buildings');
  if (!el) return;

  const all = [...activeBuildings];
  for (const b of cityBuildings) {
    if (!all.find(a => a.id === b.id)) all.push(b);
  }

  if (all.length === 0) {
    el.innerHTML = '<div class="city-empty">Sin obras registradas</div>';
    return;
  }

  const stateIcon: Record<string, string> = {
    planned: '·', building: '⚡', complete: '✓', failed: '✗',
  };
  const stateClass: Record<string, string> = {
    planned: 'planned', building: 'building', complete: 'complete', failed: 'failed',
  };

  el.innerHTML = all.map(b => {
    const icon = stateIcon[b.state] ?? '·';
    const cls = stateClass[b.state] ?? '';
    const progressBar = b.state === 'building' ? `
      <div class="city-progress-bar">
        <div class="city-progress-fill ${b.type === 'wonder' ? 'wonder' : ''}"
             style="width:${Math.min(100, b.progress)}%"></div>
      </div>
      <div class="city-building-meta">${Math.round(b.progress)}%</div>
    ` : `<div class="city-building-meta">${b.type}</div>`;

    return `
      <div class="city-building-row">
        <span class="city-building-state ${cls}">${icon}</span>
        <div class="city-building-info">
          <div class="city-building-name">${esc(b.name)}</div>
          ${progressBar}
        </div>
      </div>
    `;
  }).join('');
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
