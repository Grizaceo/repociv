// ─── RepoCiv — hotkeys ribbon layering (B5) ──────────────────────────────────
// The ribbon is a legend, not chrome: owner decision — it must paint UNDER the
// floating windows ("que quede abajo / bajo el resto"). It lives inside
// #hud-overlay (z-index:100 stacking context), so every body-level panel
// (map editor 2100, settings 9000…) already covers it, and inside the overlay
// it keeps a z-index below the lowest floating panel (unit-panel:10) but
// above the bare canvas.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./components.css', import.meta.url), 'utf8');

/** Index where the element whose open tag is at `start` is closed. */
function closingTagIndex(source: string, start: number): number {
  let depth = 0;
  const tagRe = /<div\b|<\/div>/g;
  tagRe.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(source)) !== null) {
    depth += match[0] === '</div>' ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return -1;
}

describe('hotkeys ribbon stacking', () => {
  it('stays inside #hud-overlay so body-level panels paint over it', () => {
    const overlayStart = html.indexOf('<div id="hud-overlay"');
    const ribbonIndex = html.indexOf('id="hotkeys-ribbon"');
    expect(overlayStart).toBeGreaterThanOrEqual(0);
    expect(ribbonIndex).toBeGreaterThanOrEqual(0);
    const overlayEnd = closingTagIndex(html, overlayStart);
    expect(overlayEnd).toBeGreaterThan(overlayStart);
    expect(ribbonIndex).toBeLessThan(overlayEnd);
  });

  it('keeps a z-index below the lowest floating panel (unit-panel:10)', () => {
    const ruleStart = css.indexOf('#hotkeys-ribbon');
    expect(ruleStart).toBeGreaterThanOrEqual(0);
    const rule = css
      .slice(ruleStart, css.indexOf('}', ruleStart))
      .replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments so prose can't fake a z-index
    const z = /z-index:\s*(\d+)/.exec(rule);
    expect(z, 'ribbon needs an explicit z-index').not.toBeNull();
    expect(Number(z![1])).toBeGreaterThan(0); // above the bare canvas
    expect(Number(z![1])).toBeLessThan(10); // below every floating panel
  });
});
