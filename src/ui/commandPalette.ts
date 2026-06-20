// ─── Command palette (Ctrl/Cmd-K) ──────────────────────────────────────────
// Civ V-style fast access: spawn an agent, open a panel, switch 2D↔3D, jump to
// a city — by typing, without hunting the toolbar (docs/UX_IMPROVEMENT_PLAN.md
// C1). This module is the pure palette: a registry + overlay UI + the global
// hotkey. Commands are registered by src/ui/hudWiring/commands.ts where the
// runtime (state/renderer/bridge) is in scope.

export interface PaletteCommand {
  /** Stable id (also used as a fallback label). */
  id: string;
  /** Display text. */
  label: string;
  /** Grouping header (e.g. "Agente", "Panel", "Vista"). */
  group: string;
  /** Optional right-aligned hint (e.g. a hotkey). */
  hint?: string;
  /** Invoked when the command is chosen. */
  run: () => void;
}

/** Provider of commands computed at open time (e.g. one per current city). */
type Provider = () => PaletteCommand[];

const _static: PaletteCommand[] = [];
const _providers: Provider[] = [];

export function registerCommands(cmds: PaletteCommand[]): void {
  _static.push(...cmds);
}

export function registerCommandProvider(fn: Provider): void {
  _providers.push(fn);
}

function allCommands(): PaletteCommand[] {
  const dynamic = _providers.flatMap((fn) => {
    try {
      return fn();
    } catch {
      return [];
    }
  });
  return [..._static, ...dynamic];
}

/** Match a command against a query: every whitespace-separated term must appear
 *  (case-insensitive substring) in the label, group, or hint — order-independent.
 *  Exported for unit testing the search behaviour without a DOM. */
export function commandMatchesQuery(cmd: PaletteCommand, q: string): boolean {
  if (!q) return true;
  const hay = `${cmd.label} ${cmd.group} ${cmd.hint ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

// ─── Overlay state ────────────────────────────────────────────────────────────
let _overlay: HTMLElement | null = null;
let _input: HTMLInputElement | null = null;
let _list: HTMLElement | null = null;
let _filtered: PaletteCommand[] = [];
let _selected = 0;
// The element that had focus before opening, so we can restore it on close
// (the palette is a modal; matches the slashPicker precedent).
let _prevFocus: HTMLElement | null = null;

export function isCommandPaletteOpen(): boolean {
  return _overlay !== null && !_overlay.classList.contains('hidden');
}

function build(): void {
  _overlay = document.createElement('div');
  _overlay.id = 'command-palette';
  _overlay.className = 'cmdk-overlay hidden';
  _overlay.setAttribute('role', 'dialog');
  _overlay.setAttribute('aria-modal', 'true');
  _overlay.setAttribute('aria-label', 'Paleta de comandos');
  _overlay.innerHTML = `
    <div class="cmdk-panel">
      <input class="cmdk-input" type="text" autocomplete="off" spellcheck="false"
        placeholder="Buscar comando — spawn, panel, ciudad, 2D/3D…" aria-label="Buscar comando" />
      <ul class="cmdk-list" role="listbox"></ul>
    </div>
  `;
  document.body.appendChild(_overlay);
  _input = _overlay.querySelector('.cmdk-input');
  _list = _overlay.querySelector('.cmdk-list');

  // Click outside the panel closes; clicks inside don't bubble out.
  _overlay.addEventListener('mousedown', (e) => {
    if (e.target === _overlay) closeCommandPalette();
  });
  _input!.addEventListener('input', () => {
    _selected = 0;
    refresh();
  });
  _input!.addEventListener('keydown', onKeydown);
}

function onKeydown(e: KeyboardEvent): void {
  // The palette is modal: while open, NO keystroke may reach the global
  // hotkey (hotkeys.ts) or renderer Esc listeners — otherwise Esc would also
  // close a panel behind it / deselect the unit / exit local view, and
  // F7/F8/F10 would open panels under the modal. Stop propagation for every
  // key; the input still receives typed characters (default action, not
  // propagation-dependent).
  e.stopPropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    closeCommandPalette();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    closeCommandPalette();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    _selected = Math.min(_selected + 1, _filtered.length - 1);
    renderList();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _selected = Math.max(_selected - 1, 0);
    renderList();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    run(_selected);
  } else if (e.key === 'Tab') {
    // The input is the only focusable element — trap focus (aria-modal).
    e.preventDefault();
  }
}

function run(i: number): void {
  const cmd = _filtered[i];
  if (!cmd) return;
  closeCommandPalette();
  try {
    cmd.run();
  } catch {
    /* a broken command must not take down the palette */
  }
}

function refresh(): void {
  const q = _input?.value ?? '';
  _filtered = allCommands().filter((c) => commandMatchesQuery(c, q));
  if (_selected >= _filtered.length) _selected = Math.max(0, _filtered.length - 1);
  renderList();
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function renderList(): void {
  if (!_list) return;
  if (_filtered.length === 0) {
    _list.innerHTML = '<li class="cmdk-empty">Sin coincidencias</li>';
    return;
  }
  let html = '';
  let lastGroup = '';
  _filtered.forEach((c, i) => {
    if (c.group !== lastGroup) {
      html += `<li class="cmdk-group" role="presentation">${esc(c.group)}</li>`;
      lastGroup = c.group;
    }
    html += `<li class="cmdk-item${i === _selected ? ' selected' : ''}" role="option" data-i="${i}" aria-selected="${i === _selected}">
      <span class="cmdk-label">${esc(c.label)}</span>${c.hint ? `<span class="cmdk-hint">${esc(c.hint)}</span>` : ''}
    </li>`;
  });
  _list.innerHTML = html;
  _list.querySelectorAll<HTMLElement>('.cmdk-item').forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      run(Number(el.dataset['i']));
    });
  });
  _list.querySelector('.cmdk-item.selected')?.scrollIntoView({ block: 'nearest' });
}

export function openCommandPalette(): void {
  if (!_overlay) build();
  // Remember who had focus (e.g. the chat input) so we can hand it back.
  const active = document.activeElement;
  _prevFocus = active instanceof HTMLElement && active !== _input ? active : null;
  _overlay!.classList.remove('hidden');
  _input!.value = '';
  _selected = 0;
  refresh();
  _input!.focus();
}

export function closeCommandPalette(): void {
  if (!_overlay || _overlay.classList.contains('hidden')) return;
  _overlay.classList.add('hidden');
  // Restore focus to the opener so keyboard users don't lose their place.
  if (_prevFocus?.isConnected) _prevFocus.focus();
  _prevFocus = null;
}

/** Install the global Ctrl/Cmd-K listener. Idempotent-safe per page load.
 *  Intentionally global — open-from-anywhere is the point of a command palette
 *  (VSCode/Linear/GitHub behaviour), so we deliberately override the native
 *  Ctrl/Cmd-K even while a text field is focused. Opening captures the prior
 *  focus and closing restores it, so typing in the chat is not disrupted. */
export function initCommandPalette(): void {
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (isCommandPaletteOpen()) closeCommandPalette();
      else openCommandPalette();
    }
  });
}
