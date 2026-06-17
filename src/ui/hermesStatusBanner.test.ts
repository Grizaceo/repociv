// ─── Tests for the Hermes degraded-mode banner (Fase 1 / audit 1.1) ──────────
// Pure-function tests for the HTML builder. Per the codebase
// convention (see src/ui/chat/pickerLogic.test.ts), UI tests run in
// the node vitest env — no DOM, no localStorage. The DOM mount
// itself is trivial enough to be covered by the manual smoke test
// and the existing e2e suite.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildHermesBannerHtml,
  isHermesBannerDismissed,
  setHermesBannerDismissed,
} from './hermesStatusBanner.ts';
import { type HermesStatus } from '../hermesStatus.ts';

const DOWN: HermesStatus = {
  available: false,
  url: 'http://localhost:8642',
  latencyMs: 18,
  error: 'network: connection refused',
  modelCount: null,
  checkedAt: 1700000000,
};

const UP: HermesStatus = {
  available: true,
  url: 'http://localhost:8642',
  latencyMs: 24,
  error: null,
  modelCount: 5,
  checkedAt: 1700000000,
};

const sessionStore = new Map<string, string>();

beforeEach(() => {
  sessionStore.clear();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => sessionStore.get(k) ?? null,
    setItem: (k: string, v: string) => sessionStore.set(k, v),
    removeItem: (k: string) => sessionStore.delete(k),
    clear: () => sessionStore.clear(),
  });
});

afterEach(() => {
  setHermesBannerDismissed(false);
  vi.unstubAllGlobals();
});


// ─── buildHermesBannerHtml ────────────────────────────────────────────────


describe('buildHermesBannerHtml', () => {
  it('returns null when Hermes is up', () => {
    expect(buildHermesBannerHtml(UP)).toBeNull();
  });

  it('renders the banner when Hermes is down', () => {
    const html = buildHermesBannerHtml(DOWN);
    expect(html).not.toBeNull();
    expect(html).toContain('Hermes no detectado');
    expect(html).toContain('modo degradado');
  });

  it('includes the error message from the probe', () => {
    expect(buildHermesBannerHtml(DOWN)).toContain('network: connection refused');
  });

  it('includes the probed URL', () => {
    expect(buildHermesBannerHtml(DOWN)).toContain('http://localhost:8642');
  });

  it('includes the activation steps in a <details> block', () => {
    const html = buildHermesBannerHtml(DOWN)!;
    expect(html).toContain('<details>');
    expect(html).toContain('Cómo activar Hermes');
  });

  it('escapes HTML in the error / URL to prevent injection', () => {
    const evil: HermesStatus = {
      ...DOWN,
      url: 'http://evil/<script>alert(1)</script>',
      error: 'oops <img onerror=alert(1) src=x>',
    };
    const html = buildHermesBannerHtml(evil)!;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
  });

  it('hides error/url blocks when probe did not populate them', () => {
    const minimal: HermesStatus = { ...DOWN, url: '', error: null };
    const html = buildHermesBannerHtml(minimal)!;
    expect(html).not.toContain('URL probada:');
    expect(html).not.toContain('Error del probe:');
  });

  it('returns null when dismissed (per-session)', () => {
    setHermesBannerDismissed(true);
    expect(isHermesBannerDismissed()).toBe(true);
    expect(buildHermesBannerHtml(DOWN)).toBeNull();
  });
});
