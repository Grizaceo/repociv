// ─── RepoCiv — Nations panel ────────────────────────────────────────────────
//
// The panel is built with DOM APIs, so these tests use a small fake DOM: the
// pane's `innerHTML` is a no-op and `querySelector('#id')` returns the stable
// element for that id (the markup's containers).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initNationsPanel, renderNationsPanel } from './nationsPanel.ts';
import { createNation, resetNationStoreCache } from '../nations.ts';
import type { City, World } from '../types.ts';

class FakeElement {
  className = '';
  id = '';
  type = '';
  value = '';
  title = '';
  textContent = '';
  innerHTML = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  readonly byId: Map<string, FakeElement>;
  private listeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(byId: Map<string, FakeElement> = new Map()) {
    this.byId = byId;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.children.push(node);
  }
  setAttribute(): void {}
  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  dispatch(type: string): void {
    for (const fn of this.listeners[type] ?? []) fn({ type, target: this });
  }
  listenerCount(type: string): number {
    return (this.listeners[type] ?? []).length;
  }
  querySelector(selector: string): FakeElement | null {
    return selector.startsWith('#') ? (this.byId.get(selector) ?? null) : null;
  }
}

class FakeOption extends FakeElement {
  constructor(text?: string, value?: string) {
    super();
    this.textContent = text ?? '';
    this.value = value ?? '';
  }
}

function installDom() {
  const list = new FakeElement();
  const citiesTitle = new FakeElement();
  const cities = new FakeElement();
  const footer = new FakeElement();
  const pane = new FakeElement(
    new Map<string, FakeElement>([
      ['#nations-list', list],
      ['#nations-cities-title', citiesTitle],
      ['#nations-cities', cities],
      ['#nations-footer', footer],
    ]),
  );
  const tab = new FakeElement();
  const storage: Record<string, string> = {};

  vi.stubGlobal('document', {
    getElementById: vi.fn((id: string) => (id === 'nations-pane' ? pane : null)),
    createElement: vi.fn(() => new FakeElement()),
    querySelector: vi.fn((selector: string) =>
      selector === '.side-tab[data-tab="nations"]' ? tab : null,
    ),
  });
  vi.stubGlobal('Option', FakeOption);
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
    },
  });

  return { pane, list, cities, footer, tab };
}

function makeCity(id: string, repoPath: string): City {
  return {
    id,
    name: id,
    coord: { q: 0, r: 0 },
    repoPath,
    population: 5,
    territory: [],
    districts: [],
    buildings: [],
    isCapital: false,
    color: [0.3, 0.3, 0.3],
  };
}

function makeWorld(cities: City[]): World {
  return { cities, units: [], buildings: [], tiles: new Map() } as unknown as World;
}

beforeEach(() => {
  resetNationStoreCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetNationStoreCache();
});

describe('nations panel', () => {
  it('renders once on init and does not add its own tab listener', () => {
    const dom = installDom();
    const world = makeWorld([makeCity('repo-a', '/w/repo-a')]);

    initNationsPanel(world, () => {});

    // wireSideTabs already re-renders on tab click; a second listener drew the
    // panel twice per click.
    expect(dom.tab.listenerCount('click')).toBe(0);
    expect(dom.cities.children).toHaveLength(world.cities.length);
  });

  it('notifies onChange when a city changes nation', () => {
    const dom = installDom();
    const nation = createNation('Imperio');
    const city = makeCity('repo-a', '/w/repo-a');
    const world = makeWorld([city]);
    const onChange = vi.fn();

    renderNationsPanel(world, onChange);

    const row = dom.cities.children[0]!;
    const select = row.children[1]!; // [name label, nation select]
    select.value = nation.id;
    select.dispatch('change');

    expect(onChange).toHaveBeenCalled();
    expect(city.nationId).toBe(nation.id);
  });
});
