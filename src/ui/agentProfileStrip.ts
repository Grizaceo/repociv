// ─── RepoCiv — Agent Profile Strip ───────────────────────────────────────────
// Profile Studio: slot bar + mini-editor strip.

import {
  loadProfiles,
  saveProfile,
  loadIdentity,
  saveIdentity,
  listHarnessOptions,
  invalidateProfileCache,
  HARNESS_META,
  VALID_HARNESSES,
  type RepoCivProfile,
  type HarnessId,
} from '../agentProfile.ts';
import { ensureProvidersLoaded, populateProfileStripModelSelect } from './chat/modelSelector.ts';

// ─── State ───────────────────────────────────────────────────────────────────

let _profiles: Record<string, RepoCivProfile> = {};
let _selectedName: string | null = null;
let _identityDrawerOpen = false;
let _pendingChanges: Partial<RepoCivProfile> = {};

// ─── DOM references ──────────────────────────────────────────────────────────

function _el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ─── Profile studio ───────────────────────────────────────────────────────────

let _studio: HTMLDialogElement | null = null;

export function openProfileStudio(): void {
  const studio = _getProfileStudio();
  if (!studio.open) studio.showModal();
  void initProfileStrip();
}

function _getProfileStudio(): HTMLDialogElement {
  if (_studio) return _studio;
  const studio = document.createElement('dialog');
  studio.id = 'profile-studio';
  studio.className = 'profile-studio-dialog';
  studio.innerHTML = `
    <div class="profile-studio-head">
      <span>Perfiles de agente</span>
      <button type="button" class="profile-studio-close" aria-label="Cerrar perfiles">✕</button>
    </div>
    <div id="profile-studio-content" class="profile-studio-body"></div>`;
  studio
    .querySelector<HTMLButtonElement>('.profile-studio-close')
    ?.addEventListener('click', () => {
      studio.close();
    });
  document.body.appendChild(studio);
  _studio = studio;
  return studio;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initProfileStrip(): Promise<void> {
  const host = _el('profile-studio-content');
  if (!host) return;

  if (!_el('profile-strip-container')) {
    _injectStripHTML(host);
    _wireStripEvents();
  }

  await refreshProfiles();
  void ensureProvidersLoaded().then(() => {
    const selected = _selectedName ? _profiles[_selectedName] : null;
    if (selected) _refreshModelSelect(selected);
  });
}

function _injectStripHTML(host: HTMLElement): void {
  const studio = document.createElement('div');
  studio.id = 'profile-strip-container';
  studio.className = 'profile-strip-container';
  studio.innerHTML = `
    <div class="pstrip-header">
      <label class="pstrip-label" for="pstrip-profile-picker">Perfil</label>
      <select id="pstrip-profile-picker" class="pstrip-select pstrip-profile-picker" aria-label="Perfil"></select>
      <span id="pstrip-name" class="pstrip-name" aria-live="polite">—</span>
    </div>
    <div class="pstrip-row">
      <select id="pstrip-harness" class="pstrip-select" title="Harness">
        ${VALID_HARNESSES.map((h) => `<option value="${h}">${HARNESS_META[h].emoji} ${HARNESS_META[h].label}</option>`).join('')}
      </select>
      <select id="pstrip-ref" class="pstrip-select pstrip-ref" title="Referencia de perfil">
        <option value="default">default</option>
      </select>
    </div>
    <div class="pstrip-row">
      <select id="pstrip-model" class="pstrip-select pstrip-model" title="Modelo">
        <option value="">(default)</option>
      </select>
      <button id="pstrip-alma-btn" class="pstrip-btn" title="Editar Alma / identidad">Alma</button>
      <button id="pstrip-save-btn" class="pstrip-btn pstrip-save" title="Guardar perfil">Guardar</button>
    </div>
    <div id="pstrip-alma-drawer" class="pstrip-alma-drawer hidden">
      <textarea id="pstrip-alma-text" class="pstrip-alma-text" placeholder="Escribe el Alma del agente aquí…"></textarea>
      <div class="pstrip-alma-actions">
        <button id="pstrip-alma-save" class="pstrip-btn pstrip-save">Guardar Alma</button>
        <button id="pstrip-alma-cancel" class="pstrip-btn">Cancelar</button>
      </div>
    </div>
  `;
  host.appendChild(studio);
}

function _wireStripEvents(): void {
  document.getElementById('pstrip-profile-picker')?.addEventListener('change', (e) => {
    const name = (e.target as HTMLSelectElement).value;
    if (name) selectProfile(name);
  });

  document.getElementById('pstrip-harness')?.addEventListener('change', async (e) => {
    const h = (e.target as HTMLSelectElement).value as HarnessId;
    _pendingChanges.harness = h;
    if (_selectedName) {
      await _refreshRefOptions(_selectedName, h);
      _refreshModelSelect({
        ..._profiles[_selectedName]!,
        harness: h,
        model: _pendingChanges.model ?? _profiles[_selectedName]!.model,
      });
    }
  });

  document.getElementById('pstrip-ref')?.addEventListener('change', (e) => {
    _pendingChanges.harness_ref = (e.target as HTMLSelectElement).value;
  });

  document.getElementById('pstrip-model')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value.trim();
    _pendingChanges.model = v || undefined;
  });

  document.getElementById('pstrip-save-btn')?.addEventListener('click', _handleSave);
  document.getElementById('pstrip-alma-btn')?.addEventListener('click', _handleAlmaToggle);
  document.getElementById('pstrip-alma-save')?.addEventListener('click', _handleAlmaSave);
  document.getElementById('pstrip-alma-cancel')?.addEventListener('click', () => {
    _identityDrawerOpen = false;
    _el('pstrip-alma-drawer')?.classList.add('hidden');
  });
}

// ─── Profile refresh ──────────────────────────────────────────────────────────

export async function refreshProfiles(): Promise<void> {
  try {
    _profiles = await loadProfiles();
  } catch {
    _profiles = {};
  }
  _renderProfilePicker();
  if (_selectedName && _profiles[_selectedName]) {
    _renderStripForProfile(_profiles[_selectedName]!);
  } else {
    const names = Object.keys(_profiles);
    if (names.length > 0) {
      const first = Object.values(_profiles).sort(
        (a, b) => (a.slot_order ?? 99) - (b.slot_order ?? 99),
      )[0];
      if (first) selectProfile(first.name);
    }
  }
}

// ─── Profile picker ────────────────────────────────────────────────────────────

function _renderProfilePicker(): void {
  const picker = _el<HTMLSelectElement>('pstrip-profile-picker');
  if (!picker) return;

  const profiles = Object.values(_profiles).sort(
    (a, b) => (a.slot_order ?? 99) - (b.slot_order ?? 99),
  );
  picker.replaceChildren(
    ...profiles.map((profile) => {
      const option = new Option(profile.display_name ?? profile.name, profile.name);
      option.selected = profile.name === _selectedName;
      return option;
    }),
  );
}

// ─── Profile selection ────────────────────────────────────────────────────────

export function selectProfile(name: string): void {
  _selectedName = name;
  _pendingChanges = {};
  const profile = _profiles[name];
  if (!profile) return;
  _renderStripForProfile(profile);
  _renderProfilePicker(); // refresh selected state
}

function _renderStripForProfile(profile: RepoCivProfile): void {
  const nameEl = _el('pstrip-name');
  if (nameEl) nameEl.textContent = profile.display_name ?? profile.name;

  const harnessSel = _el<HTMLSelectElement>('pstrip-harness');
  if (harnessSel) harnessSel.value = profile.harness;

  _refreshModelSelect(profile);

  // Load ref options in background
  void _refreshRefOptions(profile.name, profile.harness, profile.harness_ref);

  // Close identity drawer if open
  _identityDrawerOpen = false;
  _el('pstrip-alma-drawer')?.classList.add('hidden');
}

async function _refreshRefOptions(
  profileName: string,
  _harness: HarnessId | string,
  currentRef?: string,
): Promise<void> {
  const refSel = _el<HTMLSelectElement>('pstrip-ref');
  if (!refSel) return;

  let options: string[];
  try {
    options = await listHarnessOptions(profileName);
  } catch {
    options = [];
  }

  // Always include current value and 'default'
  const allOptions = Array.from(
    new Set(['default', ...(currentRef ? [currentRef] : []), ...options]),
  );
  refSel.innerHTML = allOptions
    .map(
      (o) =>
        `<option value="${o}"${o === (currentRef ?? 'default') ? ' selected' : ''}>${o}</option>`,
    )
    .join('');
}

function _refreshModelSelect(profile: RepoCivProfile): void {
  const modelSel = _el<HTMLSelectElement>('pstrip-model');
  if (!modelSel) return;
  void ensureProvidersLoaded().then(() => {
    populateProfileStripModelSelect(modelSel, profile.harness, profile.model);
  });
}

// ─── Save handler ─────────────────────────────────────────────────────────────

async function _handleSave(): Promise<void> {
  if (!_selectedName) return;
  const profile = _profiles[_selectedName];
  if (!profile) return;

  const updated: RepoCivProfile = {
    ...profile,
    ..._pendingChanges,
    harness: (_pendingChanges.harness ?? profile.harness) as HarnessId,
  };

  const saveBtn = _el<HTMLButtonElement>('pstrip-save-btn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '…';
  }

  try {
    const saved = await saveProfile(updated);
    _profiles[saved.name] = saved;
    _pendingChanges = {};
    _renderStripForProfile(saved);
    if (saveBtn) saveBtn.textContent = '✓';
    setTimeout(() => {
      if (saveBtn) saveBtn.textContent = 'Guardar';
    }, 1500);
  } catch (err) {
    if (saveBtn) {
      saveBtn.textContent = '✗';
      saveBtn.disabled = false;
    }
    // eslint-disable-next-line no-console
    console.error('[ProfileStrip] save error:', err);
    setTimeout(() => {
      if (saveBtn) {
        saveBtn.textContent = 'Guardar';
        saveBtn.disabled = false;
      }
    }, 2000);
  }
}

// ─── Alma (identity) handlers ─────────────────────────────────────────────────

async function _handleAlmaToggle(): Promise<void> {
  if (!_selectedName) return;
  const drawer = _el('pstrip-alma-drawer');
  if (!drawer) return;

  if (_identityDrawerOpen) {
    _identityDrawerOpen = false;
    drawer.classList.add('hidden');
    return;
  }

  // Load identity content
  const almaBtn = _el<HTMLButtonElement>('pstrip-alma-btn');
  if (almaBtn) {
    almaBtn.disabled = true;
    almaBtn.textContent = '…';
  }
  try {
    const identity = await loadIdentity(_selectedName);
    const textarea = _el<HTMLTextAreaElement>('pstrip-alma-text');
    if (textarea) textarea.value = identity.content;
  } finally {
    if (almaBtn) {
      almaBtn.disabled = false;
      almaBtn.textContent = 'Alma';
    }
  }

  _identityDrawerOpen = true;
  drawer.classList.remove('hidden');
}

async function _handleAlmaSave(): Promise<void> {
  if (!_selectedName) return;
  const textarea = _el<HTMLTextAreaElement>('pstrip-alma-text');
  if (!textarea) return;

  const saveBtn = _el<HTMLButtonElement>('pstrip-alma-save');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '…';
  }

  try {
    await saveIdentity(_selectedName, textarea.value);
    if (saveBtn) saveBtn.textContent = '✓';
    setTimeout(() => {
      if (saveBtn) {
        saveBtn.textContent = 'Guardar Alma';
        saveBtn.disabled = false;
      }
    }, 1500);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ProfileStrip] alma save error:', err);
    if (saveBtn) {
      saveBtn.textContent = '✗';
      saveBtn.disabled = false;
    }
    setTimeout(() => {
      if (saveBtn) {
        saveBtn.textContent = 'Guardar Alma';
        saveBtn.disabled = false;
      }
    }, 2000);
  }
}

// ─── New profile wizard ───────────────────────────────────────────────────────

export async function openNewProfileWizard(): Promise<void> {
  const name = prompt('Nombre del nuevo perfil (letras, números, - o _):');
  if (!name?.trim()) return;
  const harness = prompt(`Harness (${VALID_HARNESSES.join(' | ')}):`, 'claude') as HarnessId | null;
  if (!harness || !VALID_HARNESSES.includes(harness as HarnessId)) {
    alert('Harness no válido');
    return;
  }

  const newProfile: RepoCivProfile = {
    name: name.trim(),
    harness,
    harness_ref: 'default',
    identity_mode: 'managed',
    slot_order: Object.keys(_profiles).length,
  };

  try {
    const saved = await saveProfile(newProfile);
    _profiles[saved.name] = saved;
    invalidateProfileCache();
    await refreshProfiles();
    selectProfile(saved.name);
  } catch (err) {
    alert(`Error creando perfil: ${err}`);
  }
}

// ─── Public accessor ──────────────────────────────────────────────────────────

/** Return the currently-selected profile name (or null). */
export function getSelectedProfileName(): string | null {
  return _selectedName;
}

/** Return the currently-selected profile (or null). */
export function getSelectedProfile(): RepoCivProfile | null {
  return _selectedName ? (_profiles[_selectedName] ?? null) : null;
}
