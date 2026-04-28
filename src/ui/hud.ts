// ─── RepoCiv — HUD helpers ────────────────────────────────────────────────────

let loadingText: HTMLElement | null = null;
let loadingFill: HTMLElement | null = null;

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
    setTimeout(() => { screen.style.display = 'none'; }, 400);
  }
}

export function updateResource(id: 'gold' | 'science' | 'production', value: number) {
  const el = document.querySelector<HTMLElement>(`#res-${id} .res-value`);
  if (el) el.textContent = value.toLocaleString();
}

const LOG_MAX = 6;
export function logEvent(msg: string, type: 'info' | 'warn' | 'success' = 'info') {
  const container = document.getElementById('log-messages');
  if (!container) return;
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type === 'warn' ? 'error' : type === 'success' ? 'gold' : 'info'}`;
  entry.textContent = msg;
  container.appendChild(entry);
  while (container.children.length > LOG_MAX) {
    container.removeChild(container.firstChild!);
  }
}

export function setBridgeStatus(online: boolean, mode: 'openclaw' | 'hermes' | 'demo' = 'hermes') {
  const el = document.getElementById('bridge-status');
  if (!el) return;
  el.classList.toggle('bridge-online', online);
  el.classList.toggle('bridge-offline', !online);
  el.classList.toggle('bridge-demo', mode === 'demo');
  el.textContent = online ? `⚡ ${mode}` : (mode === 'demo' ? '⚡ DEMO' : '⚡ offline');
}

export function updateGpuBar(data: { vramUsed?: number; vramTotal?: number; temp?: number } | null) {
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
    vramEl.classList.toggle('gpu-warn', data.vramUsed / data.vramTotal > 0.875);
  }
  if (tempEl && data.temp !== undefined) {
    tempEl.textContent = `GPU ${data.temp}°C`;
    tempEl.classList.toggle('gpu-warn', data.temp > 80);
  }
}

export function setOperationTicker(active: boolean, text = '') {
  const el = document.getElementById('operation-ticker');
  if (!el) return;
  el.classList.toggle('hidden', !active);
  const t = document.getElementById('ticker-text');
  if (t && text) t.textContent = text;
}
