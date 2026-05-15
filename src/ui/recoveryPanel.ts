// ─── RepoCiv — Recovery Panel (M3) ────────────────────────────────────────────
// Context-driven panel: opens on command failure OR explicit operator request.
// Shows harness info + a copiable shell command with rationale.
// NO embedded terminal (v1 scope).

import type { RecoveryPlan } from '../recoveryClient';
import { requestRecoveryPlan } from '../recoveryClient';
import { ensurePanel, hidePanel, showPanel, bindPanelAction } from './panelShell.ts';

// ─── Module state ───────────────────────────────────────────────────────────────
let _panel: HTMLElement | null = null;
let _visible = false;

// ─── Context that opened the panel ────────────────────────────────────────────
let _currentHarnessId = '';
let _currentReason = '';
let _currentPlan: RecoveryPlan | null = null;
let _loading = false;

// ─── Public API ────────────────────────────────────────────────────────────────
export function isRecoveryPanelOpen(): boolean {
  return _visible;
}

export function closeRecoveryPanel() {
  _visible = false;
  if (_panel) hidePanel(_panel);
}

/** Open the recovery panel for a specific harness.
 *
 * @param harnessId  — harness id (e.g. "hermes-local")
 * @param reason     — 'operator_requested' | failure reason string
 * @param context    — optional failure context from the failed command
 */
export async function openRecoveryPanel(
  harnessId: string,
  reason: string,
  context: { command_type?: string; target?: string; details?: string } = {},
): Promise<void> {
  _currentHarnessId = harnessId;
  _currentReason = reason;
  _currentPlan = null;
  _loading = true;
  _visible = true;

  showPanel(_getOrCreate());
  _renderLoading();

  try {
    _currentPlan = await requestRecoveryPlan(harnessId, reason, context);
    _loading = false;
    _render();
  } catch (err) {
    _loading = false;
    _renderError(err instanceof Error ? err.message : String(err));
  }
}

/** Re-open the panel with the last-known harness+reason (no new fetch). */

// ─── Render ───────────────────────────────────────────────────────────────────
function _renderLoading() {
  const body = _getOrCreate().querySelector<HTMLElement>('.rp-body')!;
  body.innerHTML = '<div class="rp-loading">🔧 Construyendo plan de recovery…</div>';
}

function _renderError(msg: string) {
  const body = _getOrCreate().querySelector<HTMLElement>('.rp-body')!;
  body.innerHTML = `
    <div class="rp-error">
      <div class="rp-error-title">⚠ No se pudo generar el plan</div>
      <div class="rp-error-msg">${_esc(msg)}</div>
      <button class="rp-btn rp-btn--retry" id="rp-retry" aria-label="Reintentar generar plan de recuperación">Reintentar</button>
    </div>
  `;
  bindPanelAction(_getOrCreate(), '#rp-retry', () => {
    void openRecoveryPanel(_currentHarnessId, _currentReason);
  });
}

function _render() {
  const body = _getOrCreate().querySelector<HTMLElement>('.rp-body')!;
  const plan = _currentPlan;

  if (!plan) {
    body.innerHTML = '<div class="rp-empty">Sin plan de recovery disponible.</div>';
    return;
  }

  const { command, session, notes = [], mode, cwd } = plan;
  const hasCommand = Boolean(command);
  const hasSession = Boolean(session);

  body.innerHTML = `
    <!-- Recovery mode badge -->
    <div class="rp-mode-row">
      <span class="rp-mode-label">Modo</span>
      <span class="rp-mode-chip">${_esc(mode)}</span>
    </div>

    <!-- Rationale notes -->
    ${
      notes.length > 0
        ? `
      <div class="rp-notes">
        ${notes.map((n) => `<p class="rp-note">${_esc(n)}</p>`).join('')}
      </div>
    `
        : ''
    }

    <!-- Shell command block -->
    ${
      hasCommand
        ? `
      <div class="rp-command-block">
        <div class="rp-command-header">
          <span class="rp-command-label">Shell command</span>
          <button class="rp-btn rp-btn--copy" id="rp-copy" title="Copiar al portapapeles" aria-label="Copiar comando al portapapeles">
            📋 Copiar
          </button>
        </div>
        ${cwd ? `<div class="rp-cwd">cwd: <code>${_esc(cwd)}</code></div>` : ''}
        <pre class="rp-command-pre">${_esc(command ?? '')}</pre>
      </div>
    `
        : ''
    }

    ${
      hasSession
        ? `
      <div class="rp-session-block">
        <div class="rp-session-label">tmux session</div>
        <code class="rp-session-name">${_esc(session ?? '')}</code>
        <p class="rp-session-hint">Usa <code>tmux attach -t ${_esc(session ?? '')}</code> para reconectar.</p>
      </div>
    `
        : ''
    }

    <!-- Footer -->
    <div class="rp-footer">
      <span class="rp-harness-id">harness: ${_esc(_currentHarnessId)}</span>
      <button class="rp-btn rp-btn--close" id="rp-close-panel" aria-label="Cerrar panel de recuperación">Cerrar</button>
    </div>
  `;

  // Wire copy button
  _getOrCreate()
    .querySelector('#rp-copy')
    ?.addEventListener('click', () => _copyToClipboard(command ?? ''));

  bindPanelAction(_getOrCreate(), '#rp-close-panel', closeRecoveryPanel);
}

// ─── Clipboard ────────────────────────────────────────────────────────────────
async function _copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    const btn = _getOrCreate().querySelector<HTMLButtonElement>('#rp-copy');
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = '✅ Copiado';
      setTimeout(() => {
        btn.textContent = prev ?? '📋 Copiar';
      }, 1500);
    }
  } catch {
    // Fallback for non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

// ─── DOM ─────────────────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  _panel = ensurePanel(
    'recovery-panel',
    'rp-panel hidden',
    `
    <div class="rp-header">
      <span class="rp-title">🔧 RECOVERY PLAN</span>
      <button id="rp-x" title="Cerrar" aria-label="Cerrar panel de recuperación">✕</button>
    </div>
    <div class="rp-body"></div>
  `,
  );
  bindPanelAction(_panel, '#rp-x', closeRecoveryPanel);
  return _panel;
}

// ─── Misc ─────────────────────────────────────────────────────────────────────
function _esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
