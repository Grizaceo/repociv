// ─── In-chat interactive picker for harness / provider / model ──────────────
// Opened by the /model, /harness and /provider slash commands. Renders a
// keyboard-first overlay inside the chat pane — a filterable, navigable list
// with live reachability dots — and applies the chosen value through the same
// modelSelector apply API the DOM <select>s use, so the dropdowns, the
// per-unit persistence and getSelectedConfig() all stay in sync. No mouse
// required: ↑/↓ navigate, Enter / 1–9 choose, type to filter, Esc cancels.
//
// All non-DOM logic (option building, fuzzy filter, cursor math) lives in the
// pure, unit-tested pickerLogic.ts; this module is the DOM/keyboard shell.

import { escapeHtml } from './clipboard.ts';
import {
  getSelectedConfig,
  getHarnessList,
  getProviderList,
  applyHarnessSelection,
  applyProviderSelection,
  applyModelChoice,
} from './modelSelector.ts';
import {
  buildHarnessOptions,
  buildProviderOptions,
  buildModelOptions,
  filterOptions,
  firstSelectableIndex,
  moveCursor,
  digitToIndex,
  type PickerOption,
} from './pickerLogic.ts';

type PickerKind = 'model' | 'harness' | 'provider';
type AppendFn = (unitId: string, text: string, role?: 'system') => void;

interface PickerState {
  kind: PickerKind;
  unitId: string;
  append: AppendFn;
  options: PickerOption[];
  filtered: PickerOption[];
  query: string;
  cursor: number;
  backdrop: HTMLElement;
  filterInput: HTMLInputElement;
  listEl: HTMLElement;
  footEl: HTMLElement;
}

let _active: PickerState | null = null;

const TITLES: Record<PickerKind, string> = {
  model: 'Modelo',
  harness: 'Harness',
  provider: 'Proveedor',
};

const KIND_PLACEHOLDER: Record<PickerKind, string> = {
  model: 'filtrar modelos…',
  harness: 'filtrar harness…',
  provider: 'filtrar proveedores…',
};

// ─── Public open API ─────────────────────────────────────────────────────────

export function openModelPicker(unitId: string, append: AppendFn, initialFilter = ''): void {
  open('model', unitId, append, initialFilter);
}
export function openHarnessPicker(unitId: string, append: AppendFn, initialFilter = ''): void {
  open('harness', unitId, append, initialFilter);
}
export function openProviderPicker(unitId: string, append: AppendFn, initialFilter = ''): void {
  open('provider', unitId, append, initialFilter);
}

/** True when a picker overlay is currently open. */
export function isPickerOpen(): boolean {
  return _active !== null;
}

// ─── Option sourcing ───────────────────────────────────────────────────────────

function buildOptions(kind: PickerKind): PickerOption[] {
  const current = getSelectedConfig();
  if (kind === 'harness') return buildHarnessOptions(getHarnessList(), current);
  if (kind === 'provider') return buildProviderOptions(getProviderList(), current);
  return buildModelOptions(getProviderList(), current);
}

// ─── Open / close ──────────────────────────────────────────────────────────────

function open(kind: PickerKind, unitId: string, append: AppendFn, initialFilter: string): void {
  close(); // only one picker at a time

  const pane = document.querySelector<HTMLElement>('.tab-pane[data-pane="chat"]');
  if (!pane) return;

  const options = buildOptions(kind);
  const query = initialFilter.trim();
  const filtered = filterOptions(options, query);

  // ── Scaffold ──
  const backdrop = document.createElement('div');
  backdrop.className = 'slash-picker-backdrop';

  const box = document.createElement('div');
  box.className = 'slash-picker';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');

  const head = document.createElement('div');
  head.className = 'slash-picker-head';
  const current = getSelectedConfig();
  head.innerHTML =
    `<span class="sp-title">${escapeHtml(TITLES[kind])}</span>` +
    `<span class="sp-current">${escapeHtml(currentSummary(current))}</span>`;

  const filterInput = document.createElement('input');
  filterInput.className = 'slash-picker-filter';
  filterInput.type = 'text';
  filterInput.placeholder = KIND_PLACEHOLDER[kind];
  filterInput.value = query;
  filterInput.autocomplete = 'off';
  filterInput.spellcheck = false;

  const listEl = document.createElement('div');
  listEl.className = 'slash-picker-list';
  listEl.setAttribute('role', 'listbox');

  const footEl = document.createElement('div');
  footEl.className = 'slash-picker-foot';

  box.append(head, filterInput, listEl, footEl);
  backdrop.appendChild(box);
  pane.appendChild(backdrop);

  _active = {
    kind,
    unitId,
    append,
    options,
    filtered,
    query,
    cursor: firstSelectableIndex(filtered),
    backdrop,
    filterInput,
    listEl,
    footEl,
  };

  // ── Wire interactions ──
  filterInput.addEventListener('keydown', onKeyDown);
  filterInput.addEventListener('input', onFilterInput);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close(); // click outside the box cancels
  });

  render();
  // Focus the filter and place the caret at the end of any pre-seeded text.
  filterInput.focus();
  filterInput.setSelectionRange(query.length, query.length);
}

/** Close the picker and return focus to the chat input. */
export function close(): void {
  if (!_active) return;
  _active.backdrop.remove();
  _active = null;
  document.getElementById('chat-input')?.focus();
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function currentSummary(c: { harness: string; provider: string; model: string }): string {
  const h = c.harness || 'auto';
  const p = c.provider || 'auto';
  const m = c.model || 'default';
  return `${h} · ${p}/${m}`;
}

function render(): void {
  const s = _active;
  if (!s) return;

  s.listEl.replaceChildren();

  if (s.options.length === 0) {
    s.listEl.appendChild(emptyRow('Aún no hay opciones disponibles — espera a que cargue el bridge.'));
    s.footEl.textContent = 'Esc cerrar';
    return;
  }
  if (s.filtered.length === 0) {
    s.listEl.appendChild(emptyRow(`Sin coincidencias para «${s.query}»`));
    s.footEl.textContent = 'Borra el filtro · Esc cerrar';
    return;
  }

  s.filtered.forEach((opt, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'slash-picker-item';
    if (i === s.cursor) row.classList.add('selected');
    if (opt.current) row.classList.add('current');
    if (opt.disabled) row.classList.add('disabled');
    row.dataset['index'] = String(i);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === s.cursor ? 'true' : 'false');

    const dot = document.createElement('span');
    dot.className = `sp-dot ${opt.status}`;

    const num = document.createElement('span');
    num.className = 'sp-num';
    num.textContent = i < 9 ? String(i + 1) : '';

    const label = document.createElement('span');
    label.className = 'sp-label';
    label.textContent = opt.label;

    row.append(dot, num, label);

    if (opt.sublabel) {
      const sub = document.createElement('span');
      sub.className = 'sp-sub';
      sub.textContent = opt.sublabel;
      row.appendChild(sub);
    }
    if (opt.current) {
      const cur = document.createElement('span');
      cur.className = 'sp-cur';
      cur.textContent = '● activo';
      row.appendChild(cur);
    }

    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus on the filter input
      if (!opt.disabled) choose(opt);
    });
    row.addEventListener('mousemove', () => {
      if (s.cursor !== i && !opt.disabled) {
        s.cursor = i;
        highlight();
      }
    });

    s.listEl.appendChild(row);
  });

  s.footEl.textContent =
    s.query.trim() === ''
      ? '↑↓ navegar · 1-9 o Enter elegir · Esc cerrar'
      : '↑↓ navegar · Enter elegir · Esc cerrar';

  highlight();
}

/** Cheaply re-apply the selected/aria state without rebuilding the list. */
function highlight(): void {
  const s = _active;
  if (!s) return;
  const rows = s.listEl.querySelectorAll<HTMLElement>('.slash-picker-item');
  rows.forEach((row) => {
    const idx = Number(row.dataset['index']);
    const isSel = idx === s.cursor;
    row.classList.toggle('selected', isSel);
    row.setAttribute('aria-selected', isSel ? 'true' : 'false');
    if (isSel) row.scrollIntoView({ block: 'nearest' });
  });
}

function emptyRow(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sp-empty';
  el.textContent = text;
  return el;
}

// ─── Keyboard / filter handlers ──────────────────────────────────────────────

function onFilterInput(): void {
  const s = _active;
  if (!s) return;
  s.query = s.filterInput.value;
  s.filtered = filterOptions(s.options, s.query);
  s.cursor = firstSelectableIndex(s.filtered);
  render();
}

function onKeyDown(e: KeyboardEvent): void {
  const s = _active;
  if (!s) return;

  if (e.key === 'Escape') {
    // Swallow so the global Esc handler doesn't close the whole side panel.
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    s.cursor = moveCursor(s.cursor, 1, s.filtered);
    highlight();
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    s.cursor = moveCursor(s.cursor, -1, s.filtered);
    highlight();
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    const opt = s.filtered[s.cursor];
    if (opt && !opt.disabled) choose(opt);
    return;
  }

  // Number quick-pick — only while the filter is empty, so digits can still be
  // typed into model names like "gpt-4o" once the user starts filtering.
  if (s.query.trim() === '') {
    const idx = digitToIndex(e.key);
    if (idx !== null) {
      const opt = s.filtered[idx];
      if (opt && !opt.disabled) {
        e.preventDefault();
        e.stopPropagation();
        choose(opt);
      }
    }
  }
}

// ─── Apply a choice ──────────────────────────────────────────────────────────

function choose(opt: PickerOption): void {
  const s = _active;
  if (!s) return;
  const { kind, unitId, append } = s;

  if (kind === 'harness') {
    applyHarnessSelection(opt.id, unitId);
    append(unitId, `✅ Harness → \`${opt.id}\``, 'system');
  } else if (kind === 'provider') {
    applyProviderSelection(opt.id, unitId);
    append(unitId, `✅ Proveedor → \`${opt.id}\``, 'system');
  } else {
    // model — opt.provider is always set by buildModelOptions
    const provider = opt.provider ?? getSelectedConfig().provider;
    applyModelChoice(provider, opt.id, unitId);
    append(unitId, `✅ Modelo → \`${provider}/${opt.id}\``, 'system');
  }

  close();
}
