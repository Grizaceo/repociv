import { loadSelectedRepoPaths, saveSelectedRepoPaths, type ScannedRepo } from '../map.ts';
import { upsertManualRepoEntry } from '../manualLayout.ts';

let isOpen = false;

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

export function openConstructionPanel(): void {
  isOpen = true;
  let panel = getPanel();
  if (!panel) {
    buildDOM();
    panel = getPanel();
  }
  panel?.classList.remove('hidden');
}

export function closeConstructionPanel(): void {
  isOpen = false;
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

function upsertSelection(repoPath: string): void {
  const selected = loadSelectedRepoPaths();
  if (selected === null) return;
  selected.add(repoPath);
  saveSelectedRepoPaths([...selected]);
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
        <p class="construction-help">Agrega un repo existente y define su posicion en el mapa.</p>
        <div class="construction-row">
          <label>Repositorio</label>
          <div class="construction-inline">
            <input id="construction-repo-path" type="text" placeholder="/ruta/al/repo" readonly />
            <button id="construction-pick-repo" class="btn-secondary" type="button">Seleccionar carpeta</button>
          </div>
        </div>
        <div class="construction-row construction-coords">
          <div>
            <label for="construction-q">Coord q</label>
            <input id="construction-q" type="number" value="0" />
          </div>
          <div>
            <label for="construction-r">Coord r</label>
            <input id="construction-r" type="number" value="0" />
          </div>
        </div>
        <div id="construction-preview" class="construction-preview">Selecciona un repositorio para previsualizar.</div>
        <div id="construction-error" class="construction-error hidden"></div>
      </div>
      <footer class="construction-panel-footer">
        <button id="construction-cancel" class="btn-secondary" type="button">Cancelar</button>
        <button id="construction-confirm" class="btn-primary" type="button" disabled>Agregar al mapa</button>
      </footer>
    </div>
  `;
  app.appendChild(panel);

  const close = () => closeConstructionPanel();
  panel.querySelector<HTMLButtonElement>('#construction-close')?.addEventListener('click', close);
  panel.querySelector<HTMLButtonElement>('#construction-cancel')?.addEventListener('click', close);

  const pathInput = panel.querySelector<HTMLInputElement>('#construction-repo-path')!;
  const qInput = panel.querySelector<HTMLInputElement>('#construction-q')!;
  const rInput = panel.querySelector<HTMLInputElement>('#construction-r')!;
  const preview = panel.querySelector<HTMLElement>('#construction-preview')!;
  const error = panel.querySelector<HTMLElement>('#construction-error')!;
  const confirm = panel.querySelector<HTMLButtonElement>('#construction-confirm')!;
  let selectedRepo: ScannedRepo | null = null;

  const renderPreview = () => {
    const q = Number(qInput.value);
    const r = Number(rInput.value);
    if (!selectedRepo) {
      preview.textContent = 'Selecciona un repositorio para previsualizar.';
      confirm.disabled = true;
      return;
    }
    preview.textContent = `Repo "${selectedRepo.name}" se colocara en (${q}, ${r}).`;
    confirm.disabled = false;
  };

  panel.querySelector<HTMLButtonElement>('#construction-pick-repo')?.addEventListener('click', () => {
    void (async () => {
      error.classList.add('hidden');
      try {
        selectedRepo = await pickRepoFromSystem();
        pathInput.value = selectedRepo.path;
        renderPreview();
      } catch (e) {
        error.textContent = `No se pudo abrir el selector (${e instanceof Error ? e.message : 'error desconocido'}).`;
        error.classList.remove('hidden');
      }
    })();
  });

  qInput.addEventListener('input', renderPreview);
  rInput.addEventListener('input', renderPreview);

  confirm.addEventListener('click', () => {
    if (!selectedRepo) return;
    const q = Number(qInput.value);
    const r = Number(rInput.value);
    if (!Number.isFinite(q) || !Number.isFinite(r)) {
      error.textContent = 'Coordenadas invalidas.';
      error.classList.remove('hidden');
      return;
    }
    upsertManualRepoEntry({
      repoPath: selectedRepo.path,
      repoName: selectedRepo.name,
      coord: { q, r },
      addedAt: Date.now(),
      source: 'manual',
    });
    upsertSelection(selectedRepo.path);
    window.location.reload();
  });
}
