// ─── RepoCiv — Wonder Vignette (iframe wrapper with health-check) ──────────────
import type { WonderType } from '../types.ts';

const WONDER_URLS: Record<WonderType, string> = {
  bibliotheca: 'http://localhost:3001',
  institutum: 'http://localhost:5280',
};

const STORAGE_POS = (t: WonderType) => `repociv-vignette-pos-${t}`;

interface VignetteState {
  x: number;
  y: number;
  w: number;
  h: number;
}

function _loadState(type: WonderType): VignetteState {
  try {
    const raw = localStorage.getItem(STORAGE_POS(type));
    if (raw) return JSON.parse(raw);
  } catch { /* noop */ }
  return { x: 0, y: 0, w: 0, h: 0 };
}

function _saveState(type: WonderType, s: VignetteState) {
  try { localStorage.setItem(STORAGE_POS(type), JSON.stringify(s)); } catch { /* noop */ }
}

let _vignette: HTMLElement | null = null;
let _activeType: WonderType | null = null;
let _dragging = false;
let _dragOffset = { x: 0, y: 0 };

export async function openWonderVignette(type: WonderType): Promise<void> {
  if (_vignette) closeWonderVignette();

  _activeType = type;

  const container = document.createElement('div');
  container.id = 'wonder-vignette';
  container.className = 'wonder-vignette';
  const url = WONDER_URLS[type];

  container.innerHTML = `
    <div class="wonder-vignette-header">
      <span class="wonder-title">${type === 'bibliotheca' ? '📚 Bibliotheca Alexandrina' : '🧪 Institutum Scientiarum'}</span>
      <div class="wonder-controls">
        <button class="wonder-fullscreen" title="Fullscreen">⛶</button>
        <button class="wonder-close" title="Cerrar">✕</button>
      </div>
    </div>
    <div class="wonder-vignette-body">
      <div class="wonder-loading">Verificando estado de la maravilla...</div>
    </div>
  `;
  document.body.appendChild(container);
  _vignette = container;

  // Load persisted position/size
  const st = _loadState(type);
  if (st.w && st.h) {
    container.style.width = `${st.w}px`;
    container.style.height = `${st.h}px`;
  } else {
    container.style.width = '70vw';
    container.style.height = '75vh';
  }
  if (st.x || st.y) {
    container.style.left = `${st.x}px`;
    container.style.top = `${st.y}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';
    container.style.transform = 'none';
  }

  // Event bindings
  container.querySelector('.wonder-close')!.addEventListener('click', closeWonderVignette);
  container.querySelector('.wonder-fullscreen')!.addEventListener('click', _toggleFullscreen);
  const header = container.querySelector('.wonder-vignette-header') as HTMLElement;
  header.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    _dragging = true;
    const rect = container.getBoundingClientRect();
    _dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    header.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', (e) => {
    if (!_dragging || !_vignette) return;
    _vignette.style.left = `${e.clientX - _dragOffset.x}px`;
    _vignette.style.top = `${e.clientY - _dragOffset.y}px`;
    _vignette.style.right = 'auto';
    _vignette.style.bottom = 'auto';
    _vignette.style.transform = 'none';
  });
  window.addEventListener('mouseup', () => {
    if (!_dragging) return;
    _dragging = false;
    header.style.cursor = 'grab';
    if (_vignette) {
      const r = _vignette.getBoundingClientRect();
      _saveState(_activeType!, { x: r.left, y: r.top, w: r.width, h: r.height });
    }
  });

  // Resize observer to persist dimensions
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const r = entry.contentRect;
      const pos = _vignette?.getBoundingClientRect();
      if (pos && _activeType) {
        _saveState(_activeType, { x: pos.left, y: pos.top, w: r.width, h: r.height });
      }
    }
  });
  ro.observe(container);

  // Health check
  const body = container.querySelector('.wonder-vignette-body') as HTMLElement;
  body.innerHTML = '<div class="wonder-loading">Verificando estado de la maravilla...</div>';

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 3000);
    await fetch(url, { method: 'HEAD', mode: 'no-cors', signal: ctrl.signal });
    clearTimeout(tid);
    // no-cors returns opaque → we can't read status, but absence of error = likely ok
    _mountIframe(body, url);
  } catch {
    _showEmptyState(body, type);
  }
}

export function closeWonderVignette(): void {
  if (_vignette) {
    _vignette.remove();
    _vignette = null;
  }
  _activeType = null;
}

function _mountIframe(body: HTMLElement, url: string): void {
  body.innerHTML = `
    <iframe
      src="${url}"
      sandbox="allow-scripts allow-same-origin allow-forms"
      loading="eager"
      title="Wonder"
    ></iframe>
  `;
  const iframe = body.querySelector('iframe')!;
  iframe.addEventListener('load', () => {
    body.querySelector('.wonder-loading')?.remove();
  });
  iframe.addEventListener('error', () => {
    body.innerHTML = `<div class="wonder-empty">La maravilla está en construcción. Los obreros duermen... <button class="wonder-retry">Reintentar</button></div>`;
  });
}

function _showEmptyState(body: HTMLElement, type: WonderType): void {
  body.innerHTML = `
    <div class="wonder-empty">
      <div class="wonder-empty-icon">🏗️</div>
      <div class="wonder-empty-title">La maravilla está en construcción</div>
      <div class="wonder-empty-sub">Los obreros duermen. Vuelve más tarde.</div>
      <button class="wonder-retry">Reintentar</button>
    </div>
  `;
  body.querySelector('.wonder-retry')!.addEventListener('click', () => {
    openWonderVignette(type);
  });
}

function _toggleFullscreen(): void {
  if (!_vignette) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    _vignette.requestFullscreen().catch(() => { /* noop */ });
  }
}
