// ─── RepoCiv — Wonder Vignette (iframe wrapper with health-check) ──────────────
import type { WonderType } from '../types.ts';
import {
  checkLgbReachability,
  wonderUiUrl,
  WONDER_BIBLIOTHECA_URL,
  LGB_BACKEND_URL,
} from '../wonderEnv.ts';

const STORAGE_POS = (t: WonderType) => `repociv-vignette-pos-${t}`;
const IFRAME_LOAD_TIMEOUT_MS = 25000;

type EmptyReason =
  | 'lgb-offline'
  | 'lgb-backend-offline'
  | 'lgb-ui-offline'
  | 'load-timeout';

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

  const body = container.querySelector('.wonder-vignette-body') as HTMLElement;
  body.innerHTML = '<div class="wonder-loading">Verificando estado de la maravilla...</div>';

  if (type === 'bibliotheca') {
    const { backend, ui } = await checkLgbReachability();
    if (!ui && !backend) {
      _showEmptyState(body, type, 'lgb-offline');
      return;
    }
    if (!ui) {
      _showEmptyState(body, type, 'lgb-ui-offline');
      return;
    }
    // UI reachable: Vite proxies /api → loopback :3001 inside the iframe even when
    // RepoCiv (e.g. Windows) cannot hit 127.0.0.1:3001 on the LGB host (WSL/Tailscale).
    if (!backend) {
      console.warn(
        '[Bibliotheca] Backend no alcanzable desde RepoCiv; montando iframe (API vía proxy Vite en :5173).',
      );
    }
    _mountIframe(body, wonderUiUrl(type), type);
    return;
  }

  const url = wonderUiUrl(type);
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 3000);
    await fetch(url, { method: 'HEAD', mode: 'no-cors', signal: ctrl.signal });
    clearTimeout(tid);
    _mountIframe(body, url, type);
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

function _mountIframe(body: HTMLElement, url: string, type: WonderType): void {
  const title =
    type === 'bibliotheca' ? 'Bibliotheca Alexandrina' : 'Institutum Scientiarum';
  body.innerHTML = `
    <iframe
      src="${url}"
      sandbox="allow-scripts allow-same-origin allow-forms"
      allow="fullscreen"
      loading="eager"
      title="${title}"
    ></iframe>
  `;
  const iframe = body.querySelector('iframe')!;
  let settled = false;
  const fail = (reason?: EmptyReason) => {
    if (settled) return;
    settled = true;
    _showEmptyState(body, type, reason);
  };
  const loadTimer = setTimeout(
    () => fail(type === 'bibliotheca' ? 'load-timeout' : undefined),
    IFRAME_LOAD_TIMEOUT_MS,
  );
  iframe.addEventListener('load', () => {
    if (settled) return;
    settled = true;
    clearTimeout(loadTimer);
  });
  iframe.addEventListener('error', () => fail());
}

function _emptySub(type: WonderType, reason?: EmptyReason): string {
  if (type !== 'bibliotheca') {
    return 'Los obreros duermen. Vuelve más tarde.';
  }
  const ui = WONDER_BIBLIOTHECA_URL;
  const api = LGB_BACKEND_URL;
  switch (reason) {
    case 'lgb-offline':
      return (
        `Arranca La Gran Biblioteca en otra terminal:<br>` +
        `<code>python -m backend.library_bridge</code> (API ${api})<br>` +
        `<code>cd frontend && npm run dev</code> (UI ${ui})`
      );
    case 'lgb-backend-offline':
      return (
        `El backend no responde (probado <code>${api}/api/health</code> y 127.0.0.1:3001). ` +
        `Ejecuta <code>python -m backend.library_bridge</code> en la-gran-biblioteca. ` +
        `Si la UI va por Tailscale, el iframe puede usar <code>${ui}</code> aunque el API sea solo local.`
      );
    case 'lgb-ui-offline':
      return `El backend responde, pero la UI no en <code>${ui}</code>. Ejecuta <code>cd frontend && npm run dev</code> en la-gran-biblioteca.`;
    case 'load-timeout':
      return (
        `La UI en <code>${ui}</code> no cargó a tiempo. Comprueba que Vite esté arriba y abre esa URL en una pestaña. ` +
        `(API: <code>${api}</code>)`
      );
    default:
      return 'Los obreros duermen. Vuelve más tarde.';
  }
}

function _showEmptyState(
  body: HTMLElement,
  type: WonderType,
  reason?: EmptyReason,
): void {
  const sub = _emptySub(type, reason);
  body.innerHTML = `
    <div class="wonder-empty">
      <div class="wonder-empty-icon">🏗️</div>
      <div class="wonder-empty-title">La maravilla está en construcción</div>
      <div class="wonder-empty-sub">${sub}</div>
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
