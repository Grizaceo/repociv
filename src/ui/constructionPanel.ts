import {
  addSelectedRepoPath,
  loadSelectedRepoPaths,
  removeSelectedRepoPath,
  saveSelectedRepoPaths,
  type ScannedRepo,
} from '../map';
import { bridgeHeaders } from '../bridgeEnv.ts';
import { upsertManualRepoEntry, removeManualRepoEntry, loadManualLayout } from '../manualLayout';
import { showNotification } from './notificationBanner';
import { trackPanelOpen } from './analytics.ts';
import { resetTourState } from './firstRunTour.ts';

let isOpen = false;
let _rendererRef: {
  setPlacingMode(active: boolean): void;
  getPlacingMode(): boolean;
  setCityRelocateMode(active: boolean, panelRepoPath?: string | null): void;
  getCityRelocateMode(): boolean;
} | null = null;
let _onPickTileCb: ((coord: { q: number; r: number }) => void) | null = null;
let selectedRepo: ScannedRepo | null = null;
let selectedParentMap: ParentFolderMapPreview | null = null;
let inspectRequestId = 0;
let focusBeforeOpen: HTMLElement | null = null;

// Callbacks for dynamic city add/delete (no reload)
type CityAddedCallback = (repo: ScannedRepo, coord: { q: number; r: number }) => void;
type CityDeletedCallback = (repoPath: string) => void;

let _onCityAdded: CityAddedCallback | null = null;
let _onCityDeleted: CityDeletedCallback | null = null;

export function setOnCityAddedCb(cb: CityAddedCallback): void {
  _onCityAdded = cb;
}

export function setOnCityDeletedCb(cb: CityDeletedCallback): void {
  _onCityDeleted = cb;
}

interface RepoPickResponse {
  ok: boolean;
  repo?: ScannedRepo;
  error?: string;
}

interface ParentFolderMapPreview {
  rootPath: string;
  repos: ScannedRepo[];
}

interface RepoInspectResponse extends RepoPickResponse {
  parentMap?: ParentFolderMapPreview;
}

interface ParentFolderMapApplyResponse {
  ok: boolean;
  rootPath?: string;
  selectedRepoIds?: string[];
  selectedRepoPaths?: string[];
  error?: string;
}

function getPanel(): HTMLElement | null {
  return document.getElementById('construction-panel');
}

export function isConstructionPanelOpen(): boolean {
  return isOpen;
}

export function setRendererRef(renderer: {
  setPlacingMode(active: boolean): void;
  getPlacingMode(): boolean;
  setCityRelocateMode(active: boolean, panelRepoPath?: string | null): void;
  getCityRelocateMode(): boolean;
}) {
  _rendererRef = renderer;
}

export function closeConstructionPanel(): void {
  isOpen = false;
  _rendererRef?.setCityRelocateMode(false);
  // Do NOT clear _onPickTileCb here — placing mode keeps callback alive while panel is closed.
  getPanel()?.classList.add('hidden');
  const restoreTarget = focusBeforeOpen;
  focusBeforeOpen = null;
  restoreTarget?.focus();
}

export function openConstructionPanel(): void {
  _rendererRef?.setCityRelocateMode(false);
  if (!isOpen) {
    trackPanelOpen('construction');
    focusBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  isOpen = true;
  let panel = getPanel();
  if (!panel) {
    buildDOM();
    panel = getPanel();
  }
  panel?.classList.remove('hidden');
  refreshCityList();
  refreshRepoSelect();
  requestAnimationFrame(() => {
    panel?.querySelector<HTMLInputElement>('#construction-repo-path')?.focus();
  });
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

async function inspectRepoPath(path: string): Promise<RepoInspectResponse> {
  const res = await fetch('/api/repo/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const data = (await res.json()) as RepoInspectResponse;
  if (!res.ok || !data.repo) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function loadParentFolderMap(path: string): Promise<ParentFolderMapApplyResponse> {
  const res = await fetch('/api/map-from-parent', {
    method: 'POST',
    headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ path }),
  });
  const data = (await res.json()) as ParentFolderMapApplyResponse;
  if (!res.ok || !data.rootPath) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function upsertSelection(repoPath: string): Promise<void> {
  const selected = await addSelectedRepoPath(repoPath);
  saveSelectedRepoPaths([...selected]);
}

export function refreshCityList(): void {
  const list = document.getElementById('construction-city-list');
  if (!list) return;
  const store = loadManualLayout();
  if (store.entries.length === 0) {
    list.innerHTML =
      '<p class="construction-empty">No hay ciudades manuales. Agrega un repo primero.</p>';
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
      closeConstructionPanel();
      _rendererRef.setCityRelocateMode(true, path);
      showNotification({
        type: 'info',
        title: 'Mover ciudad',
        body: 'Arrastra la ciudad en el mapa a una casilla válida (Escape para cancelar).',
      });
    });
  });

  // Wire delete buttons
  list.querySelectorAll<HTMLButtonElement>('.construction-delete-city').forEach((btn) => {
    btn.addEventListener('click', () => {
      const path = btn.closest('.construction-city-item')?.getAttribute('data-path');
      if (!path) return;
      if (confirm('Eliminar esta ciudad del mapa?')) {
        removeManualRepoEntry(path);
        void removeSelectedRepoPath(path)
          .then((selected) => saveSelectedRepoPaths([...selected]))
          .catch(() => {
            const selected = loadSelectedRepoPaths();
            if (selected) {
              selected.delete(path);
              saveSelectedRepoPaths([...selected]);
            }
          });
        // Notify main.ts to delete city dynamically (no reload)
        if (_onCityDeleted) {
          _onCityDeleted(path);
        } else {
          refreshCityList(); // Fallback if no callback
        }
      }
    });
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderParentMapPreview(preview: ParentFolderMapPreview | null): void {
  selectedParentMap = preview;
  const container = document.getElementById('construction-parent-map');
  if (!container) return;
  if (!preview) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }

  const sample = preview.repos.slice(0, 5);
  const remaining = preview.repos.length - sample.length;
  const hasRepos = preview.repos.length > 0;
  const repoSummary = hasRepos
    ? `<div class="construction-parent-map-repos">
        ${sample.map((repo) => `<span>${escapeHtml(repo.name)}</span>`).join('')}
        ${remaining > 0 ? `<span>+${remaining} más</span>` : ''}
      </div>`
    : '<p class="construction-parent-map-empty">No hay subcarpetas elegibles para construir un mapa.</p>';
  const action = hasRepos
    ? `<p>Reemplaza el mapa actual y distribuye las ciudades automáticamente. Las posiciones manuales coincidentes se conservan.</p>
      <button id="construction-load-parent-map" class="btn-accent" type="button">
        Recargar mapa y distribuir automáticamente
      </button>`
    : '';
  container.innerHTML = `
    <div class="construction-parent-map-heading">
      <div>
        <span class="construction-parent-map-eyebrow">Mapa de carpeta madre</span>
        <strong>${escapeHtml(preview.rootPath)}</strong>
      </div>
      <span class="construction-parent-map-count">${preview.repos.length} carpetas</span>
    </div>
    ${repoSummary}
    ${action}
  `;
  container.classList.remove('hidden');
  if (!hasRepos) return;

  container
    .querySelector<HTMLButtonElement>('#construction-load-parent-map')
    ?.addEventListener('click', (event) => {
      void (async () => {
        const button = event.currentTarget as HTMLButtonElement;
        const error = document.getElementById('construction-error');
        error?.classList.add('hidden');
        if (!selectedRepo || !selectedParentMap) return;
        button.disabled = true;
        button.textContent = 'Recargando mapa…';
        try {
          const result = await loadParentFolderMap(selectedRepo.repoPath ?? selectedRepo.path);
          const selection = result.selectedRepoPaths ?? result.selectedRepoIds ?? [];
          if (selection.length === 0) throw new Error('El servidor devolvió una selección vacía');
          window.location.reload();
        } catch (cause) {
          button.disabled = false;
          button.textContent = 'Recargar mapa y distribuir automáticamente';
          if (error) {
            error.textContent = `No se pudo recargar el mapa (${cause instanceof Error ? cause.message : 'error desconocido'}).`;
            error.classList.remove('hidden');
          }
        }
      })();
    });
}

function refreshRepoSelect(): void {
  const select = document.getElementById('construction-repo-select') as HTMLSelectElement;
  if (!select) return;

  const selectedPaths = loadSelectedRepoPaths();
  const manualLayout = loadManualLayout();

  // Get repos not in manualLayout
  const placedPaths = new Set(manualLayout.entries.map((e) => e.repoPath));
  const unplaced: string[] = [];

  if (selectedPaths) {
    for (const path of selectedPaths) {
      if (!placedPaths.has(path)) {
        unplaced.push(path);
      }
    }
  }

  // Also fetch repo names (try to get from /api/repos)
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '-- Selecciona un repo --';
  select.appendChild(placeholder);
  for (const path of unplaced) {
    const option = document.createElement('option');
    option.value = path;
    option.textContent = path;
    select.appendChild(option);
  }
}

function buildDOM(): void {
  const app = document.getElementById('app');
  if (!app) return;
  const panel = document.createElement('div');
  panel.id = 'construction-panel';
  panel.className = 'construction-panel hidden';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'construction-panel-title');
  panel.innerHTML = `
    <div class="construction-panel-card">
      <header class="construction-panel-header">
        <h3 id="construction-panel-title">Modo construcción</h3>
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
          <div id="construction-parent-map" class="construction-parent-map hidden" aria-live="polite"></div>
          <div class="construction-row">
            <div class="construction-inline">
              <button id="construction-pick-tile" class="btn-accent" type="button">🎯 Elegir casilla en mapa</button>
              <span id="construction-tile-label" class="tile-label">Sin casilla seleccionada</span>
            </div>
          </div>
      <div id="construction-preview" class="construction-preview">Selecciona un repositorio y elige una casilla en el mapa.</div>
      <div id="construction-error" class="construction-error hidden" role="alert" aria-live="assertive"></div>
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
    <button id="construction-onboarding-reset" class="btn-secondary" type="button" title="Re-lanza la visita guiada para nuevos usuarios">Reiniciar visita guiada</button>
  </footer>
    </div>
  `;
  app.appendChild(panel);

  const close = () => closeConstructionPanel();
  panel.querySelector<HTMLButtonElement>('#construction-close')?.addEventListener('click', close);
  panel.querySelector<HTMLButtonElement>('#construction-cancel')?.addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.offsetParent !== null);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // Reboot onboarding tour from the Construction panel (user-requested reset)
  panel
    .querySelector<HTMLButtonElement>('#construction-onboarding-reset')
    ?.addEventListener('click', () => {
      // Call resetTourState immediately (clears storage + launches tour).
      // The construction panel stays open so the user can manage cities while
      // the coachmark takes them through the canvas.
      resetTourState();
    });

  const pathInput = panel.querySelector<HTMLInputElement>('#construction-repo-path')!;
  const error = panel.querySelector<HTMLElement>('#construction-error')!;
  pathInput.addEventListener('input', () => {
    inspectRequestId += 1;
    selectedRepo = null;
    renderParentMapPreview(null);
  });

  panel
    .querySelector<HTMLButtonElement>('#construction-pick-repo')
    ?.addEventListener('click', () => {
      void (async () => {
        error.classList.add('hidden');
        try {
          selectedRepo = await pickRepoFromSystem();
          renderParentMapPreview(null);
          pathInput.value = selectedRepo.repoPath ?? selectedRepo.path;
          // Also update dropdown
          const select = document.getElementById('construction-repo-select') as HTMLSelectElement;
          if (select) {
            // Add option if not exists
            let found = false;
            for (const opt of select.options) {
              if (opt.value === selectedRepo.path) {
                found = true;
                break;
              }
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
  panel
    .querySelector<HTMLSelectElement>('#construction-repo-select')
    ?.addEventListener('change', () => {
      renderParentMapPreview(null);
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
              const repos = (await res.json()) as Array<{ name: string; path: string }>;
              const found = repos.find((r) => r.path === path);
              if (found) {
                selectedRepo = found as ScannedRepo;
              } else {
                selectedRepo = { name: path, path, repoPath: path } as ScannedRepo;
              }
            } else {
              selectedRepo = { name: path, path, repoPath: path } as ScannedRepo;
            }
          } catch {
            selectedRepo = { name: path, path, repoPath: path } as ScannedRepo;
          }
          pathInput.value = selectedRepo?.repoPath ?? path;
        })();
      }
    });

  panel
    .querySelector<HTMLButtonElement>('#construction-inspect-repo')
    ?.addEventListener('click', () => {
      const requestId = ++inspectRequestId;
      void (async () => {
        error.classList.add('hidden');
        try {
          const p = pathInput.value.trim();
          if (!p) throw new Error('Ruta vacia');
          const inspected = await inspectRepoPath(p);
          if (requestId !== inspectRequestId || pathInput.value.trim() !== p) return;
          selectedRepo = inspected.repo ?? null;
          renderParentMapPreview(inspected.parentMap ?? null);
          if (selectedRepo) pathInput.value = selectedRepo.repoPath ?? selectedRepo.path;
        } catch (e) {
          if (requestId !== inspectRequestId) return;
          renderParentMapPreview(null);
          error.textContent = `No se pudo inspeccionar la ruta (${e instanceof Error ? e.message : 'error desconocido'}).`;
          error.classList.remove('hidden');
        }
      })();
    });

  panel
    .querySelector<HTMLButtonElement>('#construction-pick-tile')
    ?.addEventListener('click', () => {
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
        if (!selectedRepo) return;
        // Save to manual layout
        upsertManualRepoEntry({
          repoPath: selectedRepo.path,
          repoFsPath: selectedRepo.repoPath,
          repoName: selectedRepo.name,
          coord,
          addedAt: Date.now(),
          source: 'manual',
        });
        void upsertSelection(selectedRepo.path);
        // Notify main.ts to add city dynamically (no reload)
        if (_onCityAdded) {
          _onCityAdded(selectedRepo, coord);
        }
        // Close panel and exit placing mode
        closeConstructionPanel();
        if (_rendererRef) {
          _rendererRef.setPlacingMode(false);
        }
      };
      _rendererRef.setPlacingMode(true);
      closeConstructionPanel();
      showNotification({
        type: 'info',
        title: 'Nueva ciudad',
        body: `Haz click en una casilla para colocar "${selectedRepo.name}".`,
      });
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
