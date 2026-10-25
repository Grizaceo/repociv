import { describe, expect, it } from 'vitest';
import { dockUnitPanel, undockUnitPanel } from './unitPanelDock.ts';

// Minimal Element fake: enough DOM for re-parent + classList + inline style.
interface FakeEl {
  children: FakeEl[];
  style: Record<string, string>;
  classList: {
    add(c: string): void;
    remove(c: string): void;
    contains(c: string): boolean;
    toggle(c: string, on?: boolean): void;
  };
  _parent: FakeEl | null;
  readonly parentElement: FakeEl | null;
  readonly parentNode: FakeEl | null;
  readonly nextSibling: FakeEl | null;
  appendChild(child: FakeEl): FakeEl;
  insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
}

function fakeEl(classes: string[] = []): FakeEl {
  const cls = new Set(classes);
  const el: FakeEl = {
    children: [],
    style: {},
    classList: {
      add: (c) => void cls.add(c),
      remove: (c) => void cls.delete(c),
      contains: (c) => cls.has(c),
      toggle: (c, on?) => {
        if (on ?? !cls.has(c)) cls.add(c);
        else cls.delete(c);
      },
    },
    _parent: null,
    get parentElement() {
      return el._parent;
    },
    get parentNode() {
      return el._parent;
    },
    get nextSibling() {
      const p = el._parent;
      if (!p) return null;
      return p.children[p.children.indexOf(el) + 1] ?? null;
    },
    appendChild(child) {
      child._parent?.children.splice(child._parent.children.indexOf(child), 1);
      child._parent = el;
      el.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child._parent?.children.splice(child._parent.children.indexOf(child), 1);
      child._parent = el;
      el.children.splice(ref ? el.children.indexOf(ref) : el.children.length, 0, child);
      return child;
    },
  };
  return el;
}
const asEl = (el: FakeEl) => el as unknown as HTMLElement;

describe('unitPanelDock', () => {
  it('re-parents the card into the pane and restores it on undock', () => {
    const hud = fakeEl();
    const sibling = fakeEl();
    const unit = fakeEl();
    hud.appendChild(unit);
    hud.appendChild(sibling);
    const pane = fakeEl();

    unit.style['left'] = '340px';
    dockUnitPanel(asEl(unit), asEl(pane));

    expect(unit.parentElement).toBe(pane);
    expect(unit.classList.contains('unit-panel--docked')).toBe(true);
    expect(unit.style['left']).toBe('');

    undockUnitPanel(asEl(unit));

    expect(unit.parentElement).toBe(hud);
    expect(unit.nextSibling).toBe(sibling);
    expect(unit.classList.contains('unit-panel--docked')).toBe(false);
    expect(unit.style['left']).toBe('340px');
  });

  it('hides the placeholder while docked and is a no-op on a hidden card', () => {
    const pane = fakeEl();
    const empty = fakeEl();
    const hidden = fakeEl(['hidden']);
    const visible = fakeEl();

    dockUnitPanel(asEl(hidden), asEl(pane), asEl(empty));
    expect(hidden.parentElement).toBeNull();
    expect(empty.classList.contains('hidden')).toBe(false);

    dockUnitPanel(asEl(visible), asEl(pane), asEl(empty));
    expect(visible.parentElement).toBe(pane);
    expect(empty.classList.contains('hidden')).toBe(true);
  });
});
