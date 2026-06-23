import {
  fetchRepoSelectionState,
  fetchScannedRepos,
  fetchSelectionForRoot,
  loadSelectedRepoPaths,
  persistRootSelection,
  saveSelectedRepoPaths,
  type ScannedRepo,
} from '../map.ts';

const ROOT_ID = 'repo-onboarding';

type OnboardingStep = 'harness' | 'select' | 'review';

interface HarnessOption {
  id: string;
  name: string;
  description: string;
  recommended?: boolean;
  available: boolean;
}

interface OnboardingState {
  repos: ScannedRepo[];
  query: string;
  selected: Set<string>;
  step: OnboardingStep;
  isLoading: boolean;
  isPickingFolder: boolean;
  isSavingHarness: boolean;
  error: string | null;
  mapRoot: string;
  // Harness selection
  harnessOptions: HarnessOption[];
  selectedHarness: string | null;
  harnessError: string | null;
}

async function fetchHarnessOptions(): Promise<HarnessOption[]> {
  // The bridge exposes the list of available harnesses via /harnesses. We
  // also probe each one to know whether the corresponding CLI / runtime is
  // installed locally — disabled cards stay visible so the user can see what
  // the project supports, but they are not selectable.
  let ids: string[] = [];
  try {
    const res = await fetch('/harnesses');
    if (res.ok) {
      const data = (await res.json()) as { harnesses?: Array<{ id: string }> };
      ids = (data.harnesses ?? []).map((h) => h.id);
    }
  } catch {
    // /harnesses is not critical for the onboarding flow.
  }
  if (ids.length === 0) {
    ids = ['hermes', 'claude', 'codex', 'cursor', 'openclaw'];
  }
  return ids.map((id) => buildHarnessOption(id));
}

function buildHarnessOption(id: string): HarnessOption {
  const meta: Record<string, Omit<HarnessOption, 'id' | 'available'>> = {
    hermes: {
      name: 'Hermes',
      description:
        'Harness local de RepoCiv. Recomendado: usa el main profile y mantiene memoria entre misiones.',
      recommended: true,
    },
    claude: {
      name: 'Claude Code',
      description:
        'Claude Code CLI. Coding agent completo, sin memoria persistente entre sesiones.',
    },
    codex: {
      name: 'Codex',
      description: 'OpenAI Codex CLI. Conservador: edita y construye, no commitea por default.',
    },
    cursor: {
      name: 'Cursor',
      description: 'Cursor agent CLI. Coding agent completo con commit y orquestacion.',
    },
    openclaw: {
      name: 'OpenClaw',
      description: 'OpenClaw gateway. Transporte y ejecucion, no edita archivos.',
    },
  };
  const m = meta[id] ?? {
    name: id,
    description: `Harness "${id}".`,
  };
  return { id, available: true, ...m };
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
  const stored = loadSelectedRepoPaths();
  return stored !== null && stored.size > 0;
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

function renderHarnessStep(state: OnboardingState): string {
  const cards = state.harnessOptions
    .map((option) => {
      const isSelected = state.selectedHarness === option.id;
      const cls = [
        'harness-card',
        isSelected ? 'harness-card--selected' : '',
        option.recommended ? 'harness-card--recommended' : '',
        !option.available ? 'harness-card--unavailable' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `
        <label class="${cls}" data-harness-id="${option.id}">
          <input type="radio" name="onboarding-harness" value="${option.id}" ${isSelected ? 'checked' : ''} ${!option.available ? 'disabled' : ''} />
          <div class="harness-card-header">
            <span class="harness-card-name">${option.name}</span>
            ${option.recommended ? '<span class="harness-card-badge">Recomendado</span>' : ''}
          </div>
          <p class="harness-card-desc">${option.description}</p>
        </label>`;
    })
    .join('');
  const errorMarkup = state.harnessError
    ? `<p class="harness-card-error">${state.harnessError}</p>`
    : '';
  return `
    <div class="harness-step">
      <p class="harness-step-hint">Este es el motor que ejecutara tu primera unidad. Lo elegimos una vez y queda como default; puedes cambiarlo despues desde configuracion.</p>
      <div class="harness-grid">${cards}</div>
      ${errorMarkup}
    </div>`;
}

function stepLabel(step: OnboardingStep): string {
  switch (step) {
    case 'harness':
      return '2 de 4';
    case 'select':
      return '3 de 4';
    case 'review':
      return '4 de 4';
  }
}

function stepTitle(step: OnboardingStep): string {
  switch (step) {
    case 'harness':
      return 'Elige el motor de tu primera unidad';
    case 'select':
      return 'Elige que repos quieres ver en el mapa';
    case 'review':
      return 'Revisa tu seleccion antes de continuar';
  }
}

function stepSubtitle(step: OnboardingStep): string {
  switch (step) {
    case 'harness':
      return 'Tu primera unidad (MAIN) corre sobre este harness. Puedes cambiarlo despues.';
    case 'select':
    case 'review':
      return 'Puedes cambiar esta seleccion mas tarde en configuracion.';
  }
}

function nextDisabled(
  state: OnboardingState,
  isHarnessStep: boolean,
  selectedCount: number,
  emptyRepos: boolean,
): string {
  if (isHarnessStep) {
    if (state.isSavingHarness) return 'disabled';
    if (!state.selectedHarness) return 'disabled';
    return '';
  }
  if (selectedCount === 0 || state.isLoading || !!state.error || emptyRepos) return 'disabled';
  return '';
}

function render(state: OnboardingState, onContinue: () => void): void {
  const root = ensureRoot();
  const filtered = getFilteredRepos(state.repos, state.query);
  const selectedCount = state.selected.size;
  const emptySearch =
    !state.isLoading && !state.error && filtered.length === 0 && state.repos.length > 0;
  const emptyRepos = !state.isLoading && !state.error && state.repos.length === 0;

  const isHarnessStep = state.step === 'harness';
  const isSelectStep = state.step === 'select';
  const isReviewStep = state.step === 'review';

  const listMarkup = isHarnessStep
    ? renderHarnessStep(state)
    : isReviewStep
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
          <p class="repo-onboarding-step">Paso ${stepLabel(state.step)}</p>
          <h2 id="repo-onboarding-title">${stepTitle(state.step)}</h2>
          <p class="repo-onboarding-subtitle">${stepSubtitle(state.step)}</p>
        </div>
      </header>
      <div class="repo-onboarding-content">
        <div class="repo-onboarding-main">${listMarkup}</div>
        ${
          isHarnessStep
            ? ''
            : `<aside class="repo-onboarding-summary">
          <h3>Resumen rapido</h3>
          <p>Total detectados: <strong>${state.repos.length}</strong></p>
          <p>Total seleccionados: <strong>${selectedCount}</strong></p>
          ${
            selectedCount === 0
              ? '<p class="repo-onboarding-warning">Selecciona al menos un repositorio para continuar.</p>'
              : ''
          }
        </aside>`
        }
      </div>
      <footer class="repo-onboarding-footer">
        <button id="repo-onboarding-back" type="button" class="btn-secondary" ${
          isHarnessStep ? 'disabled' : ''
        }>Atras</button>
        <button id="repo-onboarding-next" type="button" class="btn-primary" ${nextDisabled(
          state,
          isHarnessStep,
          selectedCount,
          emptyRepos,
        )}>${isHarnessStep ? 'Continuar' : isSelectStep ? 'Continuar' : 'Entrar al mapa'}</button>
      </footer>
    </section>
  `;

  // ── Wire the harness step (must be wired before the generic handlers below) ──
  if (isHarnessStep) {
    root.querySelectorAll<HTMLInputElement>('input[name="onboarding-harness"]').forEach((input) => {
      input.addEventListener('change', () => {
        if (input.checked) {
          state.selectedHarness = input.value;
          state.harnessError = null;
          render(state, onContinue);
        }
      });
    });
    root
      .querySelector<HTMLButtonElement>('#repo-onboarding-next')
      ?.addEventListener('click', () => {
        if (!state.selectedHarness) return;
        void (async () => {
          state.isSavingHarness = true;
          render(state, onContinue);
          try {
            const harness = state.selectedHarness;
            if (!harness) throw new Error('No harness selected');
            await persistHarnessSelection(harness);
            state.step = 'select';
            render(state, onContinue);
          } catch (error) {
            state.harnessError = `No pudimos guardar el harness (${
              error instanceof Error ? error.message : 'error desconocido'
            }).`;
          } finally {
            state.isSavingHarness = false;
            render(state, onContinue);
          }
        })();
      });
    return;
  }

  // ── Wire the back/next buttons for select and review steps ───────────────
  if (!isHarnessStep) {
    root
      .querySelector<HTMLButtonElement>('#repo-onboarding-back')
      ?.addEventListener('click', () => {
        state.step = isReviewStep ? 'select' : 'harness';
        render(state, onContinue);
      });
  }

  if (isReviewStep) {
    root
      .querySelector<HTMLButtonElement>('#repo-onboarding-next')
      ?.addEventListener('click', () => {
        void (async () => {
          try {
            const union = await persistRootSelection(state.mapRoot, [...state.selected]);
            saveSelectedRepoPaths([...union]);
            root.remove();
            onContinue();
          } catch (error) {
            state.error = `No pudimos guardar la seleccion (${error instanceof Error ? error.message : 'error desconocido'}).`;
            state.step = 'select';
            render(state, onContinue);
          }
        })();
      });
    return;
  }

  root
    .querySelector<HTMLInputElement>('#repo-onboarding-search')
    ?.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      state.query = target.value;
      render(state, onContinue);
    });

  root
    .querySelector<HTMLButtonElement>('#repo-onboarding-clear-search')
    ?.addEventListener('click', () => {
      state.query = '';
      render(state, onContinue);
    });

  root
    .querySelector<HTMLButtonElement>('#repo-onboarding-select-visible')
    ?.addEventListener('click', () => {
      for (const repo of filtered) state.selected.add(repo.path);
      render(state, onContinue);
    });

  root.querySelector<HTMLButtonElement>('#repo-onboarding-clear')?.addEventListener('click', () => {
    state.selected.clear();
    render(state, onContinue);
  });

  root
    .querySelector<HTMLButtonElement>('#repo-onboarding-pick-folder')
    ?.addEventListener('click', () => {
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

  root
    .querySelector<HTMLButtonElement>('#repo-onboarding-map-root-apply')
    ?.addEventListener('click', () => {
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
    const rootSelection = await fetchSelectionForRoot(state.mapRoot);
    const previousSelection = rootSelection.size > 0 ? rootSelection : new Set(state.selected);
    const availablePaths = new Set(state.repos.map((repo) => repo.path));
    const keptSelection = new Set(
      [...previousSelection].filter((path) => availablePaths.has(path)),
    );
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

export async function runRepoOnboarding(): Promise<void> {
  const mapRoot = await fetchCurrentMapRoot().catch(() => 'desconocida');
  await new Promise<void>((resolve) => {
    const state: OnboardingState = {
      repos: [],
      query: '',
      selected: new Set<string>(),
      step: 'harness',
      isLoading: true,
      isPickingFolder: false,
      isSavingHarness: false,
      error: null,
      mapRoot,
      harnessOptions: [],
      selectedHarness: null,
      harnessError: null,
    };
    render(state, resolve);
    void hydrateHarness(state, resolve).then(() => hydrateRepos(state, resolve));
  });
}

async function hydrateHarness(state: OnboardingState, onContinue: () => void): Promise<void> {
  try {
    const options = await fetchHarnessOptions();
    state.harnessOptions = options;
    // If the user already has a saved harness (returning visitor), keep it
    // selected. Otherwise default to hermes (the recommended choice).
    if (!state.selectedHarness) {
      try {
        const res = await fetch('/api/config/default-harness');
        if (res.ok) {
          const data = (await res.json()) as { harness?: string | null };
          if (data.harness && options.some((o) => o.id === data.harness)) {
            state.selectedHarness = data.harness;
          }
        }
      } catch {
        // server not reachable; the user can still pick manually
      }
      if (!state.selectedHarness) {
        const recommended = options.find((o) => o.recommended);
        state.selectedHarness = recommended?.id ?? options[0]?.id ?? null;
      }
    }
  } catch (error) {
    state.harnessError = `No pudimos listar los harnesses (${
      error instanceof Error ? error.message : 'error desconocido'
    }).`;
  }
  render(state, onContinue);
}

async function persistHarnessSelection(harness: string): Promise<void> {
  const res = await fetch('/api/config/default-harness', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
}

export async function openOnboardingPanel(): Promise<void> {
  try {
    const state = await fetchRepoSelectionState();
    const activeRootState = state.roots.find((r) => r.path === state.activeRoot);
    const hasActiveSelections = activeRootState && activeRootState.selectedRepoPaths.length > 0;
    if (hasActiveSelections) {
      saveSelectedRepoPaths(activeRootState.selectedRepoPaths);
      return;
    }
    if (hasStoredSelection()) return;
  } catch {
    if (hasStoredSelection()) return;
  }

  await runRepoOnboarding();
}
