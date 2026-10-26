// ─── RepoCiv — movable and resizable HUD windows ────────────────────────────
// Window layout is local-only UI preference. The gameplay / bridge state is never
// affected by a panel's position or dimensions.

export interface HudWindowGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface HudWindowBounds {
  width: number;
  height: number;
}

export interface HudWindowMinimum {
  minWidth: number;
  minHeight: number;
}

const STORAGE_PREFIX = 'repociv:hud-window:v1:';
/**
 * Opt-out marker for windows that live inside another panel. A docked window is
 * positioned by its host (e.g. the unit card inside the side panel), so its
 * header must not start a drag nor persist that slot as the floating position.
 */
export const HUD_WINDOW_DOCKED_CLASS = 'hud-window--docked';
const VIEWPORT_GAP = 8;
const DEFAULT_MINIMUM: HudWindowMinimum = { minWidth: 240, minHeight: 180 };
const HUD_WINDOW_IDS = [
  'unit-panel',
  'side-panel',
  'city-panel',
  'agents-panel',
  'capital-panel',
  'settings-panel',
  'priority-panel',
  'subagent-session-panel',
  'task-panel',
  'task-assign-panel',
  'approval-panel',
  'kanban-panel',
  'recovery-panel',
  'log-panel',
  'harness-panel',
  'pending-panel',
  'roundtablet-panel',
] as const;
const HUD_WINDOW_SELECTOR = HUD_WINDOW_IDS.map((id) => `#${id}`).join(', ');

interface HudWindowBinding {
  header: HTMLElement | null;
  resetControl: HTMLButtonElement | null;
  resizeHandle: HTMLButtonElement | null;
  visible: boolean;
}

const bindings = new WeakMap<HTMLElement, HudWindowBinding>();

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Normalizes a window layout to both its intended minimum dimensions and the
 * currently usable screen. Kept pure so viewport edge cases stay testable.
 */
export function clampHudWindowGeometry(
  geometry: HudWindowGeometry,
  viewport: HudWindowBounds,
  minimum: HudWindowMinimum = DEFAULT_MINIMUM,
): HudWindowGeometry {
  const maxWidth = Math.max(1, viewport.width - VIEWPORT_GAP * 2);
  const maxHeight = Math.max(1, viewport.height - VIEWPORT_GAP * 2);
  const width = clamp(Math.round(geometry.width), Math.min(minimum.minWidth, maxWidth), maxWidth);
  const height = clamp(
    Math.round(geometry.height),
    Math.min(minimum.minHeight, maxHeight),
    maxHeight,
  );
  const left = clamp(
    Math.round(geometry.left),
    VIEWPORT_GAP,
    Math.max(VIEWPORT_GAP, viewport.width - width - VIEWPORT_GAP),
  );
  const top = clamp(
    Math.round(geometry.top),
    VIEWPORT_GAP,
    Math.max(VIEWPORT_GAP, viewport.height - height - VIEWPORT_GAP),
  );

  return { left, top, width, height };
}

export const hudWindowStorageKey = (panelId: string): string => `${STORAGE_PREFIX}${panelId}`;

/** Edge candidates cover every free rectangle for a window of this size.
 * Prefer the requested position, then the nearest collision-free position.
 * If no such position exists, keep the clamped window reachable instead.
 */
export function placeHudWindow(
  preferred: HudWindowGeometry,
  viewport: HudWindowBounds,
  obstacles: readonly HudWindowGeometry[],
  minimum: HudWindowMinimum = DEFAULT_MINIMUM,
): HudWindowGeometry {
  const base = clampHudWindowGeometry(preferred, viewport, minimum);
  const xs = [base.left, VIEWPORT_GAP, viewport.width - base.width - VIEWPORT_GAP];
  const ys = [base.top, VIEWPORT_GAP, viewport.height - base.height - VIEWPORT_GAP];
  for (const rect of obstacles) {
    xs.push(rect.left + rect.width + VIEWPORT_GAP, rect.left - base.width - VIEWPORT_GAP);
    ys.push(rect.top + rect.height + VIEWPORT_GAP, rect.top - base.height - VIEWPORT_GAP);
  }
  const candidates: HudWindowGeometry[] = [];
  for (const left of new Set(xs)) {
    for (const top of new Set(ys)) {
      const candidate = clampHudWindowGeometry({ ...base, left, top }, viewport, minimum);
      if (
        obstacles.some(
          (rect) =>
            candidate.left < rect.left + rect.width + VIEWPORT_GAP &&
            candidate.left + candidate.width + VIEWPORT_GAP > rect.left &&
            candidate.top < rect.top + rect.height + VIEWPORT_GAP &&
            candidate.top + candidate.height + VIEWPORT_GAP > rect.top,
        )
      )
        continue;
      candidates.push(candidate);
    }
  }
  candidates.sort(
    (a, b) =>
      Math.hypot(a.left - base.left, a.top - base.top) -
      Math.hypot(b.left - base.left, b.top - base.top),
  );
  return candidates[0] ?? base;
}

const viewportBounds = (): HudWindowBounds => ({
  width: window.innerWidth,
  height: window.innerHeight,
});

const minimumFor = (panel: HTMLElement): HudWindowMinimum => {
  if (panel.id === 'task-assign-panel') return { minWidth: 220, minHeight: 180 };
  return DEFAULT_MINIMUM;
};

const readLayout = (panelId: string): HudWindowGeometry | null => {
  try {
    const raw = localStorage.getItem(hudWindowStorageKey(panelId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HudWindowGeometry>;
    const values = [parsed.left, parsed.top, parsed.width, parsed.height];
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
    return parsed as HudWindowGeometry;
  } catch {
    return null;
  }
};

const saveLayout = (panel: HTMLElement, geometry: HudWindowGeometry): void => {
  try {
    localStorage.setItem(hudWindowStorageKey(panel.id), JSON.stringify(geometry));
  } catch {
    // A blocked or full localStorage must never prevent HUD interaction.
  }
};

const applyLayout = (panel: HTMLElement, geometry: HudWindowGeometry): void => {
  panel.classList.add('hud-window--customized');
  panel.style.left = `${geometry.left}px`;
  panel.style.top = `${geometry.top}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  panel.style.width = `${geometry.width}px`;
  panel.style.height = `${geometry.height}px`;
};

const getPanelGeometry = (panel: HTMLElement): HudWindowGeometry | null => {
  const rect = panel.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};

const persistCurrentLayout = (panel: HTMLElement, minimum = minimumFor(panel)): void => {
  const current = getPanelGeometry(panel);
  if (!current) return;
  const geometry = clampHudWindowGeometry(current, viewportBounds(), minimum);
  applyLayout(panel, geometry);
  saveLayout(panel, geometry);
};

const resetLayout = (panel: HTMLElement): void => {
  panel.classList.remove('hud-window--customized', 'hud-window--placed');
  const binding = bindings.get(panel);
  if (binding) binding.visible = false;
  ['left', 'top', 'right', 'bottom', 'width', 'height'].forEach((property) =>
    panel.style.removeProperty(property),
  );
  try {
    localStorage.removeItem(hudWindowStorageKey(panel.id));
  } catch {
    // Reset still works for this page even if localStorage access is blocked.
  }
};

const headerFor = (panel: HTMLElement): HTMLElement | null =>
  panel.querySelector<HTMLElement>(
    ':scope > [data-hud-window-handle], :scope > header, :scope > [id$="-header"], :scope > [class*="-header"], :scope > [class*="-titlebar"], :scope > .hero-card-main',
  );

const panelLabel = (panel: HTMLElement): string =>
  panel.getAttribute('aria-label') ??
  panel.querySelector<HTMLElement>('[class*="-title"]')?.textContent?.trim() ??
  panel.id;

const isInteractiveTarget = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  !!target.closest('button, a, input, select, textarea, label, [contenteditable="true"]');

const startPointerInteraction = (
  panel: HTMLElement,
  event: PointerEvent | MouseEvent,
  mode: 'move' | 'resize',
): void => {
  if (event.button !== 0) return;
  // A docked window is laid out by its host panel: dragging it would move it out
  // of its slot and persist that position for the next load. Any window can opt
  // out by carrying HUD_WINDOW_DOCKED_CLASS.
  if (panel.classList.contains(HUD_WINDOW_DOCKED_CLASS)) return;
  const initial = getPanelGeometry(panel);
  if (!initial) return;

  event.preventDefault();
  event.stopPropagation();
  panel.classList.add('hud-window--interacting');
  const minimum = minimumFor(panel);

  const onMove = (moveEvent: PointerEvent | MouseEvent) => {
    const dx = moveEvent.clientX - event.clientX;
    const dy = moveEvent.clientY - event.clientY;
    const next =
      mode === 'move'
        ? { ...initial, left: initial.left + dx, top: initial.top + dy }
        : { ...initial, width: initial.width + dx, height: initial.height + dy };
    const geometry = clampHudWindowGeometry(next, viewportBounds(), minimum);
    applyLayout(panel, geometry);
  };

  const onEnd = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onEnd);
    window.removeEventListener('pointercancel', onEnd);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onEnd);
    panel.classList.remove('hud-window--interacting');
    persistCurrentLayout(panel, minimum);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onEnd);
  window.addEventListener('pointercancel', onEnd);
  // Mouse events cover Playwright / headless / older browsers.
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onEnd);
};

const installHeaderControls = (
  panel: HTMLElement,
  header: HTMLElement,
  binding: HudWindowBinding,
): void => {
  if (binding.header !== header) {
    binding.header = header;
    header.classList.add('hud-window-handle');
    header.dataset['hudWindowHandle'] = 'true';
    header.addEventListener('pointerdown', (event) => {
      if (!isInteractiveTarget(event.target)) startPointerInteraction(panel, event, 'move');
    });
    // Mouse drag for headless / older browsers where Pointer Events may be absent.
    header.addEventListener('mousedown', (event) => {
      if (!isInteractiveTarget(event.target)) startPointerInteraction(panel, event, 'move');
    });
  }

  if (binding.resetControl?.isConnected) return;
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'hud-window-reset';
  reset.title = 'Restablecer posición y tamaño';
  reset.setAttribute('aria-label', `Restablecer posición y tamaño de ${panelLabel(panel)}`);
  reset.textContent = '↺';
  reset.addEventListener('click', () => resetLayout(panel));

  const closeButton = Array.from(header.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) =>
      /cerrar|close/i.test(
        `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`,
      ),
  );
  if (closeButton) closeButton.before(reset);
  else header.append(reset);
  binding.resetControl = reset;
};

const installResizeHandle = (panel: HTMLElement, binding: HudWindowBinding): void => {
  if (binding.resizeHandle?.isConnected) return;
  const resizeHandle = document.createElement('button');
  resizeHandle.type = 'button';
  resizeHandle.className = 'hud-window-resize';
  resizeHandle.setAttribute(
    'aria-label',
    `Redimensionar ${panelLabel(panel)}. Usa las flechas; Mayús aumenta el salto.`,
  );
  resizeHandle.title = 'Arrastra para redimensionar';
  resizeHandle.addEventListener('pointerdown', (event) =>
    startPointerInteraction(panel, event, 'resize'),
  );
  resizeHandle.addEventListener('mousedown', (event) =>
    startPointerInteraction(panel, event, 'resize'),
  );
  resizeHandle.addEventListener('keydown', (event) => {
    const increment = event.shiftKey ? 32 : 8;
    const deltaByKey: Record<string, Partial<Pick<HudWindowGeometry, 'width' | 'height'>>> = {
      ArrowLeft: { width: -increment },
      ArrowRight: { width: increment },
      ArrowUp: { height: -increment },
      ArrowDown: { height: increment },
    };
    const delta = deltaByKey[event.key];
    if (!delta) return;
    const current = getPanelGeometry(panel);
    if (!current) return;
    event.preventDefault();
    const geometry = clampHudWindowGeometry(
      {
        ...current,
        ...delta,
        width: current.width + (delta.width ?? 0),
        height: current.height + (delta.height ?? 0),
      },
      viewportBounds(),
      minimumFor(panel),
    );
    applyLayout(panel, geometry);
    saveLayout(panel, geometry);
  });
  panel.append(resizeHandle);
  binding.resizeHandle = resizeHandle;
};

/** Makes a known HUD overlay movable, resizable, resettable and persistent. */
export function mountHudWindow(panel: HTMLElement): void {
  const existing = bindings.get(panel);
  const binding = existing ?? {
    header: null,
    resetControl: null,
    resizeHandle: null,
    visible: false,
  };
  bindings.set(panel, binding);

  const saved = existing ? null : readLayout(panel.id);
  if (saved) applyLayout(panel, clampHudWindowGeometry(saved, viewportBounds(), minimumFor(panel)));

  const header = headerFor(panel);
  if (!header) return;
  installHeaderControls(panel, header, binding);
  installResizeHandle(panel, binding);
}

/** Mounts current HUD panels and observes later-created overlays. */
export function initHudWindows(): () => void {
  let frame = 0;
  let reflow = false;
  const visibleGeometry = (panel: HTMLElement): HudWindowGeometry | null => {
    if (panel.hidden || getComputedStyle(panel).display === 'none') return null;
    return getPanelGeometry(panel);
  };
  const arrange = () => {
    frame = 0;
    const panels = Array.from(document.querySelectorAll<HTMLElement>(HUD_WINDOW_SELECTOR));
    for (const panel of panels) {
      const binding = bindings.get(panel);
      if (!binding) continue;
      const current = visibleGeometry(panel);
      const opening = !!current && !binding.visible;
      binding.visible = !!current;
      if (!current || (!opening && !reflow) || panel.classList.contains('hud-window--interacting'))
        continue;
      let preferred = current;
      const gaceta = document.getElementById('gaceta-widget');
      const anchor = gaceta && visibleGeometry(gaceta);
      if (panel.id === 'unit-panel' && !readLayout(panel.id) && anchor) {
        preferred = {
          ...current,
          left: anchor.left + anchor.width + VIEWPORT_GAP,
          top: anchor.top,
        };
      }
      const obstacles = [
        ...panels,
        ...document.querySelectorAll<HTMLElement>('#gaceta-widget, #top-bar'),
      ]
        .filter((other) => other !== panel && !other.contains(panel) && !panel.contains(other))
        .map(visibleGeometry)
        .filter((rect): rect is HudWindowGeometry => rect !== null);
      const next = placeHudWindow(preferred, viewportBounds(), obstacles, minimumFor(panel));
      panel.classList.add('hud-window--placed');
      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.width = `${next.width}px`;
      // Keep natural content height, except for explicitly user-sized windows.
      if (panel.classList.contains('hud-window--customized'))
        panel.style.height = `${next.height}px`;
    }
    reflow = false;
  };
  const schedule = (force = false) => {
    reflow ||= force;
    if (!frame) frame = requestAnimationFrame(arrange);
  };
  const sizes = new WeakMap<Element, string>();
  const sizeObserver = new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const size = `${entry.contentRect.width}:${entry.contentRect.height}`;
      if (sizes.has(entry.target) && sizes.get(entry.target) !== size) changed = true;
      sizes.set(entry.target, size);
    }
    if (changed) schedule(true);
  });
  const mount = (panel: HTMLElement) => {
    mountHudWindow(panel);
    sizeObserver.observe(panel);
    schedule();
  };
  const mountCandidates = (root: ParentNode) => {
    root.querySelectorAll<HTMLElement>(HUD_WINDOW_SELECTOR).forEach(mount);
  };
  mountCandidates(document);
  document.querySelectorAll('#gaceta-widget, #top-bar').forEach((el) => sizeObserver.observe(el));

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      const owner =
        record.target instanceof HTMLElement
          ? record.target.closest<HTMLElement>(HUD_WINDOW_SELECTOR)
          : null;
      if (owner) mount(owner);
      record.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches(HUD_WINDOW_SELECTOR)) mount(node);
        mountCandidates(node);
      });
    });
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  });

  const constrainWindows = () => {
    schedule(true);
  };
  window.addEventListener('resize', constrainWindows);

  return () => {
    observer.disconnect();
    sizeObserver.disconnect();
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', constrainWindows);
  };
}
