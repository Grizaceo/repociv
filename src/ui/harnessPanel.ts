// ─── RepoCiv — Harness Panel (M3) ─────────────────────────────────────────────
// Lists all registered harnesses: trust level, health state, recovery modes.
// Operator can open Recovery Panel for any harness that supports it.

import {
  type HarnessDescriptor,
} from '../harnessRegistry';
import {
  openRecoveryPanel,
  // recovery panel is always imported; it registers itself
} from './recoveryPanel';

// ─── Env ──────────────────────────────────────────────────────────────────────
const BRIDGE_URL   = import.meta.env.VITE_BRIDGE_URL   ?? 'http://localhost:5274';
const BRIDGE_TOKEN = import.meta.env.VITE_BRIDGE_TOKEN ?? '';
const POLL_MS      = 15_000; // harnesses don't change often — poll slowly

// ─── Module state ─────────────────────────────────────────────────────────────
let _panel:    HTMLElement | null = null;
let _timer:    ReturnType<typeof setInterval> | 0 = 0;
let _visible   = false;
let _harnesses: HarnessDescriptor[] = [];

// ─── Public API ────────────────────────────────────────────────────────────────
export function openHarnessPanel() {
  _visible = true;
  _getOrCreate().classList.remove('hidden');
  void _fetch();
}

export function closeHarnessPanel() {
  _visible = false;
  _panel?.classList.add('hidden');
}

export function isHarnessPanelOpen(): boolean { return _visible; }

export function toggleHarnessPanel() {
  if (_visible) closeHarnessPanel();
  else openHarnessPanel();
}

export function startHarnessPolling() {
  _stopPolling();
  void _fetch();
  _timer = setInterval(() => { void _fetch(); }, POLL_MS);
}

export function stopHarnessPolling() {
  _stopPolling();
}

// ─── Polling ──────────────────────────────────────────────────────────────────
function _stopPolling() {
  if (_timer) { clearInterval(_timer); _timer = 0; }
}

async function _fetch() {
  const headers: Record<string, string> = {};
  if (BRIDGE_TOKEN) headers['X-RepoCiv-Token'] = BRIDGE_TOKEN;
  try {
    const res = await fetch(`${BRIDGE_URL}/harnesses`, { headers });
    if (!res.ok) { _renderOffline(); return; }
    _harnesses = await res.json() as HarnessDescriptor[];
    if (_visible) _render();
  } catch {
    _renderOffline();
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function _render() {
  const body = _getOrCreate().querySelector<HTMLElement>('.hp-body')!;
  body.innerHTML = `
    <div class="hp-grid">
      ${_harnesses.length === 0
        ? '<div class="hp-empty">Sin harnesses registrados</div>'
        : _harnesses.map(h => _harnessCard(h)).join('')}
    </div>
  `;
  // Wire "Recover" buttons after render
  void _wireActions();
}

function _renderOffline() {
  const body = _getOrCreate().querySelector<HTMLElement>('.hp-body')!;
  body.innerHTML = '<div class="hp-offline">⚠ Bridge offline — no se pudieron cargar harnesses</div>';
}

function _harnessCard(h: HarnessDescriptor): string {
  const trust      = _trustLabel(h.trustLevel);
  const trustColor = _trustColor(h.trustLevel);
  const healthIcon = _healthIcon(h);
  const canRecover = h.recoveryModes.length > 0 && h.recoveryModes[0] !== 'no_recovery_available';

  return `
    <div class="hp-card" data-harness="${_esc(h.id)}">
      <div class="hp-card-header">
        <span class="hp-label">${_esc(h.label)}</span>
        <span class="hp-badge hp-badge--trust" style="color:${trustColor}">${trust}</span>
      </div>
      <div class="hp-card-meta">
        <span class="hp-kind">${_esc(h.kind)}</span>
        <span class="hp-sep">·</span>
        <span class="hp-transport">${_esc(h.transport)}</span>
        <span class="hp-sep">·</span>
        <span class="hp-health">${healthIcon}</span>
      </div>
      ${h.recoveryModes.length > 0 ? `
        <div class="hp-recovery-modes">
          ${h.recoveryModes.map(m => `<span class="hp-rm-chip">${_esc(m)}</span>`).join('')}
        </div>
      ` : ''}
      <div class="hp-card-actions">
        ${canRecover ? `
          <button class="hp-btn hp-btn--recover" data-harness="${_esc(h.id)}" title="Abrir plan de recuperación">
            🔧 Recovery
          </button>
        ` : '<span class="hp-no-recovery">sin recovery</span>'}
      </div>
    </div>
  `;
}

// ─── Action wiring ────────────────────────────────────────────────────────────
// Buttons are added to the DOM by _render; we re-wire on each render call.
async function _wireActions() {
  const panel = _getOrCreate();
  for (const btn of panel.querySelectorAll<HTMLButtonElement>('.hp-btn--recover')) {
    // Remove old handler to avoid duplicates on re-render
    btn.replaceWith(btn.cloneNode(true) as HTMLButtonElement);
  }
  // Re-query after replace
  for (const btn of _getOrCreate().querySelectorAll<HTMLButtonElement>('.hp-btn--recover')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset['harness'] ?? '';
      void openRecoveryPanel(id, 'operator_requested');
    });
  }
}

// ─── Trust helpers ─────────────────────────────────────────────────────────────
function _trustLabel(t: string): string {
  const map: Record<string, string> = {
    reference_only:       '🔒 reference',
    read_only:            '🔓 read-only',
    local_cli:            '⚡ local-cli',
    sandboxed:            '🟡 sandboxed',
    privileged_external:   '🔓 privileged',
  };
  return map[t] ?? t;
}

function _trustColor(t: string): string {
  const map: Record<string, string> = {
    reference_only:     '#888',
    read_only:          '#5b9b5b',
    local_cli:          '#4a9ade',
    sandboxed:          '#e8a040',
    privileged_external: '#d44b4b',
  };
  return map[t] ?? '#888';
}

function _healthIcon(h: HarnessDescriptor): string {
  const k = h.health?.kind;
  if (k === 'static') {
    const s = h.health?.status;
    return s === 'ok' ? '✔' : s === 'warn' ? '⚠' : '✘';
  }
  if (k === 'command') return '⌘';
  if (k === 'http')    return '🌐';
  return '?';
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  const el = document.createElement('div');
  el.id = 'harness-panel';
  el.className = 'hp-panel hidden';
  el.innerHTML = `
    <div class="hp-header">
      <span class="hp-title">⚡ HARNESS REGISTRY</span>
      <button id="hp-close" title="Cerrar">✕</button>
    </div>
    <div class="hp-body"></div>
  `;
  document.body.appendChild(el);
  el.querySelector('#hp-close')?.addEventListener('click', closeHarnessPanel);
  _panel = el;
  return el;
}

// ─── Misc ─────────────────────────────────────────────────────────────────────
function _esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
