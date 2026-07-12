// ─── RepoCiv — Settings Panel (Phase 10.2) ───────────────────────────────────
// Animation controls, model allowlist, trust settings.

import { loadConfig, saveConfig, resetConfig, type GameConfig } from '../gameConfig.ts';

// ─── State ────────────────────────────────────────────────────────────────────
let isOpen = false;

function getPanel(): HTMLElement | null {
  return document.getElementById('settings-panel');
}

// ─── Public API (matches priorityPanel.ts pattern) ────────────────────────────
export function openSettingsPanel() {
  isOpen = true;
  render();
}

export function closeSettingsPanel() {
  isOpen = false;
  const p = getPanel();
  if (p) p.classList.add('hidden');
}

export function toggleSettingsPanel() {
  isOpen ? closeSettingsPanel() : openSettingsPanel();
}

// ─── Render ────────────────────────────────────────────────────────────────────
function render() {
  let panel = getPanel();
  if (!panel) {
    buildDOM();
    panel = getPanel()!;
  }

  const c = loadConfig();

  const autoApproveChat = panel.querySelector<HTMLInputElement>('#set-auto-approve-chat')!;
  autoApproveChat.checked = c.trust.autoApproveChat;

  const skipAnim = panel.querySelector<HTMLInputElement>('#set-skip-anim')!;
  skipAnim.checked = c.animations.skipAll;

  const modelInput = panel.querySelector<HTMLInputElement>('#set-models')!;
  modelInput.value = c.models.allowed.join(', ');

  panel.classList.remove('hidden');
}

function buildDOM() {
  const app = document.getElementById('app');
  if (!app) return;

  const panel = document.createElement('div');
  panel.id = 'settings-panel';
  panel.className = 'settings-panel hidden';
  panel.innerHTML = `
    <div class="settings-header">
      <div class="settings-title-row">
        <span class="settings-title">⚙ Configuración Imperial</span>
      </div>
      <button id="settings-close" class="icon-btn" title="Cerrar" aria-label="Cerrar panel de configuración">[ X ]</button>
    </div>

    <div class="settings-body">

      <!-- ── TRUST / APPROVALS ───────────────────────────────────────────────── -->
      <section class="settings-section">
        <h3 class="settings-section-title">Confianza y Aprobaciones</h3>

        <div class="setting-row setting-row--toggle">
          <label class="toggle-label" for="set-auto-approve-chat">
            <input type="checkbox" id="set-auto-approve-chat" class="setting-check" />
            <span class="toggle-text">Auto-aprobar comandos de chat</span>
          </label>
          <span class="setting-desc">Enviar mensaje equivale a aprobarlo — omite la tarjeta de aprobación para <code>execute_agent</code></span>
        </div>
      </section>

      <!-- ── ANIMATIONS ────────────────────────────────────────────────────── -->
      <section class="settings-section">
        <h3 class="settings-section-title">Animaciones</h3>

        <div class="setting-row setting-row--toggle">
          <label class="toggle-label" for="set-skip-anim">
            <input type="checkbox" id="set-skip-anim" class="setting-check" />
            <span class="toggle-text">Omitir animaciones</span>
          </label>
          <span class="setting-desc">Desactiva transiciones y efectos visuales</span>
        </div>
      </section>

      <!-- ── MODEL ALLOWLIST ──────────────────────────────────────────────── -->
      <section class="settings-section">
        <h3 class="settings-section-title">Modelos Permitidos</h3>

        <div class="setting-row setting-row--column">
          <label class="setting-label" for="set-models">
            IDs de modelo (separados por coma)
          </label>
          <input type="text" id="set-models" class="setting-text"
            placeholder="anthropic/claude-sonnet-4, openai/gpt-4o..."
            autocomplete="off" spellcheck="false" />
          <span class="setting-desc">
            Vacío = todos permitidos. Ej: <code>claude-3-5-sonnet</code>
          </span>
        </div>
      </section>

    </div><!-- /settings-body -->

    <div class="settings-footer">
      <button id="settings-reset" class="btn-secondary" aria-label="Restaurar valores por defecto">Restaurar valores</button>
      <button id="settings-close-btn" class="btn-primary" aria-label="Cerrar panel de configuración">Cerrar</button>
    </div>
  `;

  app.appendChild(panel);

  const closeBtn = panel.querySelector<HTMLButtonElement>('#settings-close')!;
  const closeFooterBtn = panel.querySelector<HTMLButtonElement>('#settings-close-btn')!;
  const resetBtn = panel.querySelector<HTMLButtonElement>('#settings-reset')!;
  const skipAnim = panel.querySelector<HTMLInputElement>('#set-skip-anim')!;
  const modelInput = panel.querySelector<HTMLInputElement>('#set-models')!;
  const autoApproveChatEl = panel.querySelector<HTMLInputElement>('#set-auto-approve-chat')!;

  const closeHandler = () => closeSettingsPanel();
  closeBtn.addEventListener('click', closeHandler);
  closeFooterBtn.addEventListener('click', closeHandler);

  resetBtn.addEventListener('click', () => {
    const def = resetConfig();
    skipAnim.checked = def.animations.skipAll;
    autoApproveChatEl.checked = def.trust.autoApproveChat;
    modelInput.value = '';
    applyAnimConfig(def);
  });

  skipAnim.addEventListener('change', persistFromDOM);
  autoApproveChatEl.addEventListener('change', persistFromDOM);
  modelInput.addEventListener('change', persistFromDOM);
}

function persistFromDOM() {
  const panel = getPanel();
  if (!panel) return;
  const c = loadConfig();
  const newCfg: GameConfig = {
    ...c,
    animations: {
      ...c.animations,
      skipAll: panel.querySelector<HTMLInputElement>('#set-skip-anim')!.checked,
    },
    models: {
      ...c.models,
      allowed: panel
        .querySelector<HTMLInputElement>('#set-models')!
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    trust: {
      ...c.trust,
      autoApproveChat: panel.querySelector<HTMLInputElement>('#set-auto-approve-chat')!.checked,
    },
  };
  saveConfig(newCfg);
  applyAnimConfig(newCfg);
}

function applyAnimConfig(cfg: GameConfig) {
  const root = document.documentElement;
  if (cfg.animations.skipAll) {
    root.style.setProperty('--transition-fast', '0ms');
    root.style.setProperty('--transition-slow', '0ms');
  } else {
    root.style.setProperty('--transition-fast', '0.2s cubic-bezier(0.4, 0, 0.2, 1)');
    root.style.setProperty('--transition-slow', '0.5s cubic-bezier(0.4, 0, 0.2, 1)');
  }
}
