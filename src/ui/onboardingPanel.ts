import {
  fetchScannedRepos,
  loadSelectedRepoPaths,
  saveSelectedRepoPaths,
  type ScannedRepo,
} from '../map.ts';

const ROOT_ID = 'repo-onboarding';

type OnboardingStep = 'select' | 'review';

interface OnboardingState {
  repos: ScannedRepo[];
  query: string;
  selected: Set<string>;
  step: OnboardingStep;
  isLoading: boolean;
  isPickingFolder: boolean;
  error: string | null;
  mapRoot: string;
}

async function fetchCurrentMapRoot(): Promise<string> {
  const res = await fetch('/api/map-root');
  if (!res.ok) throw new Error(`/api/map-root HTTP ${res.status}`);
  const data = (await res.json()) as { path: string };
  return data.path;
}

async function pickMapRoot(): Promise<string> {
  const res = await fetch('/api/map-root/pick', { method: 'POST' });
  const data = (await res.json()) as { path?: string; error?: string };
  if (!res.ok || !data.path) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.path;
}

async function setMapRoot(path: string): Promise<string> {
  const res = await fetch('/api/map-root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const data = (await res.json()) as { path?: string; error?: string };
  if (!res.ok || !data.path) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.path;
}

function hasStoredSelection(): boolean {
  return loadSelectedRepoPaths() !== null;
}

function sortRepos(repos: ScannedRepo[]): ScannedRepo[] {
  return [...repos].sort((a, b) => {
    const byActivity = a.lastCommitDays - b.lastCommitDays;
    if (byActivity !== 0) return byActivity;
    return b.population - a.population;
  });
}

function getRecommendedSelection(repos: ScannedRepo[]): Set<string> {
  const recent = repos.filter((repo) => repo.lastCommitDays <= 90);
  if (recent.length > 0) return new Set(recent.map((repo) => repo.path));
  return new Set(repos.slice(0, Math.min(repos.length, 8)).map((repo) => repo.path));
}

function getFilteredRepos(repos: ScannedRepo[], query: string): ScannedRepo[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return repos;
  return repos.filter((repo) => {
    const repoName = repo.name.toLowerCase();
    const owner = repo.path.split('/').slice(0, -1).join('/').toLowerCase();
    return repoName.includes(normalized) || owner.includes(normalized);
  });
}

function getOwnerPath(repo: ScannedRepo): string {
  const parts = repo.path.split('/').filter(Boolean);
  if (parts.length <= 1) return 'workspace';
  return parts.slice(0, -1).join('/');
}

function ensureRoot(): HTMLElement {
  const existing = document.getElementById(ROOT_ID);
  if (existing) return existing;
  const root = document.createElement('div');
  root.id = ROOT_ID;
  document.body.appendChild(root);
  return root;
}

function formatActivity(lastCommitDays: number): string {
  if (lastCommitDays <= 1) return 'Actividad hoy';
  if (lastCommitDays < 7) return `Hace ${lastCommitDays} dias`;
  if (lastCommitDays < 30) return `Hace ${Math.floor(lastCommitDays / 7)} semanas`;
  return `Hace ${Math.floor(lastCommitDays / 30)} meses`;
}

function render(state: OnboardingState, onContinue: () => void): void {
  const root = ensureRoot();
  const filtered = getFilteredRepos(state.repos, state.query);
  const selectedCount = state.selected.size;
  const emptySearch = !state.isLoading && !state.error && filtered.length === 0 && state.repos.length > 0;
  const emptyRepos = !state.isLoading && !state.error && state.repos.length === 0;

  const listMarkup =
    state.step === 'review'
      ? `<div class="repo-onboarding-review">
          <h3>Resumen</h3>
          <p>Vas a mostrar <strong>${selectedCount}</strong> repos en el mapa.</p>
          <div class="repo-onboarding-review-list">
            ${state.repos
              .filter((repo) => state.selected.has(repo.path))
              .slice(0, 12)
              .map(
                (repo) =>
                  `<div class="repo-onboarding-review-item"><span>${repo.name}</span><small>${getOwnerPath(repo)}</small></div>`,
              )
              .join('')}
            ${selectedCount > 12 ? `<div class="repo-onboarding-more">+${selectedCount - 12} mas</div>` : ''}
          </div>
        </div>`
      : `<div class="repo-onboarding-toolbar">
          <input id="repo-onboarding-search" type="search" placeholder="Buscar repositorio..." value="${state.query}" />
          <button id="repo-onboarding-pick-folder" class="btn-secondary" type="button" ${state.isPickingFolder ? 'disabled' : ''}>
            ${state.isPickingFolder ? 'Abriendo selector...' : 'Seleccionar carpeta del mapa'}
          </button>
          <button id="repo-onboarding-select-visible" class="btn-secondary" type="button">Seleccionar todos visibles</button>
          <button id="repo-onboarding-clear" class="btn-secondary" type="button">Limpiar seleccion</button>
          <span class="repo-onboarding-count">${selectedCount} seleccionados</span>
        </div>
        <div class="repo-onboarding-map-root">
          Carpeta actual: <code>${state.mapRoot}</code>
          <div class="repo-onboarding-map-root-actions">
            <input id="repo-onboarding-map-root-input" type="text" value="${state.mapRoot}" placeholder="/ruta/a/carpeta" />
            <button id="repo-onboarding-map-root-apply" class="btn-secondary" type="button">Aplicar ruta</button>
          </div>
        </div>
        <div class="repo-onboarding-list">
          ${
            state.isLoading
              ? `<div class="repo-onboarding-state">Cargando repos...</div>`
              : state.error
                ? `<div class="repo-onboarding-state repo-onboarding-state--error">
                    <p>${state.error}</p>
                    <button id="repo-onboarding-retry" class="btn-primary" type="button">Reintentar</button>
                  </div>`
                : emptyRepos
                  ? `<div class="repo-onboarding-state">
                      <p>No encontramos repos todavia.</p>
                      <p>Sincroniza o agrega repos para continuar.</p>
                    </div>`
                  : emptySearch
                    ? `<div class="repo-onboarding-state">
                        <p>No hay resultados para esa busqueda.</p>
                        <button id="repo-onboarding-clear-search" class="btn-secondary" type="button">Limpiar busqueda</button>
                      </div>`
                    : filtered
                        .map((repo) => {
                          const checked = state.selected.has(repo.path) ? 'checked' : '';
                          return `<label class="repo-onboarding-item">
                            <input type="checkbox" data-repo-path="${repo.path}" ${checked} />
                            <div class="repo-onboarding-item-main">
                              <div class="repo-onboarding-item-title">${repo.name}</div>
                              <div class="repo-onboarding-item-sub">${getOwnerPath(repo)}</div>
                            </div>
                            <div class="repo-onboarding-item-meta">${formatActivity(repo.lastCommitDays)}</div>
                          </label>`;
                        })
                        .join('')
          }
        </div> `;

  root.innerHTML = `
    <div class="repo-onboarding-backdrop"></div>
    <section class="repo-onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="repo-onboarding-title">
      <header class="repo-onboarding-header">
        <div>
          <p class="repo-onboarding-step">Paso ${state.step === 'select' ? '2 de 4' : '3 de 4'}</p>
          <h2 id="repo-onboarding-title">${
            state.step === 'select'
              ? 'Elige que repos quieres ver en el mapa'
              : 'Revisa tu seleccion antes de continuar'
          }</h2>
          <p class="repo-onboarding-subtitle">Puedes cambiar esta seleccion mas tarde en configuracion.</p>
        </div>
      </header>
      <div class="repo-onboarding-content">
        <div class="repo-onboarding-main">${listMarkup}</div>
        <aside class="repo-onboarding-summary">
          <h3>Resumen rapido</h3>
          <p>Total detectados: <strong>${state.repos.length}</strong></p>
          <p>Total seleccionados: <strong>${selectedCount}</strong></p>
          ${
            selectedCount === 0
              ? '<p class="repo-onboarding-warning">Selecciona al menos un repositorio para continuar.</p>'
              : ''
          }
        </aside>
      </div>
      <footer class="repo-onboarding-footer">
        <button id="repo-onboarding-back" type="button" class="btn-secondary" ${
          state.step === 'select' ? 'disabled' : ''
        }>Atras</button>
        <button id="repo-onboarding-next" type="button" class="btn-primary" ${
          selectedCount === 0 || state.isLoading || !!state.error || emptyRepos ? 'disabled' : ''
        }>${state.step === 'select' ? 'Continuar' : 'Entrar al mapa'}</button>
      </footer>
    </section>
  `;

  if (state.step !== 'select') {
    root.querySelector<HTMLButtonElement>('#repo-onboarding-back')?.addEventListener('click', () => {
      state.step = 'select';
      render(state, onContinue);
    });
    root.querySelector<HTMLButtonElement>('#repo-onboarding-next')?.addEventListener('click', () => {
      saveSelectedRepoPaths([...state.selected]);
      root.remove();
      onContinue();
    });
    return;
  }

  root.querySelector<HTMLInputElement>('#repo-onboarding-search')?.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    state.query = target.value;
    render(state, onContinue);
  });

  root.querySelector<HTMLButtonElement>('#repo-onboarding-clear-search')?.addEventListener('click', () => {
    state.query = '';
    render(state, onContinue);
  });

  root.querySelector<HTMLButtonElement>('#repo-onboarding-select-visible')?.addEventListener('click', () => {
    for (const repo of filtered) state.selected.add(repo.path);
    render(state, onContinue);
  });

  root.querySelector<HTMLButtonElement>('#repo-onboarding-clear')?.addEventListener('click', () => {
    state.selected.clear();
    render(state, onContinue);
  });

  root.querySelector<HTMLButtonElement>('#repo-onboarding-pick-folder')?.addEventListener('click', () => {
    void (async () => {
      state.isPickingFolder = true;
      render(state, onContinue);
      try {
        state.mapRoot = await pickMapRoot();
        state.query = '';
        state.selected.clear();
        await hydrateRepos(state, onContinue);
      } catch (error) {
        state.error = `No pudimos abrir el selector de carpetas (${error instanceof Error ? error.message : 'error desconocido'}).`;
      } finally {
        state.isPickingFolder = false;
        render(state, onContinue);
      }
    })();
  });

  root.querySelector<HTMLButtonElement>('#repo-onboarding-map-root-apply')?.addEventListener('click', () => {
    const input = root.querySelector<HTMLInputElement>('#repo-onboarding-map-root-input');
    const path = String(input?.value ?? '').trim();
    if (!path) return;
    void (async () => {
      state.isPickingFolder = true;
      render(state, onContinue);
      try {
        state.mapRoot = await setMapRoot(path);
        state.query = '';
        state.selected.clear();
        await hydrateRepos(state, onContinue);
      } catch (error) {
        state.error = `No pudimos aplicar la ruta (${error instanceof Error ? error.message : 'error desconocido'}).`;
      } finally {
        state.isPickingFolder = false;
        render(state, onContinue);
      }
    })();
  });

  root.querySelectorAll<HTMLInputElement>('input[data-repo-path]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const repoPath = checkbox.dataset['repoPath'];
      if (!repoPath) return;
      if (checkbox.checked) state.selected.add(repoPath);
      else state.selected.delete(repoPath);
      const countNode = root.querySelector('.repo-onboarding-count');
      if (countNode) countNode.textContent = `${state.selected.size} seleccionados`;
      const nextButton = root.querySelector<HTMLButtonElement>('#repo-onboarding-next');
      if (nextButton) nextButton.disabled = state.selected.size === 0;
    });
  });

  root.querySelector<HTMLButtonElement>('#repo-onboarding-next')?.addEventListener('click', () => {
    state.step = 'review';
    render(state, onContinue);
  });

  root.querySelector<HTMLButtonElement>('#repo-onboarding-retry')?.addEventListener('click', () => {
    void hydrateRepos(state, onContinue);
  });
}

async function hydrateRepos(state: OnboardingState, onContinue: () => void): Promise<void> {
  state.isLoading = true;
  state.error = null;
  render(state, onContinue);
  try {
    state.repos = sortRepos(await fetchScannedRepos());
    const previousSelection = new Set(state.selected);
    const availablePaths = new Set(state.repos.map((repo) => repo.path));
    const keptSelection = new Set([...previousSelection].filter((path) => availablePaths.has(path)));
    state.selected =
      keptSelection.size > 0 || state.repos.length === 0
        ? keptSelection
        : getRecommendedSelection(state.repos);
    state.isLoading = false;
    state.error = null;
  } catch (error) {
    state.isLoading = false;
    state.error = `No pudimos cargar los repos (${error instanceof Error ? error.message : 'error desconocido'}).`;
  }
  render(state, onContinue);
}

export async function ensureRepoOnboarding(): Promise<void> {
  const existingSelection = loadSelectedRepoPaths();
  if (existingSelection && existingSelection.size > 0) {
    try {
      const repos = await fetchScannedRepos();
      const hasAnyMatch = repos.some((repo) => existingSelection.has(repo.path));
      if (hasAnyMatch) return;
    } catch {
      return;
    }
  } else if (hasStoredSelection()) {
    return;
  }

  const mapRoot = await fetchCurrentMapRoot().catch(() => 'desconocida');
  await new Promise<void>((resolve) => {
    const state: OnboardingState = {
      repos: [],
      query: '',
      selected: new Set<string>(),
      step: 'select',
      isLoading: true,
      isPickingFolder: false,
      error: null,
      mapRoot,
    };
    render(state, resolve);
    void hydrateRepos(state, resolve);
  });
}
