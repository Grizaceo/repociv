// ─── RepoCiv — Global Ledger (Gran Libro) ────────────────────────────────────
// Vista administrativa tipo Demographics/Civilopedia de Civ V.
// Muestra todos los repos del mapa con sus estadísticas en una tabla.
// Tecla F6 para abrir/cerrar.

import type { GameState } from '../game.ts';

export type LedgerFilter = 'all' | 'active' | 'idle' | string; // string = terrain filter

const TERRAIN_LABEL: Record<string, string> = {
  plains: '🌾 TS',
  forest: '🌲 Py',
  mountain: '⛰ Sys',
  desert: '📄 Docs',
  ocean: '🌊 Empty',
  ice: '❄ Legacy',
  hills: '⛺ Mixed',
};

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function injectLedgerDOM(): HTMLElement {
  const existing = document.getElementById('ledger-overlay');
  if (existing) return existing;

  const el = document.createElement('div');
  el.id = 'ledger-overlay';
  el.className = 'hidden';
  el.innerHTML = `
    <div id="ledger-inner">
      <div id="ledger-header">
        <div id="ledger-title">
          <span id="ledger-star">★</span>
          GRAN LIBRO — Workspace Overview
        </div>
        <div id="ledger-filters">
          <button class="ledger-filter active" data-filter="all" aria-label="Mostrar todos los repos">Todos</button>
          <button class="ledger-filter" data-filter="active" aria-label="Mostrar repos activos">Activos</button>
          <button class="ledger-filter" data-filter="idle" aria-label="Mostrar repos idle">Idle</button>
        </div>
        <button id="ledger-close" aria-label="Cerrar [F6]">✕ <kbd>F6</kbd></button>
      </div>
      <div id="ledger-scroll">
        <table id="ledger-table">
          <thead>
            <tr>
              <th>Repo</th>
              <th>Terreno</th>
              <th>Pop</th>
              <th title="Commits / líneas añadidas">🪙</th>
              <th title="Tests / cobertura">⚗</th>
              <th title="PRs / features">⚙</th>
              <th>Agentes</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody id="ledger-tbody"></tbody>
        </table>
      </div>
      <div id="ledger-footer">
        <span id="ledger-count"></span>
        <span>Click en fila → centrar cámara</span>
      </div>
    </div>
  `;

  // Scoped styles
  const style = document.createElement('style');
  style.id = 'ledger-styles';
  style.textContent = `
    #ledger-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.72);
      z-index: 500;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(2px);
    }
    #ledger-overlay.hidden { display: none; }

    #ledger-inner {
      background: linear-gradient(160deg, rgba(26,18,8,0.98) 0%, rgba(10,8,4,0.98) 100%);
      border: 2px solid var(--ui-gold, #c8a84b);
      border-radius: 6px;
      width: min(900px, 94vw);
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 8px 48px rgba(0,0,0,0.9), 0 0 0 1px rgba(200,168,75,0.15);
      animation: slideUp 0.2s ease;
    }

    #ledger-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 18px;
      border-bottom: 1px solid var(--ui-border, #5a3e1e);
      background: linear-gradient(180deg, rgba(200,168,75,0.1), transparent);
      flex-shrink: 0;
    }

    #ledger-title {
      font-family: var(--font-ui, 'Cinzel', serif);
      font-size: 15px;
      font-weight: 700;
      color: var(--ui-gold-bright, #f0c050);
      letter-spacing: 0.06em;
      flex: 1;
    }
    #ledger-star { margin-right: 8px; }

    #ledger-filters {
      display: flex;
      gap: 6px;
    }
    .ledger-filter {
      background: transparent;
      border: 1px solid var(--ui-border, #5a3e1e);
      color: var(--ui-text-dim, #a89060);
      font-family: var(--font-ui, 'Cinzel', serif);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 4px 10px;
      border-radius: 2px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .ledger-filter:hover { color: var(--ui-text, #e8d5a0); border-color: var(--ui-gold, #c8a84b); }
    .ledger-filter.active {
      background: rgba(200,168,75,0.15);
      border-color: var(--ui-gold, #c8a84b);
      color: var(--ui-gold-bright, #f0c050);
    }

    #ledger-close {
      background: transparent;
      border: 1px solid var(--ui-border, #5a3e1e);
      color: var(--ui-text-dim, #a89060);
      font-family: var(--font-ui, 'Cinzel', serif);
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 2px;
      cursor: pointer;
    }
    #ledger-close:hover { color: var(--ui-gold, #c8a84b); border-color: var(--ui-gold, #c8a84b); }
    #ledger-close kbd {
      font-size: 9px;
      border: 1px solid currentColor;
      border-radius: 2px;
      padding: 1px 4px;
      margin-left: 4px;
    }

    #ledger-scroll {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--ui-border, #5a3e1e) transparent;
    }

    #ledger-table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--font-ui, 'Cinzel', serif);
    }

    #ledger-table thead th {
      position: sticky;
      top: 0;
      background: rgba(10,8,4,0.97);
      padding: 8px 12px;
      text-align: left;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--ui-gold, #c8a84b);
      border-bottom: 1px solid var(--ui-border, #5a3e1e);
      white-space: nowrap;
    }

    #ledger-table tbody tr {
      cursor: pointer;
      transition: background 0.1s;
      border-bottom: 1px solid rgba(90,62,30,0.4);
    }
    #ledger-table tbody tr:hover {
      background: rgba(200,168,75,0.07);
    }
    #ledger-table tbody tr.ledger-capital {
      border-left: 2px solid var(--ui-gold, #c8a84b);
    }

    #ledger-table tbody td {
      padding: 9px 12px;
      font-size: 12px;
      color: var(--ui-text, #e8d5a0);
      vertical-align: middle;
    }

    .ledger-repo-name {
      font-weight: 700;
      font-size: 13px;
      color: var(--ui-gold-bright, #f0c050);
    }
    .ledger-cap-star {
      color: var(--ui-gold, #c8a84b);
      margin-right: 4px;
    }

    .ledger-terrain { font-size: 12px; }

    .ledger-num {
      font-family: var(--font-mono, 'Courier New', monospace);
      font-size: 12px;
      text-align: right;
    }

    .ledger-agents {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .ledger-agent-badge {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 2px 6px;
      border-radius: 2px;
      border: 1px solid currentColor;
    }
    .ledger-agent-badge.state-working  { color: #8bcfff; border-color: #8bcfff; background: rgba(139,207,255,0.08); }
    .ledger-agent-badge.state-moving   { color: #e8c870; border-color: #e8c870; background: rgba(232,200,112,0.08); }
    .ledger-agent-badge.state-idle     { color: #888; border-color: #555; }
    .ledger-agent-badge.state-sleeping { color: #666; border-color: #444; }
    .ledger-agent-badge.state-building { color: #c8a84b; border-color: #c8a84b; background: rgba(200,168,75,0.08); }

    .ledger-status-building { color: var(--ui-gold, #c8a84b); font-size: 11px; }
    .ledger-status-idle     { color: var(--ui-text-dim, #a89060); font-size: 11px; }

    #ledger-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 18px;
      border-top: 1px solid var(--ui-border, #5a3e1e);
      font-family: var(--font-ui, 'Cinzel', serif);
      font-size: 10px;
      color: var(--ui-text-dim, #a89060);
      letter-spacing: 0.05em;
      flex-shrink: 0;
    }

    #ledger-count { color: var(--ui-gold, #c8a84b); }
  `;

  document.head.appendChild(style);
  document.body.appendChild(el);
  return el;
}

// ─── Internal state ──────────────────────────────────────────────────────────
let _currentFilter: LedgerFilter = 'all';
let _focusCallback: ((cityId: string) => void) | null = null;

function renderTable(state: GameState, filter: LedgerFilter) {
  const tbody = document.getElementById('ledger-tbody');
  if (!tbody) return;

  const units = state.world.units;
  const buildings = state.world.buildings;

  let rows = state.world.cities.map((city) => {
    const tile = state.world.tiles.get(`${city.coord.q},${city.coord.r}`);
    const cityUnits = units.filter((u) => {
      // Unit is "in" a city if it's on any tile in that city's territory
      return (
        city.territory.some((t) => t.q === u.coord.q && t.r === u.coord.r) ||
        (u.coord.q === city.coord.q && u.coord.r === city.coord.r)
      );
    });
    const activeBuilding = buildings.find((b) => b.cityId === city.id && b.state === 'building');
    const res = tile?.resources ?? { gold: 0, science: 0, production: 0 };

    return { city, tile, cityUnits, activeBuilding, res };
  });

  // Apply filter
  if (filter === 'active') {
    rows = rows.filter((r) => r.cityUnits.length > 0 || r.activeBuilding);
  } else if (filter === 'idle') {
    rows = rows.filter((r) => r.cityUnits.length === 0 && !r.activeBuilding);
  }

  // Sort: capitals first, then by population desc
  rows.sort((a, b) => {
    if (a.city.isCapital !== b.city.isCapital) return a.city.isCapital ? -1 : 1;
    return b.city.population - a.city.population;
  });

  const countEl = document.getElementById('ledger-count');
  if (countEl) {
    countEl.textContent = `${rows.length} repos${rows.length !== state.world.cities.length ? ` / ${state.world.cities.length} total` : ''}`;
  }

  tbody.innerHTML = rows
    .map(({ city, tile, cityUnits, activeBuilding, res }) => {
      const capStar = city.isCapital ? '<span class="ledger-cap-star">★</span>' : '';
      const terrain = TERRAIN_LABEL[tile?.terrain ?? ''] ?? tile?.terrain ?? '—';
      const agents =
        cityUnits.length > 0
          ? cityUnits
              .map((u) => `<span class="ledger-agent-badge state-${u.state}">${esc(u.name)}</span>`)
              .join('')
          : '<span style="color:#555">—</span>';

      let statusHtml: string;
      if (activeBuilding) {
        const pct = Math.round(activeBuilding.progress);
        statusHtml = `<span class="ledger-status-building">⚙ ${esc(activeBuilding.name)} ${pct}%</span>`;
      } else {
        statusHtml = '<span class="ledger-status-idle">—</span>';
      }

      return `<tr class="${city.isCapital ? 'ledger-capital' : ''}" data-city-id="${esc(city.id)}">
      <td><span class="ledger-repo-name">${capStar}${esc(city.name)}</span></td>
      <td class="ledger-terrain">${terrain}</td>
      <td class="ledger-num">${city.population}</td>
      <td class="ledger-num">${res.gold}</td>
      <td class="ledger-num">${res.science}</td>
      <td class="ledger-num">${res.production}</td>
      <td><div class="ledger-agents">${agents}</div></td>
      <td>${statusHtml}</td>
    </tr>`;
    })
    .join('');

  // Wire row clicks
  tbody.querySelectorAll<HTMLTableRowElement>('tr[data-city-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.cityId;
      if (id && _focusCallback) _focusCallback(id);
      closeLedger();
    });
  });
}

export function openLedger(state: GameState, onFocusCity?: (cityId: string) => void) {
  if (onFocusCity) _focusCallback = onFocusCity;
  const el = injectLedgerDOM();
  el.classList.remove('hidden');

  // Wire filter buttons
  el.querySelectorAll<HTMLButtonElement>('.ledger-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.ledger-filter').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      _currentFilter = (btn.dataset.filter as LedgerFilter) ?? 'all';
      renderTable(state, _currentFilter);
    });
  });

  // Wire close
  document.getElementById('ledger-close')?.addEventListener('click', closeLedger);

  // Close on backdrop click
  el.addEventListener('click', (e) => {
    if (e.target === el) closeLedger();
  });

  renderTable(state, _currentFilter);
}

export function closeLedger() {
  document.getElementById('ledger-overlay')?.classList.add('hidden');
}

export function isLedgerOpen(): boolean {
  return !(document.getElementById('ledger-overlay')?.classList.contains('hidden') ?? true);
}

export function toggleLedger(state: GameState, onFocusCity?: (cityId: string) => void) {
  if (isLedgerOpen()) {
    closeLedger();
  } else {
    openLedger(state, onFocusCity);
  }
}
