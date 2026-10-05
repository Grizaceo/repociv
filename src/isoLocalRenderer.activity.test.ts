// ─── Local view: activity pulse actually paints ────────────────────────────
// The pure tests in localActivity.test.ts prove the TTL and the wiring. They
// cannot tell "the tool call arrived" from "the user can see it". This drives
// the real draw function against a stub 2D context and asserts the glyph is
// painted above the unit — and that it is NOT painted once the pulse expires.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drawIsoUnit, type IsoRenderState } from './isoLocalRenderer.ts';
import { activityGlyphFor, ACTIVITY_TTL_MS } from './localActivity.ts';
import type { LocalUnit } from './types.ts';

function makeUnit(overrides: Partial<LocalUnit> = {}): LocalUnit {
  return {
    id: 'MAIN',
    name: 'MAIN',
    unitType: 'hero',
    color: '#4af',
    gridX: 3,
    gridY: 3,
    targetX: null,
    targetY: null,
    path: [],
    pathIndex: 0,
    pathProgress: 0,
    state: 'working_on_file',
    mission: null,
    workProgress: 10,
    macroUnitId: 'MAIN',
    currentWorkbenchId: null,
    fatigue: 100,
    maxFatigue: 100,
    isResting: false,
    effectiveSpeed: 1,
    ...overrides,
  } as LocalUnit;
}

// Same Proxy trick as renderer.test.ts: every 2D-context method becomes a spy,
// every property assignment is allowed. We only care about what was drawn.
// measureText needs a real return value — the name badge measures its label.
function makeCtx() {
  const fillText = vi.fn();
  const target: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'fillText') return fillText;
      if (prop === 'measureText') return (_s: string) => ({ width: 10 });
      return vi.fn();
    },
    set(_t, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fillText, target };
}

function makeState(ctx: CanvasRenderingContext2D): IsoRenderState {
  return {
    ctx,
    cam: { x: 0, y: 0, zoom: 1, cx: 0, cy: 0 },
    world: { repoId: 'repociv', rooms: [], grid: [] } as unknown as IsoRenderState['world'],
    localUnits: [],
    dt: 16,
    lodLow: false,
    view: { x0: 0, y0: 0, x1: 20, y1: 20 },
    tokens: {},
    extColor: {},
    isoStaticLayer: null,
    isoStaticOffsetX: 0,
    isoStaticOffsetY: 0,
    powerOverlay: false,
    temperatureOverlay: false,
    workbenchLabelOverlay: false,
    debugOverlay: false,
    zonePaintMode: null,
    zonePaintStart: null,
    zonePaintCurrent: null,
    hoveredTile: null,
    hoveredUnit: null,
    doorOpenStates: new Map(),
    fpsValue: 60,
    onUnitRendered: null,
    spawnZzz: vi.fn(),
    spawnBreath: vi.fn(),
    darkenHex: (_hex: string) => _hex,
  } as unknown as IsoRenderState;
}

/** Text actually painted by the unit's status icon + activity glyph. */
function drawnText(fillText: ReturnType<typeof vi.fn>): string[] {
  return fillText.mock.calls.map((c) => String(c[0]));
}

describe('drawIsoUnit — activity pulse', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('paints the activity glyph while the pulse is fresh', () => {
    const { ctx, fillText } = makeCtx();
    const glyph = activityGlyphFor('read_file').glyph;
    const unit = makeUnit({ activity: { toolName: 'read_file', at: Date.now() } });

    drawIsoUnit(makeState(ctx), unit, 3, 3);

    expect(drawnText(fillText)).toContain(glyph);
  });

  it('paints the glyph above the status icon', () => {
    // The pulse must not overlap the state icon — the icon says *where* the
    // unit is, the glyph says *what it is doing*.
    const { ctx, fillText } = makeCtx();
    const unit = makeUnit({ activity: { toolName: 'bash', at: Date.now() } });

    drawIsoUnit(makeState(ctx), unit, 3, 3);

    const calls = fillText.mock.calls;
    const glyphCall = calls.find((c) => c[0] === activityGlyphFor('bash').glyph)!;
    const iconCall = calls.find((c) => c[0] === '⚙')!;
    // textBaseline is 'bottom', so a more negative y is higher on screen.
    expect(glyphCall[2]).toBeLessThan(iconCall[2]);
  });

  it('paints no activity glyph for a unit with no activity', () => {
    const { ctx, fillText } = makeCtx();
    drawIsoUnit(makeState(ctx), makeUnit(), 3, 3);
    expect(drawnText(fillText)).not.toContain(activityGlyphFor('read_file').glyph);
  });

  it('stops painting once the pulse has expired', () => {
    // The manager normally clears the field; this guards the renderer too, so
    // a stale pulse can never linger on screen even if a tick is missed.
    const { ctx, fillText } = makeCtx();
    const unit = makeUnit({ activity: { toolName: 'read_file', at: Date.now() } });
    vi.advanceTimersByTime(ACTIVITY_TTL_MS + 10);

    drawIsoUnit(makeState(ctx), unit, 3, 3);

    expect(drawnText(fillText)).not.toContain(activityGlyphFor('read_file').glyph);
  });

  it('fades the glyph as the pulse ages', () => {
    const { ctx, target } = makeCtx();
    const unit = makeUnit({ activity: { toolName: 'read_file', at: Date.now() } });
    drawIsoUnit(makeState(ctx), unit, 3, 3);
    const fresh = target.globalAlpha as number;

    vi.advanceTimersByTime(ACTIVITY_TTL_MS - 50);
    const aged = makeCtx();
    drawIsoUnit(makeState(aged.ctx), unit, 3, 3);
    const late = aged.target.globalAlpha as number;

    expect(late).toBeLessThan(fresh);
    expect(late).toBeGreaterThan(0);
  });

  it('does not dim a despawning unit below the existing fade', () => {
    // Despawn alpha and pulse alpha must compose, not overwrite.
    const { ctx, target } = makeCtx();
    const unit = makeUnit({
      despawning: true,
      fadeAlpha: 0.5,
      activity: { toolName: 'read_file', at: Date.now() },
    });
    drawIsoUnit(makeState(ctx), unit, 3, 3);
    expect(target.globalAlpha as number).toBeLessThan(1);
  });
});
