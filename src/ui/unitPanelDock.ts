// ─── Unit panel dock — parks the floating hero card inside the side panel ───
// While the side panel is open the unit card lives in the "Unidad" tab instead
// of floating free, so selection + chat never produce two windows. The node is
// re-parented (not duplicated) so every id, handler and live update keeps
// working; on close it returns to its original spot in the bottom HUD.

const DOCKED_CLASS = 'unit-panel--docked';
const INLINE_PROPS = ['left', 'top', 'right', 'bottom', 'width', 'height'] as const;
type InlineProp = (typeof INLINE_PROPS)[number];

interface DockAnchor {
  parent: HTMLElement;
  next: ChildNode | null;
  inline: Partial<Record<InlineProp, string>>;
}

let anchor: DockAnchor | null = null;

function els() {
  return {
    side: document.getElementById('side-panel'),
    unit: document.getElementById('unit-panel'),
    body: document.getElementById('unit-pane-body'),
    empty: document.getElementById('unit-pane-empty'),
  };
}

export function dockUnitPanel(
  unit: HTMLElement,
  body: HTMLElement,
  empty?: HTMLElement | null,
): void {
  if (unit.classList.contains(DOCKED_CLASS) || unit.classList.contains('hidden')) return;
  const inline: DockAnchor['inline'] = {};
  anchor = {
    parent: unit.parentElement as HTMLElement,
    next: unit.nextSibling,
    inline,
  };
  for (const prop of INLINE_PROPS) {
    inline[prop] = unit.style[prop];
    unit.style[prop] = '';
  }
  body.appendChild(unit);
  unit.classList.add(DOCKED_CLASS);
  empty?.classList.add('hidden');
}

export function undockUnitPanel(unit: HTMLElement): void {
  if (!unit.classList.contains(DOCKED_CLASS) || !anchor) return;
  unit.classList.remove(DOCKED_CLASS);
  for (const prop of INLINE_PROPS) unit.style[prop] = anchor.inline[prop] ?? '';
  if (anchor.next && anchor.next.parentNode === anchor.parent)
    anchor.parent.insertBefore(unit, anchor.next);
  else anchor.parent.appendChild(unit);
  anchor = null;
}

export function syncUnitPanelDock(): void {
  const { side, unit, body, empty } = els();
  if (!side || !unit || !body) return;
  if (side.classList.contains('hidden')) {
    undockUnitPanel(unit);
    return;
  }
  empty?.classList.toggle('hidden', !unit.classList.contains('hidden'));
  dockUnitPanel(unit, body, empty);
}

export function initUnitPanelDock(): () => void {
  const { side, unit } = els();
  if (!side || !unit) return () => {};
  const observer = new MutationObserver(syncUnitPanelDock);
  for (const el of [side, unit])
    observer.observe(el, { attributes: true, attributeFilter: ['class', 'hidden'] });
  syncUnitPanelDock();
  return () => {
    observer.disconnect();
    undockUnitPanel(unit);
  };
}
