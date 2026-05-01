// ─── RepoCiv — Settings Panel (Phase 10.2) ───────────────────────────────────
// Parametric fatigue thresholds, animation controls, model allowlist.

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

  // Sliders — fatigue thresholds
  const warnSlider = panel.querySelector<HTMLInputElement>('#set-fatigue-warn')!;
  const critSlider = panel.querySelector<HTMLInputElement>('#set-fatigue-crit')!;
  warnSlider.value = String(c.fatigue.warnThreshold * 100);
  critSlider.value = String(c.fatigue.criticalThreshold * 100);

  // Slider labels
  const warnVal = panel.querySelector<HTMLElement>('#set-fatigue-warn-val')!;
  const critVal = panel.querySelector<HTMLElement>('#set-fatigue-crit-val')!;
  warnVal.textContent = `${Math.round(c.fatigue.warnThreshold * 100)}%`;
  critVal.textContent = `${Math.round(c.fatigue.criticalThreshold * 100)}%`;

  // Animation toggle
  const skipAnim = panel.querySelector<HTMLInputElement>('#set-skip-anim')!;
  skipAnim.checked = c.animations.skipAll;

  // Model allowlist
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

      <!-- ── FATIGUE THRESHOLDS ────────────────────────────────────────────── -->
      <section class="settings-section">
        <h3 class="settings-section-title">Fatiga — Umbrales</h3>

        <div class="setting-row">
          <label class="setting-label" for="set-fatigue-warn">
            Bajo ⚠ <span id="set-fatigue-warn-val" class="setting-val">30%</span>
          </label>
          <input type="range" id="set-fatigue-warn" class="setting-range"
            min="5" max="80" value="30" step="5" />
          <span class="setting-desc">Barra naranja cuando contexto &lt; este valor</span>
        </div>

        <div class="setting-row">
          <label class="setting-label" for="set-fatigue-crit">
            Crítico ☠ <span id="set-fatigue-crit-val" class="setting-val">60%</span>
          </label>
          <input type="range" id="set-fatigue-crit" class="setting-range"
            min="10" max="95" value="60" step="5" />
          <span class="setting-desc">Barra roja cuando contexto &lt; este valor</span>
        </div>

        <div class="setting-hint">
          ⚡ Umbral crítico debe ser ≥ umbral bajo
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

  // ─── Wire events ─────────────────────────────────────────────────────────────
  const closeBtn = panel.querySelector<HTMLButtonElement>('#settings-close')!;
  const closeFooterBtn = panel.querySelector<HTMLButtonElement>('#settings-close-btn')!;
  const resetBtn = panel.querySelector<HTMLButtonElement>('#settings-reset')!;
  const warnSlider = panel.querySelector<HTMLInputElement>('#set-fatigue-warn')!;
  const critSlider = panel.querySelector<HTMLInputElement>('#set-fatigue-crit')!;
  const warnVal = panel.querySelector<HTMLElement>('#set-fatigue-warn-val')!;
  const critVal = panel.querySelector<HTMLElement>('#set-fatigue-crit-val')!;
  const skipAnim = panel.querySelector<HTMLInputElement>('#set-skip-anim')!;
  const modelInput = panel.querySelector<HTMLInputElement>('#set-models')!;

  const closeHandler = () => closeSettingsPanel();
  closeBtn.addEventListener('click', closeHandler);
  closeFooterBtn.addEventListener('click', closeHandler);

  resetBtn.addEventListener('click', () => {
    const def = resetConfig();
    const w = panel.querySelector<HTMLInputElement>('#set-fatigue-warn')!;
    const c = panel.querySelector<HTMLInputElement>('#set-fatigue-crit')!;
    w.value = String(def.fatigue.warnThreshold * 100);
    c.value = String(def.fatigue.criticalThreshold * 100);
    warnVal.textContent = `${Math.round(def.fatigue.warnThreshold * 100)}%`;
    critVal.textContent = `${Math.round(def.fatigue.criticalThreshold * 100)}%`;
    skipAnim.checked = def.animations.skipAll;
    modelInput.value = '';
    applyAnimConfig(def);
  });

  warnSlider.addEventListener('input', () => {
    const wv = parseInt(warnSlider.value) / 100;
    warnVal.textContent = `${Math.round(wv * 100)}%`;
    persistFromDOM();
  });

  critSlider.addEventListener('input', () => {
    const cv = parseInt(critSlider.value) / 100;
    critVal.textContent = `${Math.round(cv * 100)}%`;
    persistFromDOM();
  });

  skipAnim.addEventListener('change', persistFromDOM);

  modelInput.addEventListener('change', persistFromDOM);

  // Validate: warn < crit
  warnSlider.addEventListener('change', () => {
    const wv = parseInt(warnSlider.value);
    const cv = parseInt(critSlider.value);
    if (wv >= cv) {
      critSlider.value = String(Math.min(95, wv + 10));
      critVal.textContent = `${critSlider.value}%`;
    }
    persistFromDOM();
  });

  critSlider.addEventListener('change', () => {
    const wv = parseInt(warnSlider.value);
    const cv = parseInt(critSlider.value);
    if (cv <= wv) {
      warnSlider.value = String(Math.max(5, cv - 10));
      warnVal.textContent = `${warnSlider.value}%`;
    }
    persistFromDOM();
  });
}

function persistFromDOM() {
  const panel = getPanel();
  if (!panel) return;
  const c = loadConfig();
  const newCfg: GameConfig = {
    ...c,
    fatigue: {
      ...c.fatigue,
      warnThreshold:
        parseInt(panel.querySelector<HTMLInputElement>('#set-fatigue-warn')!.value) / 100,
      criticalThreshold:
        parseInt(panel.querySelector<HTMLInputElement>('#set-fatigue-crit')!.value) / 100,
    },
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
