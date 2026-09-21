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
const VIEWPORT_GAP = 8;
const DEFAULT_MINIMUM: HudWindowMinimum = { minWidth: 240, minHeight: 180 };
const HUD_WINDOW_IDS = [
  'side-panel',
  'city-panel',
  'agents-panel',
  'capital-panel',
  'settings-panel',
  'layer-panel',
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
] as const;
const HUD_WINDOW_SELECTOR = HUD_WINDOW_IDS.map((id) => `#${id}`).join(', ');

interface HudWindowBinding {
  header: HTMLElement | null;
  resetControl: HTMLButtonElement | null;
  resizeHandle: HTMLButtonElement | null;
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

const viewportBounds = (): HudWindowBounds => ({
  width: window.innerWidth,
  height: window.innerHeight,
});

const minimumFor = (panel: HTMLElement): HudWindowMinimum => {
  if (panel.id === 'layer-panel') return { minWidth: 180, minHeight: 180 };
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
  panel.classList.remove('hud-window--customized');
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
    ':scope > [data-hud-window-handle], :scope > header, :scope > [id$="-header"], :scope > [class*="-header"], :scope > [class*="-titlebar"]',
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
  const binding = bindings.get(panel) ?? { header: null, resetControl: null, resizeHandle: null };
  bindings.set(panel, binding);

  const saved = readLayout(panel.id);
  if (saved) applyLayout(panel, clampHudWindowGeometry(saved, viewportBounds(), minimumFor(panel)));

  const header = headerFor(panel);
  if (!header) return;
  installHeaderControls(panel, header, binding);
  installResizeHandle(panel, binding);
}

/** Mounts current HUD panels and observes later-created overlays. */
export function initHudWindows(): () => void {
  const mountCandidates = (root: ParentNode) => {
    root.querySelectorAll<HTMLElement>(HUD_WINDOW_SELECTOR).forEach(mountHudWindow);
  };
  mountCandidates(document);

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      const owner =
        record.target instanceof HTMLElement
          ? record.target.closest<HTMLElement>(HUD_WINDOW_SELECTOR)
          : null;
      if (owner) mountHudWindow(owner);
      record.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches(HUD_WINDOW_SELECTOR)) mountHudWindow(node);
        mountCandidates(node);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const constrainWindows = () => {
    document
      .querySelectorAll<HTMLElement>('.hud-window--customized')
      .forEach((panel) => persistCurrentLayout(panel));
  };
  window.addEventListener('resize', constrainWindows);

  return () => {
    observer.disconnect();
    window.removeEventListener('resize', constrainWindows);
  };
}
