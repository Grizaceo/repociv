// ─── RepoCiv — HUD helpers (Civ V Aesthetic) ────────────────────────────────────
import autoAnimate from '@formkit/auto-animate';
import {
  Activity,
  AlertTriangle,
  Box,
  Camera,
  CheckCircle,
  Circle,
  ClipboardList,
  Coins,
  Crosshair,
  FileText,
  FlaskConical,
  Hammer,
  Layers,
  Pickaxe,
  RotateCcw,
  Scroll,
  ScrollText,
  Settings,
  SunMoon,
  Terminal,
  TriangleAlert,
  XCircle,
  createIcons,
} from 'lucide';

const lucideIcons = {
  Activity,
  AlertTriangle,
  Box,
  Camera,
  CheckCircle,
  Circle,
  ClipboardList,
  Coins,
  Crosshair,
  FileText,
  FlaskConical,
  Hammer,
  Layers,
  Pickaxe,
  RotateCcw,
  Scroll,
  ScrollText,
  Settings,
  SunMoon,
  Terminal,
  TriangleAlert,
  XCircle,
};

// Expose only the icons RepoCiv actually uses; importing all Lucide icons adds ~700 KB.
type LucideApi = { createIcons: typeof createIcons; icons: typeof lucideIcons };
(window as unknown as { lucide: LucideApi }).lucide = { createIcons, icons: lucideIcons };

let loadingText: HTMLElement | null = null;
let loadingFill: HTMLElement | null = null;

/**
 * Inicializa las librerías externas cargadas por CDN (Lucide, Auto-animate)
 */
export function initExternalLibs() {
  const lucide = (window as unknown as Record<string, unknown>)['lucide'];
  if (lucide)
    (lucide as { createIcons: (opts: { icons: unknown }) => void }).createIcons({
      icons: (lucide as Record<string, unknown>)['icons'],
    });

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

/** Update the task-count and idle-agent-count badges on the bottom-right button strip. */
export function updateBadges(activeTasks: number, idleCount: number): void {
  const tasksBadge = document.getElementById('btn-tasks-badge');
  if (tasksBadge) {
    tasksBadge.textContent = activeTasks > 99 ? '99+' : String(activeTasks);
    tasksBadge.classList.toggle('active', activeTasks > 0);
  }
  const idleBadge = document.getElementById('btn-idle-agent-badge');
  if (idleBadge) {
    idleBadge.textContent = idleCount > 99 ? '99+' : String(idleCount);
    idleBadge.classList.toggle('active', idleCount > 0);
  }
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
  const lucide = (window as unknown as Record<string, unknown>)['lucide'];
  if (lucide)
    (lucide as { createIcons: (opts: { icons: unknown; root: Element }) => void }).createIcons({
      icons: (lucide as Record<string, unknown>)['icons'],
      root: entry,
    });

  while (container.children.length > LOG_MAX) {
    container.removeChild(container.lastChild!);
  }
}

export function setBridgeStatus(
  online: boolean,
  mode: 'claude-code' | 'openclaw' | 'hermes' | 'demo' = 'hermes',
  health?: { cursor?: boolean },
) {
  const el = document.getElementById('bridge-status');
  if (!el) return;
  el.classList.toggle('bridge-online', online);
  el.classList.toggle('bridge-offline', !online);
  el.classList.toggle('bridge-demo', mode === 'demo');
  if (online) {
    el.textContent = `Bridge OK · ${mode}`;
    const cursor = health?.cursor;
    const cursorLine =
      cursor === undefined
        ? ''
        : cursor
          ? 'cursor-agent: instalado (Swarm tracking disponible)'
          : 'cursor-agent: no instalado — Swarm subagent tracking no disponible';
    el.title = [`Bridge HTTP activo · transporte ${mode}`, cursorLine].filter(Boolean).join('\n');
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
    const lucide = (window as unknown as Record<string, unknown>)['lucide'];
    if (lucide)
      (lucide as { createIcons: (opts: { icons: unknown; root: Element }) => void }).createIcons({
        icons: (lucide as Record<string, unknown>)['icons'],
        root: btn,
      });
    btn.classList.toggle('active', is3D);
  }
  logEvent(
    is3D ? 'Cámara de perspectiva activada (3D)' : 'Cámara estratégica activada (2D)',
    'info',
  );
}
