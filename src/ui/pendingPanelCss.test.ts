// ─── RepoCiv — pending panel chrome CSS (B1) ─────────────────────────────────
// pendingPanel.ts renders #pending-panel with .pending-header/.pending-title/
// .pending-body, but the panel-level stylesheet lost those selectors when
// panels.css was split — the panel ended up unstyled (no fixed position, no
// header layout). Guard the selectors against another silent removal.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(
  new URL('../styles/panels/pending-panel.css', import.meta.url),
  'utf8',
);

const REQUIRED = [
  '#pending-panel',
  '#pending-panel.hidden',
  '.pending-header',
  '.pending-title',
  '.pending-header button',
  '.pending-body',
  '.pending-offline',
  '.pending-empty',
];

describe('pending-panel.css chrome selectors', () => {
  it.each(REQUIRED)('declares %s', (selector) => {
    expect(css).toContain(selector);
  });

  it('positions the panel at the viewport edge', () => {
    const block = css.slice(css.indexOf('#pending-panel'));
    expect(block).toContain('position:');
    expect(block).toContain('top:');
    expect(block).toContain('right:');
  });
});
