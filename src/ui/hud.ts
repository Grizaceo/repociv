// ─── RepoCiv — HUD helpers (Civ V Aesthetic) ────────────────────────────────────
import { createIcons } from 'lucide';
import autoAnimate from '@formkit/auto-animate';

let loadingText: HTMLElement | null = null;
let loadingFill: HTMLElement | null = null;

/**
 * Inicializa las librerías externas cargadas por CDN (Lucide, Auto-animate)
 */
export function initExternalLibs() {
  createIcons();

  const hudOverlay = document.getElementById('hud-overlay');
  if (hudOverlay) {
    autoAnimate(hudOverlay);
  }

  const heroBarSlots = document.getElementById('hero-bar-slots');
  if (heroBarSlots) {
    autoAnimate(heroBarSlots);
  }
}

export function showLoadingProgress(pct: number, text: string) {
  if (!loadingText) loadingText = document.getElementById('loading-text');
  if (!loadingFill) loadingFill = document.getElementById('loading-fill');
  if (loadingText) loadingText.textContent = text;
  if (loadingFill) loadingFill.style.width = `${pct}%`;
}

export function hideLoadingScreen() {
  const screen = document.getElementById('loading-screen');
  if (screen) {
    screen.style.opacity = '0';
    screen.style.pointerEvents = 'none';
    setTimeout(() => {
      screen.style.display = 'none';
    }, 600);
  }
}

export function updateResource(id: 'gold' | 'science' | 'production', value: number) {
  const el = document.querySelector<HTMLElement>(`#res-${id} .res-value`);
  if (el) el.textContent = value.toLocaleString();
}

const LOG_MAX = 8;
export function logEvent(
  msg: string,
  type: 'info' | 'warn' | 'success' | 'build' | 'error' = 'info',
) {
  const container = document.getElementById('log-messages');
  if (!container) return;
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;

  let icon = 'circle';
  let color = 'var(--text-dim)';

  if (type === 'success') {
    icon = 'check-circle';
    color = 'var(--civ-food)';
  } else if (type === 'warn') {
    icon = 'alert-triangle';
    color = 'var(--civ-happiness)';
  } else if (type === 'error') {
    icon = 'x-circle';
    color = 'var(--civ-defense)';
  } else if (type === 'build') {
    icon = 'hammer';
    color = 'var(--civ-production)';
  }

  const escapedMsg = msg.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
  entry.innerHTML = `
    <i data-lucide="${icon}" style="width:12px; height:12px; color:${color}; margin-right:6px"></i>
    <span class="log-text" style="color:${color}">${escapedMsg}</span>
  `;

  container.prepend(entry);
  createIcons();

  while (container.children.length > LOG_MAX) {
    container.removeChild(container.lastChild!);
  }
}

export function setBridgeStatus(
  online: boolean,
  mode: 'claude-code' | 'openclaw' | 'hermes' | 'demo' = 'hermes',
) {
  const el = document.getElementById('bridge-status');
  if (!el) return;
  el.classList.toggle('bridge-online', online);
  el.classList.toggle('bridge-offline', !online);
  el.classList.toggle('bridge-demo', mode === 'demo');
  if (online) {
    el.textContent = `⚡ ${mode}`;
    el.title = `Agente activo: ${mode}`;
  } else {
    el.textContent = mode === 'demo' ? '⚡ DEMO' : '⚡ offline';
    el.title = mode === 'demo' ? 'Modo demo — sin ejecución real' : 'Bridge desconectado';
  }
}

export function updateGpuBar(
  data: { vramUsed?: number; vramTotal?: number; temp?: number } | null,
) {
  const bar = document.getElementById('gpu-bar');
  if (!bar) return;
  if (!data || data.vramUsed === undefined) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const vramEl = bar.querySelector<HTMLElement>('.gpu-vram');
  const tempEl = bar.querySelector<HTMLElement>('.gpu-temp');
  if (vramEl && data.vramTotal) {
    const gb = (v: number) => (v / 1024).toFixed(1);
    vramEl.textContent = `VRAM ${gb(data.vramUsed)}/${gb(data.vramTotal)} GB`;
    vramEl.classList.toggle('gpu-warn', data.vramUsed / data.vramTotal > 0.85);
  }
  if (tempEl && data.temp !== undefined) {
    tempEl.textContent = `GPU ${data.temp}°C`;
    tempEl.classList.toggle('gpu-warn', data.temp > 75);
  }
}

export function setOperationTicker(active: boolean, text = '') {
  const el = document.getElementById('operation-ticker');
  if (!el) return;
  el.classList.toggle('hidden', !active);
  const t = document.getElementById('ticker-text');
  if (t && text) t.textContent = text;
}

export function toggleViewHUD(is3D: boolean) {
  const btn = document.getElementById('btn-toggle-3d');
  if (btn) {
    btn.innerHTML = is3D ? '<i data-lucide="layers"></i>' : '<i data-lucide="box"></i>';
    createIcons();
    btn.classList.toggle('active', is3D);
  }
  logEvent(
    is3D ? 'Cámara de perspectiva activada (3D)' : 'Cámara estratégica activada (2D)',
    'info',
  );
}
