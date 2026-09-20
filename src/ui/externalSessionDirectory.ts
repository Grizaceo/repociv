// ─── External-session directory ──────────────────────────────────────────────
// F8 and the HUD consume this one cache/poll. Keeping it outside either view
// avoids two fetch loops with two slightly different ideas of "active".

import { fetchExternalSessions, type ExternalSessionRow } from '../externalAgents.ts';

const POLL_MS = 10_000;

type Listener = (rows: ExternalSessionRow[] | null) => void;

let _rows: ExternalSessionRow[] | null = null;
let _refreshing: Promise<ExternalSessionRow[] | null> | null = null;
let _timer = 0;
const _listeners = new Set<Listener>();

export function externalSessionSnapshot(): ExternalSessionRow[] | null {
  return _rows;
}

function _notify(): void {
  for (const listener of _listeners) listener(_rows);
}

/** Refresh once, retaining the null sentinel when the bridge is unavailable. */
export function refreshExternalSessionDirectory(): Promise<ExternalSessionRow[] | null> {
  if (_refreshing) return _refreshing;
  _refreshing = fetchExternalSessions()
    .then((rows) => {
      _rows = rows;
      _notify();
      return _rows;
    })
    .finally(() => {
      _refreshing = null;
    });
  return _refreshing;
}

function _startPolling(): void {
  if (_timer || _listeners.size === 0) return;
  void refreshExternalSessionDirectory();
  _timer = window.setInterval(() => void refreshExternalSessionDirectory(), POLL_MS);
}

function _stopPollingWhenUnused(): void {
  if (_listeners.size !== 0 || !_timer) return;
  window.clearInterval(_timer);
  _timer = 0;
}

/** Subscribe to the canonical external-session snapshot. */
export function subscribeExternalSessionDirectory(listener: Listener): () => void {
  _listeners.add(listener);
  listener(_rows);
  _startPolling();
  return () => {
    _listeners.delete(listener);
    _stopPollingWhenUnused();
  };
}

/** Test-only reset for isolated timer/cache tests. */
export function resetExternalSessionDirectoryForTesting(): void {
  if (_timer) window.clearInterval(_timer);
  _timer = 0;
  _refreshing = null;
  _rows = null;
  _listeners.clear();
}
