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

// ─── Matching ─────────────────────────────────────────────────────────────────

/** Find the profile whose harness/provider/model match the given config
 *  exactly (empty provider/model in the profile means "auto", so it only
 *  matches an equally-empty chat config). Harness ids are normalized
 *  (claude ↔ claude-code). Returns null when nothing matches. */
export function findMatchingProfile(
  profiles: RepoCivProfile[],
  config: { harness: string; provider: string; model: string },
): RepoCivProfile | null {
  const norm = (v: string | undefined): string => (v ?? '').trim();
  return (
    profiles.find(
      (p) =>
        registryHarnessId(norm(p.harness)) === registryHarnessId(norm(config.harness)) &&
        norm(p.provider) === norm(config.provider) &&
        norm(p.model) === norm(config.model),
    ) ?? null
  );
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function _selectEl(): HTMLSelectElement | null {
  return document.getElementById('profile-selector') as HTMLSelectElement | null;
}

function _populateOptions(select: HTMLSelectElement): void {
  select.innerHTML = '';
  const manual = document.createElement('option');
  manual.value = '';
  manual.textContent = '— (config manual)';
  select.appendChild(manual);

  const sorted = [..._profiles].sort(
    (a, b) => (a.slot_order ?? 99) - (b.slot_order ?? 99),
  );
  for (const p of sorted) {
    const opt = document.createElement('option');
    opt.value = p.name;
    const meta = HARNESS_META[p.harness] ?? { emoji: '?', label: p.harness };
    opt.textContent = `${meta.emoji} ${p.display_name ?? p.name}`;
    select.appendChild(opt);
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
// commands, profile apply): if the user diverges from the shown profile, the
// select falls back to "— (config manual)".
setConfigPersistedHandler((unitId) => {
  syncProfileSelector(unitId);
});
