import { loadSelectedRepoPaths, saveSelectedRepoPaths, type ScannedRepo } from '../map';
import { upsertManualRepoEntry, removeManualRepoEntry, updateManualRepoCoord, loadManualLayout } from '../manualLayout';
import { showNotification } from './notificationBanner';

let isOpen = false;
let _rendererRef: { setPlacingMode(active: boolean): void; getPlacingMode(): boolean } | null = null;
let _onPickTileCb: ((coord: { q: number; r: number }) => void) | null = null;
let _placingNewCity = false; // true if we're placing a new city
let selectedRepo: ScannedRepo | null = null;

interface RepoPickResponse {
  ok: boolean;
  repo?: ScannedRepo;
  error?: string;
}

function getPanel(): HTMLElement | null {
  return document.getElementById('construction-panel');
}

export function isConstructionPanelOpen(): boolean {
  return isOpen;
}

export function setRendererRef(
  renderer: { setPlacingMode(active: boolean): void; getPlacingMode(): boolean },
) {
  _rendererRef = renderer;
}

export function openConstructionPanel(): void {
  isOpen = true;
  let panel = getPanel();
  if (!panel) {
    buildDOM();
    panel = getPanel();
  }
  panel?.classList.remove('hidden');
  refreshCityList();
  refreshRepoSelect();
}

export function closeConstructionPanel(): void {
  isOpen = false;
  // Do NOT clear _onPickTileCb here — placing mode keeps callback alive while panel is closed.
  getPanel()?.classList.add('hidden');
}

export function toggleConstructionPanel(): void {
  if (isOpen) closeConstructionPanel();
  else openConstructionPanel();
}

async function pickRepoFromSystem(): Promise<ScannedRepo> {
  const res = await fetch('/api/repo/pick', { method: 'POST' });
  const data = (await res.json()) as RepoPickResponse;
  if (!res.ok || !data.repo) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.repo;
}

async function inspectRepoPath(path: string): Promise<ScannedRepo> {
  const res = await fetch('/api/repo/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const data = (await res.json()) as RepoPickResponse;
  if (!res.ok || !data.repo) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.repo;
}

function upsertSelection(repoPath: string): void {
  const selected = loadSelectedRepoPaths();
  if (selected === null) return;
  selected.add(repoPath);
  saveSelectedRepoPaths([...selected]);
}

function refreshCityList(): void {
  const list = document.getElementById('construction-city-list');
  if (!list) return;
  const store = loadManualLayout();
  if (store.entries.length === 0) {
    list.innerHTML = '<p class="construction-empty">No hay ciudades manuales. Agrega un repo primero.</p>';
    return;
  }
  list.innerHTML = store.entries
    .map(
      (entry) => `
    <div class="construction-city-item" data-path="${escapeHtml(entry.repoPath)}">
      <div class="construction-city-info">
        <span class="construction-city-name">${escapeHtml(entry.repoName)}</span>
        <span class="construction-city-coord">(${entry.coord.q}, ${entry.coord.r})</span>
      </div>
      <div class="construction-city-actions">
        <button class="btn-icon construction-move-city" title="Mover ciudad">✥</button>
        <button class="btn-icon construction-delete-city" title="Eliminar ciudad">🗑</button>
      </div>
    </div>
  `,
    )
    .join('');

  // Wire move buttons
  list.querySelectorAll<HTMLButtonElement>('.construction-move-city').forEach((btn) => {
    btn.addEventListener('click', () => {
      const path = btn.closest('.construction-city-item')?.getAttribute('data-path');
      if (!path || !_rendererRef) return;
      _onPickTileCb = (coord) => {
        updateManualRepoCoord(path, coord);
        window.location.reload();
      };
      _rendererRef.setPlacingMode(true);
      closeConstructionPanel();
      showNotification({ type: 'info', title: 'Mover ciudad', body: 'Haz click en una casilla vacia del mapa.' });
    });
  });

  // Wire delete buttons
  list.querySelectorAll<HTMLButtonElement>('.construction-delete-city').forEach((btn) => {
    btn.addEventListener('click', () => {
      const path = btn.closest('.construction-city-item')?.getAttribute('data-path');
      if (!path) return;
      if (confirm('Eliminar esta ciudad del mapa?')) {
        removeManualRepoEntry(path);
        const selected = loadSelectedRepoPaths();
        if (selected) {
          selected.delete(path);
          saveSelectedRepoPaths([...selected]);
        }
        window.location.reload();
      }
    });
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function refreshRepoSelect(): void {
  const select = document.getElementById('construction-repo-select') as HTMLSelectElement;
  if (!select) return;
  
  const selectedPaths = loadSelectedRepoPaths();
  const manualLayout = loadManualLayout();
  
  // Get repos not in manualLayout
  const placedPaths = new Set(manualLayout.entries.map(e => e.repoPath));
  const unplaced: string[] = [];
  
  if (selectedPaths) {
    for (const path of selectedPaths) {
      if (!placedPaths.has(path)) {
        unplaced.push(path);
      }
    }
  }
  
  // Also fetch repo names (try to get from /api/repos)
  select.innerHTML = '<option value="">-- Selecciona un repo --</option>' +
    unplaced.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
}

function buildDOM(): void {
  const app = document.getElementById('app');
  if (!app) return;
  const panel = document.createElement('div');
  panel.id = 'construction-panel';
  panel.className = 'construction-panel hidden';
  panel.innerHTML = `
    <div class="construction-panel-card">
      <header class="construction-panel-header">
        <h3>Modo construcción</h3>
        <button id="construction-close" class="icon-btn" aria-label="Cerrar">✕</button>
      </header>
      <div class="construction-panel-body">
        <p class="construction-help">Agrega un nuevo repo o administra ciudades existentes.</p>

        <div class="construction-section">
          <h4>➕ Nueva ciudad</h4>
          <div class="construction-row">
            <label>Repositorio sin colocar</label>
            <select id="construction-repo-select" class="construction-select">
              <option value="">-- Selecciona un repo --</option>
            </select>
          </div>
          <div class="construction-row">
            <label>Ruta personalizada</label>
            <div class="construction-inline">
              <input id="construction-repo-path" type="text" placeholder="/ruta/al/repo" />
              <button id="construction-pick-repo" class="btn-secondary" type="button">Dialogo</button>
            </div>
            <div class="construction-inline">
              <span></span>
              <button id="construction-inspect-repo" class="btn-secondary" type="button">Inspeccionar ruta</button>
            </div>
          </div>
          <div class="construction-row">
            <div class="construction-inline">
              <button id="construction-pick-tile" class="btn-accent" type="button">🎯 Elegir casilla en mapa</button>
              <span id="construction-tile-label" class="tile-label">Sin casilla seleccionada</span>
            </div>
          </div>
      <div id="construction-preview" class="construction-preview">Selecciona un repositorio y elige una casilla en el mapa.</div>
      <div id="construction-error" class="construction-error hidden"></div>
    </div>

    <div class="construction-divider"></div>

    <div class="construction-section">
      <h4>🏙️ Ciudades existentes</h4>
      <div id="construction-city-list" class="construction-city-list">
        <p class="construction-empty">Cargando...</p>
      </div>
    </div>
  </div>
  <footer class="construction-panel-footer">
    <button id="construction-cancel" class="btn-secondary" type="button">Cancelar</button>
  </footer>
    </div>
  `;
  app.appendChild(panel);

  const close = () => closeConstructionPanel();
  panel.querySelector<HTMLButtonElement>('#construction-close')?.addEventListener('click', close);
  panel.querySelector<HTMLButtonElement>('#construction-cancel')?.addEventListener('click', close);

  const pathInput = panel.querySelector<HTMLInputElement>('#construction-repo-path')!;
  const tileLabel = panel.querySelector<HTMLElement>('#construction-tile-label')!;
  const preview = panel.querySelector<HTMLElement>('#construction-preview')!;
  const error = panel.querySelector<HTMLElement>('#construction-error')!;

  panel.querySelector<HTMLButtonElement>('#construction-pick-repo')?.addEventListener('click', () => {
    void (async () => {
      error.classList.add('hidden');
      try {
        selectedRepo = await pickRepoFromSystem();
        pathInput.value = selectedRepo.path;
        // Also update dropdown
        const select = document.getElementById('construction-repo-select') as HTMLSelectElement;
        if (select) {
          // Add option if not exists
          let found = false;
          for (const opt of select.options) {
            if (opt.value === selectedRepo.path) { found = true; break; }
          }
          if (!found) {
            const opt = document.createElement('option');
            opt.value = selectedRepo.path;
            opt.textContent = selectedRepo.name;
            select.appendChild(opt);
          }
          select.value = selectedRepo.path;
        }
      } catch (e) {
        error.textContent = `No se pudo abrir el selector (${e instanceof Error ? e.message : 'error desconocido'}).`;
        error.classList.remove('hidden');
      }
    })();
  });

  // Dropdown change handler
  panel.querySelector<HTMLSelectElement>('#construction-repo-select')?.addEventListener('change', () => {
    const select = document.getElementById('construction-repo-select') as HTMLSelectElement;
    const path = select.value;
    if (!path) {
      selectedRepo = null;
    } else {
      // Try to get repo info from /api/repos
      void (async () => {
        try {
          const res = await fetch('/api/repos');
          if (res.ok) {
            const repos = await res.json() as Array<{ name: string; path: string }>;
            const found = repos.find(r => r.path === path);
            if (found) {
              selectedRepo = found as ScannedRepo;
            } else {
              selectedRepo = { name: path, path } as ScannedRepo;
            }
          } else {
            selectedRepo = { name: path, path } as ScannedRepo;
          }
        } catch {
          selectedRepo = { name: path, path } as ScannedRepo;
        }
        pathInput.value = path;
      })();
    }
  });

  panel.querySelector<HTMLButtonElement>('#construction-inspect-repo')?.addEventListener('click', () => {
    void (async () => {
      error.classList.add('hidden');
      try {
        const p = pathInput.value.trim();
        if (!p) throw new Error('Ruta vacia');
        selectedRepo = await inspectRepoPath(p);
        pathInput.value = selectedRepo.path;
      } catch (e) {
        error.textContent = `No se pudo inspeccionar la ruta (${e instanceof Error ? e.message : 'error desconocido'}).`;
        error.classList.remove('hidden');
      }
    })();
  });

  panel.querySelector<HTMLButtonElement>('#construction-pick-tile')?.addEventListener('click', () => {
    if (!_rendererRef) {
      error.textContent = 'Renderer no disponible.';
      error.classList.remove('hidden');
      return;
    }
    if (!selectedRepo) {
      error.textContent = 'Selecciona un repositorio primero.';
      error.classList.remove('hidden');
      return;
    }
    error.classList.add('hidden');
    _onPickTileCb = (coord) => {
      // Place city directly (Civ-like)
      upsertManualRepoEntry({
        repoPath: selectedRepo.path,
        repoName: selectedRepo.name,
        coord,
        addedAt: Date.now(),
        source: 'manual',
      });
      upsertSelection(selectedRepo.path);
      window.location.reload();
    };
    _rendererRef.setPlacingMode(true);
    closeConstructionPanel();
    showNotification({ type: 'info', title: 'Nueva ciudad', body: `Haz click en una casilla para colocar "${selectedRepo.name}".` });
  });

}

/** Called by renderer when an empty tile is clicked while placing. */
export function notifyTilePicked(coord: { q: number; r: number }): void {
  if (_onPickTileCb) {
    _onPickTileCb(coord);
    _onPickTileCb = null;
  }
  if (_rendererRef) {
    _rendererRef.setPlacingMode(false);
  }
}
