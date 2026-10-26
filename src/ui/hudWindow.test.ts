import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampHudWindowGeometry,
  hudWindowStorageKey,
  mountHudWindow,
  placeHudWindow,
} from './hudWindow.ts';

describe('hudWindow geometry', () => {
  it('keeps a resized window completely inside the viewport', () => {
    expect(
      clampHudWindowGeometry(
        { left: -120, top: 760, width: 1500, height: 900 },
        { width: 1200, height: 800 },
        { minWidth: 280, minHeight: 220 },
      ),
    ).toEqual({ left: 8, top: 8, width: 1184, height: 784 });
  });

  it('respects the configured minimums while dragging within a roomy viewport', () => {
    expect(
      clampHudWindowGeometry(
        { left: 90, top: 110, width: 100, height: 80 },
        { width: 900, height: 700 },
        { minWidth: 320, minHeight: 240 },
      ),
    ).toEqual({ left: 90, top: 110, width: 320, height: 240 });
  });

  it('names persisted layouts by panel id without colliding with other preferences', () => {
    expect(hudWindowStorageKey('agents-panel')).toBe('repociv:hud-window:v1:agents-panel');
  });

  it('keeps an unoccupied preferred position next to the Gaceta', () => {
    const preferred = { left: 340, top: 50, width: 260, height: 500 };
    expect(
      placeHudWindow(preferred, { width: 1600, height: 900 }, [
        { left: 12, top: 50, width: 320, height: 420 },
      ]),
    ).toEqual(preferred);
  });

  it('finds a hole between occupied windows rather than only trying screen corners', () => {
    expect(
      placeHudWindow({ left: 8, top: 50, width: 240, height: 200 }, { width: 1000, height: 700 }, [
        { left: 8, top: 8, width: 300, height: 684 },
        { left: 600, top: 8, width: 392, height: 684 },
      ]),
    ).toEqual({ left: 316, top: 50, width: 240, height: 200 });
  });

  it('ignores obstacles entirely outside the usable viewport', () => {
    const preferred = { left: 8, top: 50, width: 260, height: 200 };
    expect(
      placeHudWindow(preferred, { width: 1000, height: 700 }, [
        { left: 1100, top: 0, width: 200, height: 200 },
      ]),
    ).toEqual(preferred);
  });

  it('falls back to a reachable clamped window when there is no room', () => {
    expect(
      placeHudWindow({ left: 340, top: 50, width: 260, height: 800 }, { width: 320, height: 480 }, [
        { left: 0, top: 0, width: 320, height: 480 },
      ]),
    ).toEqual({ left: 52, top: 8, width: 260, height: 464 });
  });
});

// ─── Drag wiring (fake DOM) ─────────────────────────────────────────────────
// The docked card lives inside the side panel: its header must not start a
// drag nor persist the slot it occupies there.

class FakeClassList {
  private set = new Set<string>();
  add(...classes: string[]) {
    for (const c of classes) this.set.add(c);
  }
  remove(...classes: string[]) {
    for (const c of classes) this.set.delete(c);
  }
  contains(c: string) {
    return this.set.has(c);
  }
  toggle(c: string, on?: boolean) {
    if (on ?? !this.set.has(c)) this.set.add(c);
    else this.set.delete(c);
  }
}

class FakeElement {
  id = '';
  className = '';
  type = '';
  title = '';
  textContent = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = new FakeClassList();
  rect = { left: 100, top: 100, width: 300, height: 200 };
  header: FakeElement | null = null;
  private listeners: Record<string, Array<(e: FakePointerEvent) => void>> = {};
  private attributes: Record<string, string> = {};

  addEventListener(type: string, fn: (e: FakePointerEvent) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener() {}
  dispatch(type: string, event: FakePointerEvent) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
  before(node: FakeElement) {
    this.children.push(node);
  }
  children: FakeElement[] = [];
  querySelector(selector: string) {
    if (selector.includes('header') || selector.includes('-title') || selector.includes('card'))
      return this.header;
    return null;
  }
  querySelectorAll() {
    return [] as FakeElement[];
  }
  closest() {
    return null;
  }
  contains() {
    return false;
  }
  getBoundingClientRect() {
    return this.rect;
  }
}

class FakePointerEvent {
  button = 0;
  clientX = 100;
  clientY = 100;
  defaultPrevented = false;
  propagationStopped = false;
  constructor(public target: unknown) {}
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
}

let saved: Array<[string, string]> = [];

function installDom() {
  saved = [];
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('document', { createElement: vi.fn(() => new FakeElement()) });
  vi.stubGlobal('window', {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: (key: string, value: string) => {
      saved.push([key, value]);
    },
    removeItem: () => {},
  });
}

function fireWindow(type: string) {
  const calls = (
    window.addEventListener as unknown as {
      mock: { calls: Array<[string, (e: FakePointerEvent) => void]> };
    }
  ).mock.calls;
  for (const [eventType, listener] of calls) {
    if (eventType === type) listener(new FakePointerEvent(null));
  }
}

function mountPanel() {
  const panel = new FakeElement();
  panel.id = 'unit-panel';
  const header = new FakeElement();
  header.className = 'hero-card-main';
  panel.header = header;
  mountHudWindow(panel as unknown as HTMLElement);
  return { panel, header };
}

describe('hudWindow docked windows', () => {
  beforeEach(installDom);
  afterEach(() => vi.unstubAllGlobals());

  it('does not drag or persist a docked window', () => {
    const { panel, header } = mountPanel();
    panel.classList.add('hud-window--docked');

    const mouseDown = new FakePointerEvent(header);
    header.dispatch('mousedown', mouseDown);
    const pointerDown = new FakePointerEvent(header);
    header.dispatch('pointerdown', pointerDown);

    expect(mouseDown.defaultPrevented).toBe(false);
    expect(pointerDown.defaultPrevented).toBe(false);
    expect(panel.classList.contains('hud-window--interacting')).toBe(false);

    fireWindow('mouseup');
    fireWindow('pointerup');
    expect(saved).toHaveLength(0);
  });

  it('still drags and persists a free window', () => {
    const { panel, header } = mountPanel();

    const mouseDown = new FakePointerEvent(header);
    header.dispatch('mousedown', mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(panel.classList.contains('hud-window--interacting')).toBe(true);

    fireWindow('mouseup');
    expect(saved).toEqual([[hudWindowStorageKey('unit-panel'), expect.any(String)]]);
  });
});
