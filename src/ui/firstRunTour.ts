// ─── First-run guided tour (coachmarks) — plan B2 ────────────────────────────
// Civ V greets a new player with an advisor; this is the equivalent: a 4-step
// walkthrough shown once that teaches the core loop — city = repo → select →
// spawn an agent → watch the chat. Persisted so it never nags a returning user.

const STORAGE_KEY = 'repociv:tour-seen:v1';

export interface TourStep {
  /** Element to highlight; if absent in the DOM the card just centers. */
  selector: string;
  title: string;
  body: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    selector: '#main-canvas',
    title: 'Tu imperio = tus repos',
    body: 'Cada ciudad del mapa es un repositorio de tu workspace. Cuanto más activo, más grande.',
  },
  {
    selector: '#main-canvas',
    title: 'Seleccioná una ciudad',
    body: 'Hacé click en una ciudad para abrir su ficha (estilo Civ V): estado git, archivos y agentes.',
  },
  {
    selector: '.hero-bar-spawn',
    title: 'Mandá un agente',
    body: 'Desplegá un agente con estos botones o las teclas Q/W/E… Un Worker hace una tarea puntual; el principal mantiene contexto.',
  },
  {
    selector: '#chat-input',
    title: 'Seguí el resultado',
    body: 'Hablá con el agente y mirá su progreso en el chat. ¡Listo para tu primera misión!',
  },
];

export function shouldShowTour(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '1';
  } catch {
    return false;
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* ignore */
  }
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

let _step = 0;
let _root: HTMLElement | null = null;
let _steps: TourStep[] = TOUR_STEPS;

function _end(): void {
  markTourSeen();
  _root?.remove();
  _root = null;
}

function _render(): void {
  if (!_root) return;
  const step = _steps[_step];
  if (!step) {
    _end();
    return;
  }
  const target = document.querySelector<HTMLElement>(step.selector);
  const rect = target?.getBoundingClientRect() ?? null;
  const isLast = _step === _steps.length - 1;
  _root.innerHTML = `
    <div class="frt-backdrop"></div>
    ${
      rect && rect.width > 0
        ? `<div class="frt-ring" style="left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px"></div>`
        : ''
    }
    <div class="frt-card" role="dialog" aria-label="${esc(step.title)}">
      <div class="frt-step">Paso ${_step + 1}/${_steps.length}</div>
      <h3 class="frt-title">${esc(step.title)}</h3>
      <p class="frt-body">${esc(step.body)}</p>
      <div class="frt-actions">
        <button class="frt-skip" type="button">Saltar</button>
        <button class="frt-next" type="button">${isLast ? '¡Entendido!' : 'Siguiente →'}</button>
      </div>
    </div>
  `;
  const card = _root.querySelector<HTMLElement>('.frt-card');
  if (card) {
    if (rect && rect.width > 0) {
      card.style.top = `${Math.min(rect.bottom + 12, window.innerHeight - 200)}px`;
      card.style.left = `${Math.min(Math.max(rect.left, 12), window.innerWidth - 340)}px`;
    } else {
      card.classList.add('frt-card--center');
    }
  }
  _root.querySelector('.frt-next')?.addEventListener('click', () => {
    _step += 1;
    _render();
  });
  _root.querySelector('.frt-skip')?.addEventListener('click', _end);
}

/** Start the tour now (caller decides whether to via shouldShowTour). */
export function startFirstRunTour(steps: TourStep[] = TOUR_STEPS): void {
  if (steps.length === 0) return;
  _steps = steps;
  _step = 0;
  _root = document.createElement('div');
  _root.id = 'first-run-tour';
  document.body.appendChild(_root);
  _render();
}

/** Show the tour only on a genuine first run (and not over the onboarding panel). */
export function maybeStartFirstRunTour(): void {
  if (!shouldShowTour()) return;
  const onboarding = document.getElementById('repo-onboarding');
  if (onboarding && !onboarding.classList.contains('hidden')) return;
  startFirstRunTour();
}
