// ─── F8 new-session wizard ───────────────────────────────────────────────────
// The modal collects intent before a command is dispatched. It never receives a
// filesystem path; the bridge resolves the selected map city server-side.

import { getSortedProfiles, type RepoCivProfile } from '../agentProfile.ts';
import type { GameState } from '../game.ts';
import { validateAgentSessionDraft } from './agentSessionStart.ts';

export interface SessionStartResult {
  ok: boolean;
  reason?: string;
}

export interface ConfirmedAgentSessionDraft {
  profile: RepoCivProfile;
  cityId: string;
  mission: string;
}

export interface AgentSessionWizardDeps {
  state: GameState;
  startSession: (draft: ConfirmedAgentSessionDraft) => Promise<SessionStartResult>;
}

export interface OpenAgentSessionWizardOptions {
  profileName?: string;
  harness?: RepoCivProfile['harness'];
  onStarted?: () => void;
}

let _dialog: HTMLDialogElement | null = null;

function _setStatus(status: HTMLElement, text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle('agent-session-status--error', error);
}

function _option(value: string, label: string): HTMLOptionElement {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function _closeDialog(): void {
  _dialog?.close();
}

/** Open the accessible, intentional-session form from F8 or a legacy shortcut. */
export async function openAgentSessionWizard(
  deps: AgentSessionWizardDeps,
  options: OpenAgentSessionWizardOptions = {},
): Promise<void> {
  if (_dialog?.open) {
    _dialog.querySelector<HTMLSelectElement>('[name="profile"]')?.focus();
    return;
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'agent-session-dialog';
  dialog.setAttribute('aria-labelledby', 'agent-session-title');
  dialog.innerHTML = `
    <form class="agent-session-form" novalidate>
      <div class="agent-session-head">
        <div>
          <p class="agent-session-kicker">F8 · SESIÓN NUEVA</p>
          <h2 id="agent-session-title">Iniciar una misión</h2>
        </div>
        <button type="button" class="agent-session-close" aria-label="Cancelar nueva sesión">✕</button>
      </div>
      <label>Agente
        <select name="profile" required aria-describedby="agent-session-help"></select>
      </label>
      <label>Territorio
        <select name="city" required></select>
      </label>
      <label>Misión inicial
        <textarea name="mission" rows="4" required placeholder="Qué tiene que lograr este agente?"></textarea>
      </label>
      <p id="agent-session-help" class="agent-session-help">Se encolará con el bridge. La ruta local se resuelve allí y nunca sale del navegador.</p>
      <p class="agent-session-status" aria-live="polite"></p>
      <div class="agent-session-actions">
        <button type="button" class="agent-session-cancel">Cancelar</button>
        <button type="submit" class="agent-session-submit">Iniciar sesión</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  _dialog = dialog;
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (_dialog === dialog) _dialog = null;
  });
  dialog.querySelector('.agent-session-close')?.addEventListener('click', _closeDialog);
  dialog.querySelector('.agent-session-cancel')?.addEventListener('click', _closeDialog);

  const profileSelect = dialog.querySelector<HTMLSelectElement>('[name="profile"]')!;
  const citySelect = dialog.querySelector<HTMLSelectElement>('[name="city"]')!;
  const missionInput = dialog.querySelector<HTMLTextAreaElement>('[name="mission"]')!;
  const submit = dialog.querySelector<HTMLButtonElement>('.agent-session-submit')!;
  const status = dialog.querySelector<HTMLElement>('.agent-session-status')!;

  let profiles: RepoCivProfile[] = [];
  try {
    profiles = await getSortedProfiles();
  } catch {
    _setStatus(status, 'No pude cargar los perfiles del bridge.', true);
  }
  for (const profile of profiles) {
    profileSelect.appendChild(
      _option(profile.name, `${profile.display_name ?? profile.name} · ${profile.harness}`),
    );
  }
  if (options.profileName && profiles.some((profile) => profile.name === options.profileName)) {
    profileSelect.value = options.profileName;
  } else if (options.harness) {
    const harnessProfile = profiles.find((profile) => profile.harness === options.harness);
    if (harnessProfile) profileSelect.value = harnessProfile.name;
  }

  const cities = deps.state.world.cities.filter((city) => !city.isCapital && Boolean(city.repoPath));
  for (const city of cities) citySelect.appendChild(_option(city.id, city.name));

  if (profiles.length === 0) _setStatus(status, 'Creá un perfil antes de iniciar una sesión.', true);
  else if (cities.length === 0) _setStatus(status, 'No hay una ciudad con repositorio disponible en el mapa.', true);
  submit.disabled = profiles.length === 0 || cities.length === 0;

  dialog.querySelector<HTMLFormElement>('.agent-session-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const profile = profiles.find((candidate) => candidate.name === profileSelect.value);
    const draft = { profile, cityId: citySelect.value, mission: missionInput.value };
    const invalid = validateAgentSessionDraft(draft);
    if (invalid) {
      _setStatus(status, invalid, true);
      return;
    }
    submit.disabled = true;
    _setStatus(status, 'Enviando al bridge…');
    const result = await deps.startSession({
      profile: profile!,
      cityId: citySelect.value,
      mission: missionInput.value.trim(),
    });
    if (!result.ok) {
      _setStatus(status, result.reason ?? 'El bridge no aceptó la sesión.', true);
      submit.disabled = false;
      return;
    }
    _setStatus(status, 'Sesión encolada.');
    options.onStarted?.();
    window.setTimeout(_closeDialog, 300);
  });

  dialog.showModal();
  (profiles.length && cities.length ? missionInput : profileSelect).focus();
}
