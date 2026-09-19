// ─── RepoCiv — Wonder Vignette (iframe wrapper with health-check) ──────────────
import type { WonderType } from '../types.ts';
import { getLayerState } from '../layers.ts';
import { getWonder } from '../wonders/manifest.ts';
import {
  postContextToWonder,
  postFocusToWonder,
  postLayerToWonder,
  postOpenLocalViewToWonder,
  registerWonderOrigin,
  startWonderListener,
  stopWonderListener,
} from '../wonders/postMessageBridge.ts';
import {
  pollWonderUntilReady,
  resolveMountUrl,
  type WonderLaunchStatus,
} from '../wonders/wonderLauncher.ts';
import type { WonderManifest } from '../wonders/types.ts';
import { renderCapabilityBadge } from '../wonders/wonderBadges.ts';

const STORAGE_POS = (t: WonderType) => `repociv-vignette-pos-${t}`;
const IFRAME_LOAD_TIMEOUT_MS = 25000;

type EmptyReason = 'offline' | 'degraded' | 'timeout' | 'no-permissions';

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
  } catch {
    // noop
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

function _saveState(type: WonderType, s: VignetteState) {
  try {
    localStorage.setItem(STORAGE_POS(type), JSON.stringify(s));
  } catch {
    // noop
  }
}

function _resolveManifest(input: WonderType | WonderManifest): WonderManifest | undefined {
  return typeof input === 'string' ? getWonder(input) : input;
}

function _resolveType(input: WonderType | WonderManifest): WonderType {
  return (typeof input === 'string' ? input : input.id) as WonderType;
}

let _vignette: HTMLElement | null = null;
let _activeType: WonderType | null = null;
let _dragging = false;
let _dragOffset = { x: 0, y: 0 };
let _contextListenerAttached = false;
/** The currently-mounted wonder iframe + its manifest, so city selection keeps
 *  reaching the wonder after the initial load. Null while no iframe is up. */
let _mounted: { iframe: HTMLIFrameElement; manifest: WonderManifest } | null = null;
let _dragMoveHandler: ((e: MouseEvent) => void) | null = null;
let _dragUpHandler: (() => void) | null = null;
let _vignetteRO: ResizeObserver | null = null;

const _runtimeContext: {
  cities: Array<{ id: string; name: string; repoPath?: string }>;
  selectedCityId: string | null;
  selectedRepoPath: string | null;
} = {
  cities: [],
  selectedCityId: null,
  selectedRepoPath: null,
};

function _wonderTitle(manifest: WonderManifest | undefined, type: WonderType): string {
  if (manifest) return manifest.title;
  if (type === 'gaceta') return 'La Gaceta Imperial';
  return type;
}

function _attachWonderListener(): void {
  startWonderListener({
    onReady: (id) => {
      window.dispatchEvent(new CustomEvent('repociv:wonder-ready', { detail: { id } }));
    },
    onFocusCity: (cityId, mode) => {
      window.dispatchEvent(
        new CustomEvent('repociv:wonder-focus-city', { detail: { cityId, mode: mode ?? 'macro' } }),
      );
    },
    onReport: (id, title, markdown, relatedCities) => {
      window.dispatchEvent(
        new CustomEvent('repociv:wonder-report', {
          detail: { id, title, markdown, relatedCities },
        }),
      );
    },
    onNotification: (level, text) => {
      window.dispatchEvent(
        new CustomEvent('repociv:wonder-notification', { detail: { level, text } }),
      );
    },
    onSelection: (nodeId, nodePath, nodeType) => {
      window.dispatchEvent(
        new CustomEvent('repociv:wonder-selection', { detail: { nodeId, nodePath, nodeType } }),
      );
    },
  });
}

function _ensureContextListener(): void {
  if (_contextListenerAttached) return;
  _contextListenerAttached = true;
  window.addEventListener('repociv:wonder-context', (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | {
          cities?: Array<{ id: string; name: string; repoPath?: string }>;
          selectedCityId?: string | null;
          selectedRepoPath?: string | null;
        }
      | undefined;
    _runtimeContext.cities = detail?.cities ?? [];
    _runtimeContext.selectedCityId = detail?.selectedCityId ?? null;
    _runtimeContext.selectedRepoPath = detail?.selectedRepoPath ?? null;
    pushContextToOpenWonder();
  });
}

/** Push the current city context (and focus) into whatever wonder is open.
 *  No-op when nothing is mounted. This is the generic half of the contract:
 *  every connected wonder that declares `repociv.focus` in `events.accepts`
 *  follows the user's city selection, not just one hardcoded product. */
export function pushContextToOpenWonder(mode: 'macro' | 'local' = 'macro'): void {
  if (!_mounted) return;
  const { iframe, manifest } = _mounted;
  postContextToWonder(iframe, manifest, {
    cityId: _runtimeContext.selectedCityId ?? undefined,
    selectedRepo: _runtimeContext.selectedRepoPath ?? undefined,
    theme: document.documentElement.dataset['theme'] ?? 'imperial-dark',
  });
  const cityId = _runtimeContext.selectedCityId;
  if (!cityId) return;
  postFocusToWonder(iframe, manifest, cityId, mode);
  const repoPath = _runtimeContext.selectedRepoPath;
  if (mode === 'local' && repoPath) {
    postOpenLocalViewToWonder(iframe, manifest, repoPath);
  }
}

export async function openWonderVignette(input: WonderType | WonderManifest): Promise<void> {
  if (_vignette) closeWonderVignette();

  const type = _resolveType(input);
  const manifest = _resolveManifest(input);
  _activeType = type;
  _ensureContextListener();

  const container = document.createElement('div');
  container.id = 'wonder-vignette';
  container.className = 'wonder-vignette';
  container.dataset['wonderType'] = type;

  const badgesHtml = manifest ? renderCapabilityBadge(manifest) : '';

  container.innerHTML = `
    <div class="wonder-vignette-header">
      <span class="wonder-title">${_wonderTitle(manifest, type)}</span>
      <div class="wonder-badges">${badgesHtml}</div>
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

  const st = _loadState(type);
  if (st.w && st.h) {
    container.style.width = `${st.w}px`;
    container.style.height = `${st.h}px`;
  } else {
    container.style.width = manifest?.ui?.preferredWidth ?? '70vw';
    container.style.height = manifest?.ui?.preferredHeight ?? '75vh';
  }
  if (st.x || st.y) {
    container.style.left = `${st.x}px`;
    container.style.top = `${st.y}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';
    container.style.transform = 'none';
  }

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
  if (_dragMoveHandler) window.removeEventListener('mousemove', _dragMoveHandler);
  if (_dragUpHandler) window.removeEventListener('mouseup', _dragUpHandler);

  _dragMoveHandler = (e: MouseEvent) => {
    if (!_dragging || !_vignette) return;
    _vignette.style.left = `${e.clientX - _dragOffset.x}px`;
    _vignette.style.top = `${e.clientY - _dragOffset.y}px`;
    _vignette.style.right = 'auto';
    _vignette.style.bottom = 'auto';
    _vignette.style.transform = 'none';
  };
  _dragUpHandler = () => {
    if (!_dragging) return;
    _dragging = false;
    header.style.cursor = 'grab';
    if (_vignette) {
      const r = _vignette.getBoundingClientRect();
      _saveState(_activeType!, { x: r.left, y: r.top, w: r.width, h: r.height });
    }
  };
  window.addEventListener('mousemove', _dragMoveHandler);
  window.addEventListener('mouseup', _dragUpHandler);

  if (_vignetteRO) _vignetteRO.disconnect();
  _vignetteRO = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const r = entry.contentRect;
      const pos = _vignette?.getBoundingClientRect();
      if (pos && _activeType) {
        _saveState(_activeType, { x: pos.left, y: pos.top, w: r.width, h: r.height });
      }
    }
  });
  _vignetteRO.observe(container);

  const body = container.querySelector('.wonder-vignette-body') as HTMLElement;
  body.innerHTML = '<div class="wonder-loading">Verificando estado de la maravilla...</div>';

  if (!manifest) {
    _showEmptyState(body, type, 'offline');
    return;
  }

  if (type === 'gaceta') {
    body.innerHTML = `
      <div class="wonder-empty-state">
        <div class="wonder-empty-emoji">📰</div>
        <div class="wonder-empty-title">La Gaceta vive en el Palacio</div>
        <div class="wonder-empty-sub">Consulta noticias, opcionalidad y funciones activables desde la pestaña Gaceta del capital panel.</div>
      </div>
    `;
    return;
  }

  const iframeUrl = manifest.ui.url ?? '';
  if (!iframeUrl) {
    _showEmptyState(body, type, 'offline');
    return;
  }

  registerWonderOrigin(manifest);
  _attachWonderListener();

  const health = await _checkWonderHealth(manifest);
  if (health === 'timeout' || health === 'offline') {
    // Generic connected wonder is down — try the auto-start (the bridge will
    // launch it if it has a launch spec, or 404 fast if it doesn't, in which
    // case we fall through to the empty state).
    const launched = await _tryAutoStart(body, type);
    if (launched) return;
    _showEmptyState(body, type, health);
    return;
  }
  if (health === 'degraded') {
    _showEmptyState(body, type, 'degraded');
    return;
  }
  if (health === 'no-permissions') {
    _showEmptyState(body, type, 'no-permissions');
    return;
  }

  _mountIframe(body, manifest, type);
}

export function closeWonderVignette(): void {
  stopWonderListener();
  if (_vignetteRO) {
    _vignetteRO.disconnect();
    _vignetteRO = null;
  }
  if (_dragMoveHandler) {
    window.removeEventListener('mousemove', _dragMoveHandler);
    _dragMoveHandler = null;
  }
  if (_dragUpHandler) {
    window.removeEventListener('mouseup', _dragUpHandler);
    _dragUpHandler = null;
  }
  if (_vignette) {
    _vignette.remove();
    _vignette = null;
  }
  _mounted = null;
  _activeType = null;
}

async function _checkWonderHealth(
  manifest: WonderManifest,
): Promise<'ok' | 'offline' | 'degraded' | 'timeout' | 'no-permissions'> {
  if (!manifest.health?.url) return 'ok';
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), manifest.health.timeoutMs ?? 4000);
  try {
    const res = await fetch(manifest.health.url, {
      method: 'GET',
      signal: ctrl.signal,
      mode: 'cors',
    });
    if (res.status === 401 || res.status === 403) return 'no-permissions';
    if (!res.ok) return manifest.health.degradedAllowed ? 'degraded' : 'offline';
    return 'ok';
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'timeout';
    return 'offline';
  } finally {
    clearTimeout(tid);
  }
}

function _mountIframe(body: HTMLElement, manifest: WonderManifest, type: WonderType): void {
  const url = manifest.ui.url ?? '';
  const title = manifest.title;
  const sandbox = manifest.ui.sandbox ?? ['allow-scripts', 'allow-same-origin', 'allow-forms'];
  body.innerHTML = `
    <iframe
      src="${url}"
      sandbox="${sandbox.join(' ')}"
      allow="fullscreen"
      loading="eager"
      title="${title}"
    ></iframe>
  `;
  const iframe = body.querySelector('iframe')!;
  _mounted = { iframe, manifest };
  let settled = false;
  const fail = (reason?: EmptyReason) => {
    if (settled) return;
    settled = true;
    _showEmptyState(body, type, reason);
  };
  const loadTimer = setTimeout(() => fail('timeout'), IFRAME_LOAD_TIMEOUT_MS);
  iframe.addEventListener('load', () => {
    if (settled) return;
    settled = true;
    clearTimeout(loadTimer);
    pushContextToOpenWonder();
    for (const [layer, enabled] of Object.entries(getLayerState().layers)) {
      postLayerToWonder(iframe, manifest, layer, enabled);
    }
  });
  iframe.addEventListener('error', () => fail('offline'));
}

function _tryAutoStart(body: HTMLElement, type: WonderType): Promise<boolean> {
  /** Attempt the F3 auto-start. Returns true if the iframe was mounted,
   * false if the user must fall back to the empty state. The caller
   * handles the false case.
   */
  return _pollUntilReady(body, type);
}

async function _pollUntilReady(body: HTMLElement, type: WonderType): Promise<boolean> {
  // Render an "in-flight" placeholder while we poll. The onUpdate
  // callback refreshes the body with the live launch-status.
  const renderProgress = (status: WonderLaunchStatus | null, terminalError?: string) => {
    const sub = terminalError
      ? `No se pudo levantar la maravilla: ${terminalError}`
      : status
        ? status.error
          ? `Error al levantar: ${status.error_message ?? status.error}`
          : status.status === 'starting'
            ? `Levantando procesos… (API ${status.api_ready ? '✓' : '…'} UI ${status.ui_ready ? '✓' : '…'})`
            : status.status === 'degraded'
              ? `Servidor parcial (API ${status.api_ready ? '✓' : '✗'} UI ${status.ui_ready ? '✓' : '✗'}). Reintentando…`
              : `Estado: ${status.status}`
        : 'Pidiendo al bridge que levante la maravilla…';
    body.innerHTML = `
      <div class="wonder-empty">
        <div class="wonder-empty-icon">⚙️</div>
        <div class="wonder-empty-title">Levantando la maravilla…</div>
        <div class="wonder-empty-sub">${sub}</div>
      </div>
    `;
  };
  renderProgress(null);
  try {
    const status = await pollWonderUntilReady(type, {
      timeoutMs: 45_000,
      intervalMs: 1_500,
      onUpdate: (s) => renderProgress(s),
    });
    if (status.ready && (status.status === 'ready' || status.status === 'already_running')) {
      // Mount the iframe with the URL reported by the launcher (which may be
      // the adopted one) unless ui.url is same-origin — see resolveMountUrl.
      const manifest = getWonder(type);
      if (!manifest) return false;
      const manifestUrl = manifest.ui.url ?? '';
      const mountUrl = resolveMountUrl(manifestUrl, status.ui_url);
      const mountManifest =
        mountUrl === manifestUrl
          ? manifest
          : { ...manifest, ui: { ...manifest.ui, url: mountUrl } };
      _mountIframe(body, mountManifest, type);
      return true;
    }
    // Timeout / error: surface a useful message; caller will empty-state.
    renderProgress(status);
    return false;
  } catch (e) {
    renderProgress(null, (e as Error)?.message ?? String(e));
    return false;
  }
}

function _emptySub(_type: WonderType, reason?: EmptyReason): string {
  switch (reason) {
    case 'degraded':
      return 'La maravilla respondió degradada. RepoCiv no la abre a ciegas para evitar una UI rota.';
    case 'timeout':
      return 'La maravilla tardó demasiado en responder. Puede estar viva, pero no en condiciones sanas.';
    case 'no-permissions':
      return 'La maravilla está arriba, pero sin permisos suficientes. Revisa auth, puertos o sandbox.';
    default:
      return 'Los obreros duermen. Vuelve más tarde.';
  }
}

function _showEmptyState(body: HTMLElement, type: WonderType, reason?: EmptyReason): void {
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
    _vignette.requestFullscreen().catch(() => {
      // noop
    });
  }
}
