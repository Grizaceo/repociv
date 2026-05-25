// ─── RepoCiv — PostMessage Bridge for Wonder iframes ─────────────────────────
// Two-way communication between RepoCiv and iframe-based Wonders.

import type {
  RepoCivToWonderMessage,
  SuggestionRelation,
  WonderManifest,
  WonderToRepoCivMessage,
} from './types.ts';

const ALLOWED_ORIGINS = new Set<string>();

export function registerWonderOrigin(manifest: WonderManifest): void {
  if (manifest.kind !== 'iframe' || !manifest.ui?.url) return;
  try {
    ALLOWED_ORIGINS.add(new URL(manifest.ui.url).origin);
  } catch {
    // invalid URL — skip silently
  }
}

function _originForManifest(manifest: WonderManifest): string {
  if (!manifest.ui?.url) return '*';
  try {
    return new URL(manifest.ui.url).origin;
  } catch {
    return '*';
  }
}

function _isOriginAllowed(origin: string): boolean {
  if (ALLOWED_ORIGINS.size === 0) {
    try {
      const u = new URL(origin);
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  }
  return ALLOWED_ORIGINS.has(origin);
}

function _isHostMessage(data: unknown): data is RepoCivToWonderMessage {
  if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') {
    return false;
  }
  const t = (data as { type: string }).type;
  return (
    t === 'repociv.context' || t === 'repociv.focus' || t === 'repociv.layer' ||
    t === 'repociv.open_local_view' || t === 'repociv.graph_suggestions'
  );
}

function _isWonderMessage(data: unknown): data is WonderToRepoCivMessage {
  if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') {
    return false;
  }
  const t = (data as { type: string }).type;
  return (
    t === 'wonder.ready' ||
    t === 'wonder.focus_city' ||
    t === 'wonder.report' ||
    t === 'wonder.notification' ||
    t === 'wonder.selection'
  );
}

export function postToWonder(
  iframe: HTMLIFrameElement,
  manifest: WonderManifest,
  msg: RepoCivToWonderMessage,
): void {
  if (!_isHostMessage(msg)) return;
  try {
    iframe.contentWindow?.postMessage(msg, _originForManifest(manifest));
  } catch {
    // iframe not ready or cross-origin — ignore
  }
}

export function postContextToWonder(
  iframe: HTMLIFrameElement,
  manifest: WonderManifest,
  ctx: { cityId?: string; selectedRepo?: string; theme: string },
): void {
  postToWonder(iframe, manifest, { type: 'repociv.context', ...ctx });
}

export function postFocusToWonder(
  iframe: HTMLIFrameElement,
  manifest: WonderManifest,
  cityId: string,
  mode: 'macro' | 'local' = 'macro',
): void {
  postToWonder(iframe, manifest, { type: 'repociv.focus', cityId, mode });
}

export function postLayerToWonder(
  iframe: HTMLIFrameElement,
  manifest: WonderManifest,
  layer: string,
  enabled: boolean,
): void {
  postToWonder(iframe, manifest, { type: 'repociv.layer', layer, enabled });
}

export function postOpenLocalViewToWonder(
  iframe: HTMLIFrameElement,
  manifest: WonderManifest,
  repoPath: string,
): void {
  postToWonder(iframe, manifest, { type: 'repociv.open_local_view', repoPath });
}

export function postGraphSuggestionsToWonder(
  iframe: HTMLIFrameElement,
  manifest: WonderManifest,
  relations: SuggestionRelation[],
  enabled: boolean,
): void {
  postToWonder(iframe, manifest, { type: 'repociv.graph_suggestions', relations, enabled });
}

type WonderMessageHandler = {
  onReady?: (id: string) => void;
  onFocusCity?: (cityId: string, mode?: 'macro' | 'local') => void;
  onReport?: (id: string, title: string, markdown: string, relatedCities: string[]) => void;
  onNotification?: (level: 'info' | 'warn' | 'critical', text: string) => void;
  onSelection?: (nodeId: string, nodePath: string, nodeType: 'repo' | 'file' | 'folder') => void;
};

let _handler: WonderMessageHandler | null = null;
let _listenerAttached = false;

function _handleMessage(event: MessageEvent): void {
  if (!_isOriginAllowed(event.origin)) return;
  if (!_isWonderMessage(event.data)) return;

  switch (event.data.type) {
    case 'wonder.ready': {
      _handler?.onReady?.(event.data.id);
      break;
    }
    case 'wonder.focus_city': {
      if (!event.data.cityId) break;
      _handler?.onFocusCity?.(event.data.cityId, event.data.open);
      break;
    }
    case 'wonder.report': {
      _handler?.onReport?.(
        event.data.id,
        event.data.title,
        event.data.markdown,
        event.data.relatedCities,
      );
      break;
    }
    case 'wonder.notification': {
      _handler?.onNotification?.(event.data.level, event.data.text);
      break;
    }
    case 'wonder.selection': {
      _handler?.onSelection?.(event.data.nodeId, event.data.nodePath, event.data.nodeType);
      break;
    }
  }
}

export function startWonderListener(handler: WonderMessageHandler): void {
  _handler = handler;
  if (!_listenerAttached) {
    window.addEventListener('message', _handleMessage);
    _listenerAttached = true;
  }
}

export function stopWonderListener(): void {
  if (_listenerAttached) {
    window.removeEventListener('message', _handleMessage);
    _listenerAttached = false;
  }
  _handler = null;
}
