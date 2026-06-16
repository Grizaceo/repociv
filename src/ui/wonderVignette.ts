// ─── RepoCiv — Wonder Vignette (iframe wrapper with health-check) ──────────────
import type { WonderType } from '../types.ts';
import {
  checkInstitutumReachability,
  checkLgbReachability,
  findReachableInstitutumUiUrl,
  findReachableLgbUiUrl,
  LGB_BACKEND_URL,
  WONDER_BIBLIOTHECA_URL,
  WONDER_INSTITUTUM_URL,
} from '../wonderEnv.ts';
import { getLayerState } from '../layers.ts';
import { getWonder } from '../wonders/manifest.ts';
import {
  postContextToWonder,
  postGraphSuggestionsToWonder,
  postLayerToWonder,
  registerWonderOrigin,
  startWonderListener,
  stopWonderListener,
} from '../wonders/postMessageBridge.ts';
import {
  pollWonderUntilReady,
  type WonderLaunchStatus,
} from '../wonders/wonderLauncher.ts';
import type { WonderManifest } from '../wonders/types.ts';
import { renderCapabilityBadge } from '../wonders/wonderBadges.ts';
import {
  renderRelationsPanel,
  renderRelationsPanelLoading,
  renderRelationsPanelError,
} from './relationsPanel.ts';
import { loadWonderConfig, isFeatureEnabled } from '../wonders/wonderConfig.ts';
import { fetchGraphRelations, syncGraphRelationFlags } from '../bridge.ts';
import { rankRelationsWithFeedback, relationFeedbackKey } from '../wonders/bibliothecaBridge.ts';

const STORAGE_POS = (t: WonderType) => `repociv-vignette-pos-${t}`;
const IFRAME_LOAD_TIMEOUT_MS = 25000;

type EmptyReason =
  | 'lgb-offline'
  | 'lgb-backend-offline'
  | 'lgb-ui-offline'
  | 'institutum-offline'
  | 'institutum-backend-offline'
  | 'institutum-ui-offline'
  | 'load-timeout'
  | 'offline'
  | 'degraded'
  | 'timeout'
  | 'no-permissions';

/** Wonders that need separate UI/API reachability probes (vs single health endpoint). */
const SPLIT_WONDERS = new Set<WonderType>(['bibliotheca', 'institutum']);

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
let _bibliothecaRelationsContainer: HTMLElement | null = null;
let _bibliothecaIframe: HTMLIFrameElement | null = null;
let _bibliothecaManifest: WonderManifest | null = null;
let _contextListenerAttached = false;
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
  return type === 'bibliotheca' ? 'Bibliotheca Alexandrina' : 'Institutum Scientiarum';
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

    if (_bibliothecaIframe && _bibliothecaManifest) {
      postContextToWonder(_bibliothecaIframe, _bibliothecaManifest, {
        cityId: _runtimeContext.selectedCityId ?? undefined,
        selectedRepo: _runtimeContext.selectedRepoPath ?? undefined,
        theme: document.documentElement.dataset['theme'] ?? 'imperial-dark',
      });
    }
    if (_activeType === 'bibliotheca' && _bibliothecaRelationsContainer) {
      void _reloadBibliothecaRelations();
    }
  });
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

  if (SPLIT_WONDERS.has(type)) {
    const { backend, ui } =
      type === 'bibliotheca'
        ? await checkLgbReachability()
        : await checkInstitutumReachability();

    // Both down → try the auto-start (F3). If the user has the wonder
    // repo present and we have a launchable spec, the bridge will
    // either adopt the running instance or spawn the procs.
    if (!ui && !backend) {
      const launched = await _tryAutoStart(body, type);
      if (launched) return;
      const reason: EmptyReason =
        type === 'bibliotheca' ? 'lgb-offline' : 'institutum-offline';
      _showEmptyState(body, type, reason);
      return;
    }
    if (!backend) {
      const launched = await _tryAutoStart(body, type, { allowAdopt: true });
      if (launched) return;
      const reason: EmptyReason =
        type === 'bibliotheca' ? 'lgb-backend-offline' : 'institutum-backend-offline';
      _showEmptyState(body, type, reason);
      return;
    }
    if (!ui) {
      // Backend up but UI not — try auto-start (the bridge can adopt
      // an externally-running LabHub via F2's lockfile parse).
      const launched = await _tryAutoStart(body, type, { allowAdopt: true });
      if (launched) return;
      const reason: EmptyReason =
        type === 'bibliotheca' ? 'lgb-ui-offline' : 'institutum-ui-offline';
      _showEmptyState(body, type, reason);
      return;
    }
    const resolvedUiUrl =
      type === 'bibliotheca'
        ? await findReachableLgbUiUrl()
        : await findReachableInstitutumUiUrl();
    const primaryUi =
      type === 'bibliotheca'
        ? (WONDER_BIBLIOTHECA_URL as string)
        : (WONDER_INSTITUTUM_URL as string);
    const mountManifest =
      resolvedUiUrl && resolvedUiUrl !== primaryUi.replace(/\/$/, '')
        ? {
            ...manifest,
            ui: {
              ...manifest.ui,
              url: resolvedUiUrl,
            },
          }
        : manifest;
    _mountIframe(body, mountManifest, type);
    return;
  }

  const health = await _checkWonderHealth(manifest);
  if (health === 'timeout') {
    _showEmptyState(body, type, 'timeout');
    return;
  }
  if (health === 'offline') {
    _showEmptyState(body, type, 'offline');
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
  _bibliothecaRelationsContainer = null;
  _bibliothecaIframe = null;
  _bibliothecaManifest = null;
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
  if (type === 'bibliotheca') {
    _bibliothecaIframe = iframe;
    _bibliothecaManifest = manifest;
  }
  let settled = false;
  const fail = (reason?: EmptyReason) => {
    if (settled) return;
    settled = true;
    _showEmptyState(body, type, reason);
  };
  const loadTimer = setTimeout(
    () => fail(type === 'bibliotheca' ? 'load-timeout' : 'timeout'),
    IFRAME_LOAD_TIMEOUT_MS,
  );
  iframe.addEventListener('load', () => {
    if (settled) return;
    settled = true;
    clearTimeout(loadTimer);
    postContextToWonder(iframe, manifest, {
      cityId: _runtimeContext.selectedCityId ?? undefined,
      selectedRepo: _runtimeContext.selectedRepoPath ?? undefined,
      theme: document.documentElement.dataset['theme'] ?? 'imperial-dark',
    });
    for (const [layer, enabled] of Object.entries(getLayerState().layers)) {
      postLayerToWonder(iframe, manifest, layer, enabled);
    }

    // Mount relations panel for Bibliotheca only when graphSuggestions was explicitly enabled.
    if (type === 'bibliotheca') {
      const config = loadWonderConfig();
      const gsEnabled = isFeatureEnabled(config, 'bibliotheca', 'graphSuggestions');
      postGraphSuggestionsToWonder(iframe, manifest, [], gsEnabled);
      if (gsEnabled) {
        _mountBibliothecaRelations(body);
      }
    }
  });
  iframe.addEventListener('error', () => fail('offline'));
}

// ─── Feedback persistence ─────────────────────────────────────────────────────
const RELATION_FEEDBACK_KEY = 'repociv_relation_feedback';

function _loadRelationFeedback(): Record<string, { accepted: boolean; rejected: boolean }> {
  try {
    const raw = localStorage.getItem(RELATION_FEEDBACK_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function _saveRelationFeedback(key: string, state: { accepted: boolean; rejected: boolean }): void {
  try {
    const stored = _loadRelationFeedback();
    stored[key] = state;
    localStorage.setItem(RELATION_FEEDBACK_KEY, JSON.stringify(stored));
  } catch {
    // localStorage full — silent
  }
}

// ─── Bibliotheca Relations Panel ──────────────────────────────────────────────

function _mountBibliothecaRelations(body: HTMLElement): void {
  const container = document.createElement('div');
  container.id = 'bibliotheca-relations';
  container.style.cssText = 'border-top: 1px solid rgba(200, 168, 75, 0.2); margin-top: 4px;';
  body.appendChild(container);
  _bibliothecaRelationsContainer = container;
  void _reloadBibliothecaRelations();
}

async function _reloadBibliothecaRelations(): Promise<void> {
  const container = _bibliothecaRelationsContainer;
  if (!container) return;

  const config = loadWonderConfig();
  const gsEnabled = isFeatureEnabled(config, 'bibliotheca', 'graphSuggestions');
  const aiEnabled = gsEnabled && isFeatureEnabled(config, 'bibliotheca', 'aiRelationDiscovery');
  void syncGraphRelationFlags({ graphSuggestions: gsEnabled, aiRelationDiscovery: aiEnabled });
  if (!gsEnabled) {
    container.remove();
    _bibliothecaRelationsContainer = null;
    if (_bibliothecaIframe && _bibliothecaManifest) {
      postGraphSuggestionsToWonder(_bibliothecaIframe, _bibliothecaManifest, [], false);
    }
    return;
  }

  const cities = _runtimeContext.cities;
  if (cities.length === 0) {
    renderRelationsPanelError(
      container,
      'Bibliotheca no tiene ciudades cargadas desde RepoCiv todavía',
    );
    return;
  }

  const targetCity = _runtimeContext.selectedCityId ?? cities[0]?.id;
  if (!targetCity) {
    renderRelationsPanelError(container, 'Selecciona una ciudad en RepoCiv para ver relaciones');
    return;
  }

  renderRelationsPanelLoading(container);

  try {
    const relations = rankRelationsWithFeedback(
      await fetchGraphRelations(targetCity, cities, 15),
      _loadRelationFeedback(),
    );

    if (_bibliothecaIframe && _bibliothecaManifest) {
      postGraphSuggestionsToWonder(_bibliothecaIframe, _bibliothecaManifest, relations, true);
    }

    renderRelationsPanel(relations, container, {
      onAccept: (rel) => {
        _saveRelationFeedback(relationFeedbackKey(rel.fromId, rel.toId), {
          accepted: true,
          rejected: false,
        });
        void _reloadBibliothecaRelations();
      },
      onReject: (rel) => {
        _saveRelationFeedback(relationFeedbackKey(rel.fromId, rel.toId), {
          accepted: false,
          rejected: true,
        });
        void _reloadBibliothecaRelations();
      },
      onGoToCity: (rel) => {
        window.dispatchEvent(
          new CustomEvent('repociv:focus-city-request', {
            detail: { cityId: rel.toId, repoPath: rel.toRepoPath, source: 'relations-panel' },
          }),
        );
      },
      onOpenBoth: (rel) => {
        window.dispatchEvent(
          new CustomEvent('repociv:open-local-view-request', {
            detail: { cityId: rel.toId, repoPath: rel.toRepoPath, source: 'relations-panel' },
          }),
        );
      },
    });
  } catch {
    renderRelationsPanelError(container, 'No se pudieron cargar las relaciones locales');
  }
}

function _tryAutoStart(
  body: HTMLElement,
  type: WonderType,
  opts: { allowAdopt?: boolean } = {},
): Promise<boolean> {
  /** Attempt the F3 auto-start. Returns true if the iframe was mounted,
   * false if the user must fall back to the empty state. The caller
   * handles the false case.
   */
  return _pollUntilReady(body, type, opts.allowAdopt ?? false);
}

async function _pollUntilReady(
  body: HTMLElement,
  type: WonderType,
  _allowAdopt: boolean,
): Promise<boolean> {
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
      timeoutMs: 30_000,
      intervalMs: 1_500,
      onUpdate: (s) => renderProgress(s),
    });
    if (status.ready && (status.status === 'ready' || status.status === 'already_running')) {
      // Mount the iframe with the URL reported by the launcher (which
      // may be the adopted one, not the primary UI URL).
      const manifest = getWonder(type);
      if (!manifest) return false;
      const mountManifest =
        status.ui_url && status.ui_url !== (manifest.ui.url ?? '').replace(/\/$/, '')
          ? { ...manifest, ui: { ...manifest.ui, url: status.ui_url } }
          : manifest;
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

function _emptySub(type: WonderType, reason?: EmptyReason): string {
  if (type === 'bibliotheca') {
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
          `La UI vive, pero el backend no responde en <code>${api}/api/health</code>. ` +
          `Levanta <code>python -m backend.library_bridge</code> o corrige el proxy.`
        );
      case 'lgb-ui-offline':
        return `El backend responde, pero la UI no en <code>${ui}</code>. Ejecuta <code>cd frontend && npm run dev</code> en la-gran-biblioteca.`;
      case 'load-timeout':
        return `La UI en <code>${ui}</code> no cargó a tiempo. Comprueba que Vite esté arriba y abre esa URL en una pestaña.`;
      case 'no-permissions':
        return 'La maravilla respondió, pero negó permisos. Revisa headers, auth local o sandbox.';
      default:
        return 'La Biblioteca no respondió como debía. Revisa UI, backend o proxy local.';
    }
  }

  if (type === 'institutum') {
    const ui = WONDER_INSTITUTUM_URL;
    switch (reason) {
      case 'institutum-offline':
        return (
          `Levanta LabHub en otra terminal:<br>` +
          `<code>cd ~/.hermes/workspace/repos/labhub && npm start</code> ` +
          `(API :5281, UI :5280)<br>` +
          `Si el repo no está, clónalo o ajusta <code>REPOCIV_WONDER_INSTITUTUM_DIR</code> en .env.`
        );
      case 'institutum-backend-offline':
        return (
          `La UI Vite de LabHub está caída, pero la API :5281 tampoco responde. ` +
          `Re-arranca con <code>npm start</code> en labhub/ y revisa <code>~/.labhub/logs/</code>.`
        );
      case 'institutum-ui-offline':
        return `La API responde, pero la UI Vite no en <code>${ui}</code>. Comprueba que <code>npm start</code> en labhub/ completó sin errores.`;
      case 'load-timeout':
        return `La UI en <code>${ui}</code> no cargó a tiempo. ¿Está Vite enlazado en :5280? Abre esa URL en una pestaña para depurar.`;
      case 'no-permissions':
        return 'LabHub respondió, pero negó permisos. Revisa headers o el sandbox del iframe.';
      default:
        return 'LabHub no respondió como debía. Revisa UI :5280 o API :5281.';
    }
  }

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
