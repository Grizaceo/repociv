// ─── RepoCiv — City Panel ─────────────────────────────────────────────────────
import type { City, Building, Tile } from '../types.ts';
import type { CityLabStatus } from '../labhubStatus.ts';
import { formatLabStatusLabel, formatLabSourceLabel } from '../labhubStatus.ts';
import { trapFocus } from './focusTrap.ts';
import { getLatestNews, markNewsAsRead } from '../bridge.ts';
import { trackCityVisit } from './analytics.ts';

let _cityPanelCleanup: (() => void) | null = null;

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function setText(id: string, text: string) {
  const e = document.getElementById(id);
  if (e) e.textContent = text;
}

const TERRAIN_LABEL: Record<string, string> = {
  plains: '🌾 Llanuras',
  forest: '🌲 Bosque',
  mountain: '⛰ Montaña',
  desert: '🏜 Desierto',
  ocean: '🌊 Océano',
  ice: '❄ Helado',
  hills: '⛺ Colinas',
};

const SESSION_LABEL: Record<string, string> = {
  bright: '🔆 Bright (activo)',
  normal: '💡 Normal',
  fog: '🌫 Fog (inactivo)',
};

const SKILL_LABEL: Record<string, string> = {
  ok: '⚡ OK',
  stale: '⚠ Desactualizado',
  broken: '✗ Roto',
};

export function openCityPanel(
  city: City,
  activeBuildings: Building[],
  tile?: Tile,
  labStatus?: CityLabStatus | null,
) {
  const panel = document.getElementById('city-panel');
  if (!panel) return;
  // Count cold opens AND city→city switches, but not same-city data refreshes
  // (openCityPanel runs twice per open: loading state, then async labStatus).
  if (panel.classList.contains('hidden') || panel.dataset['cityId'] !== city.id) {
    trackCityVisit();
  }
  panel.classList.remove('hidden');
  panel.dataset['cityId'] = city.id;
  panel.dataset['cityName'] = city.name;
  panel.dataset['repoPath'] = city.repoPath ?? '';
  panel.dataset['labStatus'] = labStatus ? JSON.stringify(labStatus) : '';
  _cityPanelCleanup?.();
  _cityPanelCleanup = trapFocus(panel);

  setText('city-panel-name', city.name.toUpperCase());
  setText('city-repo-name', city.name.toLowerCase());

  // Static data available immediately from city + tile
  if (tile) {
    const terrainExt =
      tile.terrain === 'forest'
        ? '% .py'
        : tile.terrain === 'plains'
          ? '% .ts'
          : tile.terrain === 'mountain'
            ? '% .rs/.go'
            : '';
    const terrainLabel = TERRAIN_LABEL[tile.terrain] ?? tile.terrain;
    setText(
      'city-terrain',
      terrainExt ? `${terrainLabel} (${city.population}${terrainExt})` : terrainLabel,
    );
    setText('city-session', SESSION_LABEL[tile.sessionTint ?? 'fog'] ?? '—');
    setText('city-skill', SKILL_LABEL[tile.skillHealth ?? 'broken'] ?? '—');
    const res = tile.resources;
    setText('city-res-gold', res.gold.toLocaleString());
    setText('city-res-sci', res.science.toString());
    setText('city-res-prod', res.production.toString());
  } else {
    setText('city-terrain', `${city.population} archivos`);
    setText('city-session', '—');
    setText('city-skill', '—');
    setText('city-res-gold', city.population.toLocaleString());
    setText('city-res-sci', '—');
    setText('city-res-prod', activeBuildings.length.toString());
  }

  // Active buildings → missions list
  const labStatusEl = document.getElementById('city-lab-status');
  if (labStatusEl) {
    if (labStatus == null || labStatus === undefined) {
      labStatusEl.innerHTML =
        '<div class="city-item" style="color:var(--text-dim);font-style:italic;">Consultando Institutum…</div>';
    } else {
      const sourceLabel = formatLabSourceLabel(labStatus);
      const sourceColor = labStatus.source === 'live' ? 'var(--ui-green)' : 'var(--ui-accent-gold)';
      labStatusEl.innerHTML = [
        `<div class="city-item" style="color:var(--ui-green)">🔬 ${esc(formatLabStatusLabel(labStatus))}</div>`,
        `<div class="city-item" style="color:var(--text-dim);font-size:11px">${esc(labStatus.lastMetric || labStatus.labId)}</div>`,
        `<div class="city-item" style="color:${sourceColor};font-size:10px">${esc(sourceLabel)}</div>`,
      ].join('');
    }
  }

  const institutumBtn = document.getElementById('btn-city-institutum') as HTMLButtonElement | null;
  if (institutumBtn) {
    const labhubUrl = labStatus?.links.labhub;
    if (labhubUrl) {
      institutumBtn.disabled = false;
      institutumBtn.title = `Abrir Institutum en ${labhubUrl}`;
    } else {
      institutumBtn.disabled = true;
      institutumBtn.title = 'Institutum offline — sin URL disponible';
    }
  }
  const logsBtn = document.getElementById('btn-city-logs') as HTMLButtonElement | null;
  if (logsBtn) {
    const logsUrl = labStatus?.links.logs;
    if (logsUrl) {
      logsBtn.disabled = false;
      logsBtn.title = `Ver logs: ${logsUrl}`;
    } else {
      logsBtn.disabled = true;
      logsBtn.title = 'Sin ruta de logs disponible';
    }
  }

  // Active buildings → missions list
  const missionsEl = document.getElementById('city-missions-list');
  if (missionsEl) {
    if (activeBuildings.length === 0) {
      missionsEl.innerHTML =
        '<div class="city-item" style="color:var(--text-dim)">Sin misiones activas</div>';
    } else {
      missionsEl.innerHTML = activeBuildings
        .map((b) => {
          const icon = b.state === 'complete' ? '✓' : b.state === 'failed' ? '✗' : '◉';
          const color =
            b.state === 'complete'
              ? 'var(--civ-food)'
              : b.state === 'failed'
                ? 'var(--civ-happiness)'
                : 'var(--text-primary)';
          const pct = b.state === 'building' ? ` (${Math.round(b.progress)}%)` : '';
          return `<div class="city-item" style="color:${color}" title="${esc(b.name)}${pct}">${icon} ${esc(b.name)}${pct}</div>`;
        })
        .join('');
    }
  }

  // Async: fetch real git + files data
  void fetchCityGit(city.name);
  void fetchCityFiles(city.name);
}

async function fetchCityGit(repoName: string) {
  const gitDetailsEl = document.getElementById('city-git-details');
  if (!gitDetailsEl) return;
  gitDetailsEl.innerHTML =
    '<div class="city-item" style="color:var(--text-dim)">cargando git…</div>';
  try {
    const res = await fetch(`/api/git/${encodeURIComponent(repoName)}`);
    if (!res.ok) {
      setText('city-git-branch', '—');
      setText('city-git-status', 'sin git');
      gitDetailsEl.innerHTML =
        '<div class="city-item" style="color:var(--text-dim)">No es un repo git</div>';
      return;
    }
    const data = (await res.json()) as { branch: string; lastCommit: string; changes: string[] };
    const [hash, subject, ago] = data.lastCommit.split('|');
    setText('city-git-branch', data.branch || 'main');
    setText(
      'city-git-status',
      data.changes.length === 0 ? 'clean' : `${data.changes.length} cambios`,
    );
    gitDetailsEl.innerHTML = [
      `<div class="city-item" style="color:var(--gold-bright)">⎇ ${esc(data.branch)}</div>`,
      hash
        ? `<div class="city-item" style="color:var(--text-dim); font-size:11px">${esc(hash)} · ${esc(subject ?? '')} · ${esc(ago ?? '')}</div>`
        : '',
      ...data.changes.slice(0, 8).map((c) => {
        const code = c.trim()[0] ?? '?';
        const color =
          code === 'M'
            ? 'var(--civ-gold)'
            : code === 'A'
              ? 'var(--civ-food)'
              : code === 'D'
                ? 'var(--civ-happiness)'
                : 'var(--text-dim)';
        return `<div class="city-item" style="color:${color}" title="${esc(c)}">${esc(c)}</div>`;
      }),
    ].join('');
  } catch {
    gitDetailsEl.innerHTML =
      '<div class="city-item" style="color:var(--civ-happiness)">Error al leer git</div>';
  }
}

async function fetchCityFiles(repoName: string) {
  const filesEl = document.getElementById('city-files-list');
  if (!filesEl) return;

  // Interceptar la ciudad CDAILY para mostrar el feed en lugar de archivos
  if (repoName.toLowerCase() === 'cdaily') {
    filesEl.innerHTML =
      '<div class="city-item" style="color:var(--text-dim)">Leyendo feed de noticias...</div>';
    try {
      const articles = await getLatestNews();
      if (articles.length === 0) {
        filesEl.innerHTML =
          '<div class="city-item" style="color:var(--text-dim)">Sin noticias pendientes. ¡Paz imperial!</div>';
        return;
      }
      filesEl.innerHTML = articles
        .map(
          (art) => `
        <div class="city-item" style="border-bottom:1px solid var(--ui-border);padding:6px 0;margin-bottom:4px;">
          <div style="font-size:11px;color:var(--ui-accent-gold);font-weight:bold;">📰 ${esc(art.blogName)}</div>
          <div style="font-size:13px;font-weight:500;margin:2px 0;">
            <a href="${esc(art.url)}" target="_blank" style="color:var(--text-primary);text-decoration:none;border-bottom:1px dashed var(--text-dim);">${esc(art.title)}</a>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:3px;">
            <span style="font-size:10px;color:var(--text-dim);">${new Date(art.publishedDate).toLocaleDateString()}</span>
            <button class="btn-read" data-id="${art.id}" style="background:none;border:none;color:var(--ui-green);font-size:11px;cursor:pointer;padding:2px 4px;">✓ Leído</button>
          </div>
        </div>
      `,
        )
        .join('');

      filesEl.querySelectorAll<HTMLButtonElement>('.btn-read').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = parseInt(btn.getAttribute('data-id') ?? '0', 10);
          if (id && (await markNewsAsRead(id))) {
            fetchCityFiles('cdaily');
          }
        });
      });
    } catch {
      filesEl.innerHTML =
        '<div class="city-item" style="color:var(--civ-happiness)">Error al cargar la Gaceta Exterior</div>';
    }
    return;
  }

  filesEl.innerHTML =
    '<div class="city-item" style="color:var(--text-dim)">cargando archivos…</div>';
  try {
    const res = await fetch(`/api/files/${encodeURIComponent(repoName)}`);
    if (!res.ok) {
      filesEl.innerHTML = '<div class="city-item" style="color:var(--text-dim)">—</div>';
      return;
    }
    const data = (await res.json()) as { files: string[] };
    filesEl.innerHTML =
      data.files.length === 0
        ? '<div class="city-item" style="color:var(--text-dim)">vacío</div>'
        : data.files
            .slice(0, 12)
            .map((f) => `<div class="city-item" style="padding:1px 0" title="${esc(f)}">${esc(f)}</div>`)
            .join('');
  } catch {
    filesEl.innerHTML =
      '<div class="city-item" style="color:var(--civ-happiness)">Error al leer archivos</div>';
  }
}

export function closeCityPanel() {
  _cityPanelCleanup?.();
  _cityPanelCleanup = null;
  const panel = document.getElementById('city-panel');
  if (panel) {
    delete panel.dataset['cityId'];
    delete panel.dataset['cityName'];
    delete panel.dataset['repoPath'];
    delete panel.dataset['labStatus'];
    panel.classList.add('hidden');
  }
}

export function isCityPanelOpen(): boolean {
  return !document.getElementById('city-panel')?.classList.contains('hidden');
}

let isMinimized = false;

function toggleMinimizeCityPanel() {
  const body = document.getElementById('city-panel-body');
  const footer = document.getElementById('city-panel-footer');
  isMinimized = !isMinimized;
  if (body) body.style.display = isMinimized ? 'none' : '';
  if (footer) footer.style.display = isMinimized ? 'none' : '';
}

let isDragging = false;
let dragStartX = 0,
  dragStartY = 0,
  initialX = 0,
  initialY = 0;

export function wireCityPanel() {
  document.getElementById('city-panel-close')?.addEventListener('click', closeCityPanel);
  document.getElementById('btn-city-close')?.addEventListener('click', closeCityPanel);
  document
    .getElementById('city-panel-minimize')
    ?.addEventListener('click', toggleMinimizeCityPanel);
  document.getElementById('btn-city-mission')?.addEventListener('click', () => {
    const panel = document.getElementById('city-panel');
    const cityId = panel?.dataset['cityId'];
    if (!cityId) return;
    window.dispatchEvent(
      new CustomEvent('repociv:city-mission-request', {
        detail: {
          cityId,
          repoPath: panel?.dataset['repoPath'] ?? '',
          labStatus: panel?.dataset['labStatus'] ?? '',
        },
      }),
    );
  });
  document.getElementById('btn-city-bibliotheca')?.addEventListener('click', () => {
    const panel = document.getElementById('city-panel');
    const cityId = panel?.dataset['cityId'];
    if (!cityId) return;
    window.dispatchEvent(
      new CustomEvent('repociv:open-bibliotheca-request', {
        detail: { cityId, repoPath: panel?.dataset['repoPath'] ?? '' },
      }),
    );
  });
  document.getElementById('btn-city-local')?.addEventListener('click', () => {
    const panel = document.getElementById('city-panel');
    const cityId = panel?.dataset['cityId'];
    if (!cityId) return;
    window.dispatchEvent(
      new CustomEvent('repociv:open-local-view-request', {
        detail: { cityId, repoPath: panel?.dataset['repoPath'] ?? '' },
      }),
    );
  });
  document.getElementById('btn-city-institutum')?.addEventListener('click', () => {
    const panel = document.getElementById('city-panel');
    const cityId = panel?.dataset['cityId'];
    if (!cityId) return;
    window.dispatchEvent(
      new CustomEvent('repociv:open-institutum-request', {
        detail: { cityId, repoPath: panel?.dataset['repoPath'] ?? '' },
      }),
    );
  });
  document.getElementById('btn-city-logs')?.addEventListener('click', () => {
    const panel = document.getElementById('city-panel');
    const cityId = panel?.dataset['cityId'];
    if (!cityId) return;
    window.dispatchEvent(
      new CustomEvent('repociv:open-city-logs-request', {
        detail: {
          cityId,
          repoPath: panel?.dataset['repoPath'] ?? '',
          labStatus: panel?.dataset['labStatus'] ?? '',
        },
      }),
    );
  });

  const header = document.getElementById('city-panel-header');
  const panel = document.getElementById('city-panel');
  if (header && panel) {
    header.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      isDragging = true;
      const rect = panel.getBoundingClientRect();
      if (panel.style.transform === '') {
        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        panel.style.transform = 'none';
        panel.style.bottom = 'auto';
      }
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      initialX = panel.offsetLeft;
      initialY = panel.offsetTop;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      panel.style.left = `${initialX + (e.clientX - dragStartX)}px`;
      panel.style.top = `${initialY + (e.clientY - dragStartY)}px`;
    });
    window.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }
}
