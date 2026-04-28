// ─── RepoCiv — City Panel ─────────────────────────────────────────────────────
import type { City, Building, Tile } from '../types.ts';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
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

export function openCityPanel(city: City, activeBuildings: Building[], tile?: Tile) {
  const panel = document.getElementById('city-panel');
  if (!panel) return;
  panel.classList.remove('hidden');

  setText('city-panel-name', city.name.toUpperCase());
  setText('city-repo-name', city.name.toLowerCase());

  // Static data available immediately from city + tile
  if (tile) {
    const terrainExt = tile.terrain === 'forest' ? '% .py' :
                       tile.terrain === 'plains' ? '% .ts' :
                       tile.terrain === 'mountain' ? '% .rs/.go' : '';
    const terrainLabel = TERRAIN_LABEL[tile.terrain] ?? tile.terrain;
    setText('city-terrain', terrainExt ? `${terrainLabel} (${city.population}${terrainExt})` : terrainLabel);
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
  const missionsEl = document.getElementById('city-missions-list');
  if (missionsEl) {
    if (activeBuildings.length === 0) {
      missionsEl.innerHTML = '<div class="city-item" style="color:var(--text-dim)">Sin misiones activas</div>';
    } else {
      missionsEl.innerHTML = activeBuildings.map(b => {
        const icon = b.state === 'complete' ? '✓' : b.state === 'failed' ? '✗' : '◉';
        const color = b.state === 'complete' ? 'var(--civ-food)' :
                      b.state === 'failed' ? 'var(--civ-happiness)' : 'var(--text-primary)';
        const pct = b.state === 'building' ? ` (${Math.round(b.progress)}%)` : '';
        return `<div class="city-item" style="color:${color}">${icon} ${esc(b.name)}${pct}</div>`;
      }).join('');
    }
  }

  // Async: fetch real git + files data
  void fetchCityGit(city.name);
  void fetchCityFiles(city.name);
}

async function fetchCityGit(repoName: string) {
  const gitDetailsEl = document.getElementById('city-git-details');
  if (!gitDetailsEl) return;
  gitDetailsEl.innerHTML = '<div class="city-item" style="color:var(--text-dim)">cargando git…</div>';
  try {
    const res = await fetch(`/api/git/${encodeURIComponent(repoName)}`);
    if (!res.ok) {
      setText('city-git-branch', '—');
      setText('city-git-status', 'sin git');
      gitDetailsEl.innerHTML = '<div class="city-item" style="color:var(--text-dim)">No es un repo git</div>';
      return;
    }
    const data = await res.json() as { branch: string; lastCommit: string; changes: string[] };
    const [hash, subject, ago] = data.lastCommit.split('|');
    setText('city-git-branch', data.branch || 'main');
    setText('city-git-status', data.changes.length === 0 ? 'clean' : `${data.changes.length} cambios`);
    gitDetailsEl.innerHTML = [
      `<div class="city-item" style="color:var(--gold-bright)">⎇ ${esc(data.branch)}</div>`,
      hash ? `<div class="city-item" style="color:var(--text-dim); font-size:11px">${esc(hash)} · ${esc(subject ?? '')} · ${esc(ago ?? '')}</div>` : '',
      ...data.changes.slice(0, 8).map(c => {
        const code = c.trim()[0] ?? '?';
        const color = code === 'M' ? 'var(--civ-gold)' :
                      code === 'A' ? 'var(--civ-food)' :
                      code === 'D' ? 'var(--civ-happiness)' : 'var(--text-dim)';
        return `<div class="city-item" style="color:${color}">${esc(c)}</div>`;
      }),
    ].join('');
  } catch {
    gitDetailsEl.innerHTML = '<div class="city-item" style="color:var(--civ-happiness)">Error al leer git</div>';
  }
}

async function fetchCityFiles(repoName: string) {
  const filesEl = document.getElementById('city-files-list');
  if (!filesEl) return;
  filesEl.innerHTML = '<div class="city-item" style="color:var(--text-dim)">cargando archivos…</div>';
  try {
    const res = await fetch(`/api/files/${encodeURIComponent(repoName)}`);
    if (!res.ok) {
      filesEl.innerHTML = '<div class="city-item" style="color:var(--text-dim)">—</div>';
      return;
    }
    const data = await res.json() as { files: string[] };
    filesEl.innerHTML = data.files.length === 0
      ? '<div class="city-item" style="color:var(--text-dim)">vacío</div>'
      : data.files.slice(0, 12).map(f =>
          `<div class="city-item" style="padding:1px 0">${esc(f)}</div>`
        ).join('');
  } catch {
    filesEl.innerHTML = '<div class="city-item" style="color:var(--civ-happiness)">Error al leer archivos</div>';
  }
}

export function closeCityPanel() {
  document.getElementById('city-panel')?.classList.add('hidden');
}

export function isCityPanelOpen(): boolean {
  return !document.getElementById('city-panel')?.classList.contains('hidden');
}

export function wireCityPanel() {
  document.getElementById('city-panel-close')?.addEventListener('click', closeCityPanel);
  document.getElementById('btn-city-close')?.addEventListener('click', closeCityPanel);
}
