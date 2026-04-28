// ─── RepoCiv — City Panel ─────────────────────────────────────────────────────
import type { City, Building } from '../types.ts';

export function openCityPanel(city: City, _activeBuildings: Building[]) {
  const panel = document.getElementById('city-panel');
  if (!panel) return;
  panel.classList.remove('hidden');

  const setText = (id: string, text: string) => { const e = document.getElementById(id); if(e) e.textContent = text; };
  setText('city-panel-name', city.name.toUpperCase());
  setText('city-repo-name', city.name.toLowerCase());

  // Mocks delay para simular fetch
  setTimeout(() => {
    setText('city-git-branch', 'main');
    setText('city-git-status', 'clean');
    setText('city-terrain', `🌲 Bosque (${city.population * 10}% .ts)`);
    setText('city-session', '🔆 Bright (Actividad reciente)');
    setText('city-skill', '⚡ OK');
    setText('city-res-gold', Math.floor(Math.random() * 2000).toLocaleString());
    setText('city-res-sci', Math.floor(Math.random() * 200).toString());
    setText('city-res-prod', Math.floor(Math.random() * 100).toString());
    
    const missionsEl = document.getElementById('city-missions-list');
    if (missionsEl) missionsEl.innerHTML = '<div class="city-item" style="color:var(--text-primary)">◉ Analizar dataset (2h ago)</div><div class="city-item" style="color:var(--text-dim)">○ Revisar README (pending)</div>';

    const gitEl = document.getElementById('city-git-details');
    if (gitEl) gitEl.innerHTML = '<div class="city-item" style="color:var(--text-primary)">⎇ main · a3f9b2c</div><div class="city-item" style="color:var(--text-dim)">3 files changed</div>';

    const filesEl = document.getElementById('city-files-list');
    if (filesEl) filesEl.innerHTML = '<div class="city-item" style="color:var(--text-primary)">src/main.ts (mod 2h)</div><div class="city-item" style="color:var(--text-dim)">docs/README.md (clean)</div>';
  }, 400);
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

