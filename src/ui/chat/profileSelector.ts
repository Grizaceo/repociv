// ─── Profile selector: chat header layer above harness/provider/model ───────
// A profile is a server-side preset (harness + provider + model + Alma) stored
// in ~/.repociv/config.json. This module adds a <select> to the side panel
// header so the user can apply a profile to the ACTIVE chat tab, and keeps it
// in sync with the per-unit chat config:
//
//   - Choosing a profile  → applies its harness/provider/model to the active
//     unit via the modelSelector apply* functions (which persist per-unit and
//     mirror onto the agent chip).
//   - Switching chat tabs → the select shows the profile whose config matches
//     the unit's saved config exactly, or "— (config manual)" when the user
//     has diverged (or the unit has no profile).
//   - Manual dropdown/slash changes → re-sync: if the config no longer
//     matches the shown profile, the select falls back to "— (config manual)".
//
// The command-bar profile strip (agentProfileStrip.ts) is NOT synced with this
// selector: that strip is the spawn/edit context (Ctrl+Q), this is the chat
// context. They share the same profile data, not the same selection state.
import {
  loadProfiles,
  HARNESS_META,
  type RepoCivProfile,
} from '../../agentProfile.ts';
import { getActiveChatUnit } from './state.ts';
import {
  applyHarnessSelection,
  applyProviderSelection,
  applyModelSelection,
  setConfigPersistedHandler,
  loadSelection,
  getSelectedConfig,
} from './modelSelector.ts';

// ─── State ───────────────────────────────────────────────────────────────────

let _profiles: RepoCivProfile[] = [];

// ─── Harness id normalization ─────────────────────────────────────────────────
// Profiles store HarnessId ('claude', 'codex', ...) but the provider registry
// (and the chat config) uses registry ids ('claude-code', ...). Normalize both
// sides so apply + match work regardless of which form is stored.
const HARNESS_TO_REGISTRY: Record<string, string> = { claude: 'claude-code' };
function registryHarnessId(h: string): string {
  return HARNESS_TO_REGISTRY[h] ?? h;
}
function norm(v: string | undefined): string {
  return (v ?? '').trim();
}

// ─── Matching ─────────────────────────────────────────────────────────────────

/** Find the profile whose harness/provider/model match the given config
 *  exactly (empty provider/model in the profile means "auto", so it only
 *  matches an equally-empty chat config). Harness ids are normalized
 *  (claude ↔ claude-code). Returns null when nothing matches. */
export function findMatchingProfile(
  profiles: RepoCivProfile[],
  config: { harness: string; provider: string; model: string },
): RepoCivProfile | null {
  return (
    profiles.find(
      (p) =>
        registryHarnessId(norm(p.harness)) === registryHarnessId(norm(config.harness)) &&
        norm(p.provider) === norm(config.provider) &&
        norm(p.model) === norm(config.model),
    ) ?? null
  );
}

/** Profiles whose harness matches the given (registry-id) harness. 'auto'
 *  shows every profile. Unknown harness ids show nothing (the panel's
 *  harness dropdown drives the filter, and a profile for a harness that is
 *  not even selectable should not be offered here). */
export function filterProfilesByHarness(
  profiles: RepoCivProfile[],
  harnessRegistryId: string,
): RepoCivProfile[] {
  const hid = norm(harnessRegistryId);
  if (!hid || hid === 'auto') return [...profiles];
  return profiles.filter(
    (p) => registryHarnessId(norm(p.harness)) === hid,
  );
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function _selectEl(): HTMLSelectElement | null {
  return document.getElementById('profile-selector') as HTMLSelectElement | null;
}

function _populateOptions(select: HTMLSelectElement): void {
  select.innerHTML = '';
  // First option is a prompt, not a value: the select reflects the active
  // profile only when the unit's config matches one exactly; otherwise it
  // shows the manual-config state.
  const manual = document.createElement('option');
  manual.value = '';
  manual.textContent = '— (config manual)';
  select.appendChild(manual);

  // Filter by the panel's active harness: in "hermes" only hermes profiles
  // are offered, in "claude-code" only claude profiles, in "auto" all of
  // them. Profiles for other harnesses never appear here — they are not
  // applicable to this panel's harness and would apply a config the user
  // cannot see.
  const active = getSelectedConfig().harness;
  const visible = filterProfilesByHarness(_profiles, active);

  const sorted = [...visible].sort(
    (a, b) => (a.slot_order ?? 99) - (b.slot_order ?? 99),
  );
  for (const p of sorted) {
    const opt = document.createElement('option');
    opt.value = p.name;
    const meta = HARNESS_META[p.harness] ?? { emoji: '?', label: p.harness };
    opt.textContent = `${meta.emoji} ${p.display_name ?? p.name}`;
    select.appendChild(opt);
  }

  // When the harness filter hides the currently selected profile, the
  // selection must not silently point at a hidden value: fall back to the
  // manual state (the config itself is unchanged, only the dropdown view).
  const current = select.value;
  if (current && !sorted.some((p) => p.name === current)) {
    select.value = '';
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Load profiles and wire the <select> (idempotent). Called when the side
 *  panel opens; safe to call repeatedly. */
export async function initProfileSelector(): Promise<void> {
  const select = _selectEl();
  if (!select) return;
  if (select.dataset['wired']) {
    // Profiles may have changed server-side; refresh options but keep the
    // current selection in sync afterwards.
    try {
      _profiles = Object.values(await loadProfiles());
    } catch {
      _profiles = [];
    }
    _populateOptions(select);
    syncProfileSelector(getActiveChatUnit());
    return;
  }

  try {
    _profiles = Object.values(await loadProfiles());
  } catch {
    _profiles = [];
  }
  _populateOptions(select);

  select.addEventListener('change', () => {
    const name = select.value;
    if (!name) return;
    const profile = _profiles.find((p) => p.name === name);
    if (!profile) return;
    applyProfileToActiveChat(profile);
  });

  select.dataset['wired'] = '1';
  syncProfileSelector(getActiveChatUnit());
}

/** Apply a profile's harness/provider/model to the active chat unit. */
export function applyProfileToActiveChat(profile: RepoCivProfile): void {
  const unitId = getActiveChatUnit();
  applyHarnessSelection(registryHarnessId(profile.harness), unitId);
  applyProviderSelection(profile.provider ?? '', unitId);
  applyModelSelection(profile.model ?? '', unitId);
}

/** Reflect the active unit's saved config onto the <select>: show the
 *  matching profile, or "— (config manual)" when none matches. */
export function syncProfileSelector(unitId: string | null): void {
  const select = _selectEl();
  if (!select) return;
  if (!unitId) {
    select.value = '';
    return;
  }
  const config = loadSelection(unitId);
  const match = findMatchingProfile(_profiles, config);
  select.value = match ? match.name : '';
}

// Re-sync when the config changes through any surface (dropdowns, slash
// commands, profile apply): the dropdown repopulates with the harness filter
// (a harness switch changes which profiles are applicable) and then the
// selection is re-matched — if the user diverges from the shown profile, the
// select falls back to "— (config manual)".
setConfigPersistedHandler((unitId) => {
  const select = _selectEl();
  if (select) _populateOptions(select);
  syncProfileSelector(unitId);
});
