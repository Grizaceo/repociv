// ─── Picker logic — pure, DOM-free, fully unit-tested ───────────────────────
// The interactive in-chat picker (slashPicker.ts) owns the DOM/keyboard layer;
// everything that can be expressed as data-in → data-out lives here so it can
// be tested in the node vitest environment (no DOM, no localStorage). Keep this
// module free of any import that touches the browser — that is what lets
// pickerLogic.test.ts import it directly.

export type PickerStatus = 'ok' | 'warn' | 'off';

/** One row in a picker list. */
export interface PickerOption {
  /** Value applied on select — a model id, provider id, or harness id. */
  id: string;
  /** Primary display label. */
  label: string;
  /** Secondary label (e.g. the provider a model belongs to). */
  sublabel?: string;
  /** Reachability/availability → dot color. */
  status: PickerStatus;
  /** Non-selectable (dead / unreachable). Shown dimmed, skipped by nav. */
  disabled?: boolean;
  /** True when this row is the currently-active selection. */
  current?: boolean;
  /** For model rows: the provider this model belongs to. */
  provider?: string;
  /** Lowercased haystack used for matching (label + sublabel + ids). */
  search: string;
}

// ─── Raw shapes (mirror modelSelector.ts) ───────────────────────────────────

export interface RawHarness {
  id: string;
  name: string;
  available: boolean;
}
export interface RawModel {
  id: string;
  name: string;
  reachable?: boolean;
}
export interface RawProvider {
  id: string;
  name: string;
  available: boolean;
  defaultModel: string;
  models: RawModel[];
}
export interface CurrentSelection {
  harness: string;
  provider: string;
  model: string;
}

const AUTO = 'auto';

/** A selection of '' or 'auto' both mean the auto/cascade default. */
function isAuto(value: string): boolean {
  return value === '' || value === AUTO;
}

function autoOption(label: string, current: boolean): PickerOption {
  return { id: AUTO, label, status: 'ok', current, search: `auto ${label}`.toLowerCase() };
}

// ─── Slash parsing ──────────────────────────────────────────────────────────

/** Split a raw input line into `{cmd, args}`. Returns null when the text is
 *  not a slash command. Mirrors the parsing in handleSlashCommand so both
 *  share one definition of how a command line is tokenised. */
export function parseSlash(text: string): { cmd: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1).join(' ');
  return { cmd, args };
}

/** How `/model <args>` should be handled. Either an immediate power-user
 *  apply (`/model <provider> <model>` with a real provider id) or — for empty,
 *  single-token, or unknown-provider args — opening the picker seeded with the
 *  text as a filter. Pure so the branching is unit-testable; the caller passes
 *  its own provider-id predicate. */
export type ModelArgs =
  | { kind: 'apply'; provider: string; model: string }
  | { kind: 'picker'; filter: string };

export function classifyModelArgs(
  args: string,
  isKnownProvider: (id: string) => boolean,
): ModelArgs {
  const trimmed = args.trim();
  const tokens = trimmed ? trimmed.split(/\s+/) : [];
  if (tokens.length >= 2 && isKnownProvider(tokens[0]!)) {
    return { kind: 'apply', provider: tokens[0]!, model: tokens.slice(1).join(' ') };
  }
  return { kind: 'picker', filter: trimmed };
}

// ─── Option builders ─────────────────────────────────────────────────────────

/** Harness picker rows: ⚡ Auto first, then every harness with availability. */
export function buildHarnessOptions(
  harnesses: RawHarness[],
  current: CurrentSelection,
): PickerOption[] {
  const opts: PickerOption[] = [autoOption('⚡ Auto (cascade)', isAuto(current.harness))];
  for (const h of harnesses) {
    opts.push({
      id: h.id,
      label: h.name,
      status: h.available ? 'ok' : 'off',
      disabled: !h.available,
      current: current.harness === h.id,
      search: `${h.name} ${h.id}`.toLowerCase(),
    });
  }
  return opts;
}

/** Derive a provider's dot color + selectability from its model reachability.
 *  Mirrors the legacy dropdown logic in modelSelector.populateModels /
 *  _reloadProviderSelector so the picker and the dropdown agree. */
function providerStatus(p: RawProvider): { status: PickerStatus; disabled: boolean } {
  const anyReachable = p.models.some((m) => m.reachable);
  const allReachable = p.models.length > 0 && p.models.every((m) => m.reachable);
  const disabled = !p.available && !anyReachable;
  let status: PickerStatus;
  if (!p.available) status = 'off';
  else if (allReachable) status = 'ok';
  else if (anyReachable) status = 'warn';
  else status = 'off';
  return { status, disabled };
}

/** Provider picker rows: ⚡ Auto first, then every provider. */
export function buildProviderOptions(
  providers: RawProvider[],
  current: CurrentSelection,
): PickerOption[] {
  const opts: PickerOption[] = [autoOption('⚡ Auto', isAuto(current.provider))];
  for (const p of providers) {
    const { status, disabled } = providerStatus(p);
    opts.push({
      id: p.id,
      label: p.name,
      sublabel: p.models.length ? `${p.models.length} modelos` : undefined,
      status,
      disabled,
      current: current.provider === p.id,
      search: `${p.name} ${p.id}`.toLowerCase(),
    });
  }
  return opts;
}

/** Model picker rows: every concrete model across all *available* providers.
 *  Unavailable providers (no key / not configured) are skipped entirely so
 *  the list never offers a model the user cannot reach. Models whose live
 *  probe failed (`reachable === false`) are shown dimmed and non-selectable;
 *  models with unknown reachability (probe not yet resolved) stay selectable
 *  with a warn dot. */
export function buildModelOptions(
  providers: RawProvider[],
  current: CurrentSelection,
): PickerOption[] {
  const opts: PickerOption[] = [];
  for (const p of providers) {
    if (!p.available) continue;
    for (const m of p.models) {
      let status: PickerStatus;
      if (m.reachable === true) status = 'ok';
      else if (m.reachable === false) status = 'off';
      else status = 'warn';
      opts.push({
        id: m.id,
        label: m.name,
        sublabel: p.name,
        provider: p.id,
        status,
        disabled: m.reachable === false,
        current: current.provider === p.id && current.model === m.id,
        search: `${m.name} ${m.id} ${p.name} ${p.id}`.toLowerCase(),
      });
    }
  }
  return opts;
}

// ─── Filtering (fuzzy / type-ahead) ───────────────────────────────────────────

/** True when every char of `q` appears in `hay` in order (subsequence match). */
function isSubsequence(q: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < q.length; j++) {
    if (hay[j] === q[i]) i++;
  }
  return i === q.length;
}

/** Score a single option against a lowercased query. Higher is better; a
 *  negative result means "no match → exclude". Substring beats subsequence;
 *  a label-prefix match beats a mid-label match beats a sublabel/id match. */
function scoreMatch(hay: string, label: string, q: string): number {
  const idx = hay.indexOf(q);
  if (idx >= 0) {
    let score = 100 - Math.min(idx, 50);
    if (label.startsWith(q)) score += 50;
    else if (label.includes(q)) score += 20;
    return score;
  }
  if (isSubsequence(q, hay)) return 10;
  return -1;
}

/** Filter + rank options by a free-text query. Empty query returns every
 *  option in its original order. Disabled options are kept (so the user sees
 *  e.g. an unreachable model dimmed) — navigation skips them, not the filter. */
export function filterOptions(options: PickerOption[], query: string): PickerOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options.slice();
  const scored = options
    .map((o, i) => ({ o, i, s: scoreMatch(o.search, o.label.toLowerCase(), q) }))
    .filter((x) => x.s >= 0);
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.o);
}

// ─── Keyboard navigation ───────────────────────────────────────────────────────

/** Index of the first selectable (non-disabled) option, or -1 if none. */
export function firstSelectableIndex(options: PickerOption[]): number {
  return options.findIndex((o) => !o.disabled);
}

/** Move the cursor by `delta` (±1), wrapping around and skipping disabled
 *  rows. Returns the unchanged index when nothing is selectable. */
export function moveCursor(index: number, delta: number, options: PickerOption[]): number {
  const n = options.length;
  if (n === 0) return -1;
  let i = index;
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n;
    if (!options[i]?.disabled) return i;
  }
  return index;
}

/** Map a digit key ('1'–'9') to a zero-based list index, or null otherwise. */
export function digitToIndex(key: string): number | null {
  if (key.length === 1 && key >= '1' && key <= '9') {
    return key.charCodeAt(0) - '1'.charCodeAt(0);
  }
  return null;
}
