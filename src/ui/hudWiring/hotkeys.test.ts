// ─── RepoCiv — Global hotkeys (Escape chain) ────────────────────────────────
//
// The Escape branch closes one panel at a time. The map editor is one more link
// in that chain: its own keydown listener is gone, so these tests drive the
// single global listener and check who gets closed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    hideUnitPanel: fn(),
    openSidePanel: fn(),
    closeSidePanel: fn(),
    isSidePanelOpen: vi.fn(() => false),
    toggleKeyboardHelp: fn(),
    closeCityPanel: fn(),
    isCityPanelOpen: vi.fn(() => false),
    togglePriorityPanel: fn(),
    isPriorityPanelOpen: vi.fn(() => false),
    toggleApprovalPanel: fn(),
    closeApprovalPanel: fn(),
    isApprovalPanelOpen: vi.fn(() => false),
    closeTaskPanel: fn(),
    toggleTaskPanel: fn(),
    isTaskPanelOpen: vi.fn(() => false),
    closePendingPanel: fn(),
    isPendingPanelOpen: vi.fn(() => false),
    closeLogPanel: fn(),
    toggleLogPanel: fn(),
    isLogPanelOpen: vi.fn(() => false),
    toggleTaskAssignPanel: fn(),
    isTaskAssignPanelOpen: vi.fn(() => false),
    toggleKanbanPanel: fn(),
    closeKanbanPanel: fn(),
    isKanbanPanelOpen: vi.fn(() => false),
    terminalVisible: vi.fn(() => false),
    terminalHasFocus: vi.fn(() => false),
    terminalHide: fn(),
    terminalToggle: fn(),
    toggleSettingsPanel: fn(),
    closeSettingsPanel: fn(),
    toggleAgentsPanel: fn(),
    closeAgentsPanel: fn(),
    isAgentsPanelOpen: vi.fn(() => false),
    openNewAgentSession: fn(),
    openExternalAgentChat: fn(),
    closeConstructionPanel: fn(),
    isConstructionPanelOpen: vi.fn(() => false),
    toggleMapEditor: fn(),
    isMapEditorOpen: vi.fn(() => false),
    closeMapEditor: fn(),
    selectHero: fn(),
    takeScreenshot: fn(),
    getSelectedProfile: vi.fn(() => null),
    heroBarRoster: vi.fn(() => []),
    activeSessionDock: vi.fn(() => []),
    visibleSessionDock: vi.fn(() => []),
    externalSessionSnapshot: vi.fn(() => []),
    trackHotkey: fn(),
    toggleView: fn(),
    trackPanelOpen: fn(),
    isPickerOpen: vi.fn(() => false),
    isCommandPaletteOpen: vi.fn(() => false),
    sharedIdleFinder: { nextIdle: vi.fn(() => null) },
  };
});

vi.mock('../index.ts', () => ({
  hideUnitPanel: m.hideUnitPanel,
  openSidePanel: m.openSidePanel,
  closeSidePanel: m.closeSidePanel,
  isSidePanelOpen: m.isSidePanelOpen,
  toggleKeyboardHelp: m.toggleKeyboardHelp,
  closeCityPanel: m.closeCityPanel,
  isCityPanelOpen: m.isCityPanelOpen,
  togglePriorityPanel: m.togglePriorityPanel,
  isPriorityPanelOpen: m.isPriorityPanelOpen,
  toggleApprovalPanel: m.toggleApprovalPanel,
  closeApprovalPanel: m.closeApprovalPanel,
  isApprovalPanelOpen: m.isApprovalPanelOpen,
  closeTaskPanel: m.closeTaskPanel,
  toggleTaskPanel: m.toggleTaskPanel,
  isTaskPanelOpen: m.isTaskPanelOpen,
  closePendingPanel: m.closePendingPanel,
  isPendingPanelOpen: m.isPendingPanelOpen,
  closeLogPanel: m.closeLogPanel,
  toggleLogPanel: m.toggleLogPanel,
  isLogPanelOpen: m.isLogPanelOpen,
  toggleTaskAssignPanel: m.toggleTaskAssignPanel,
  isTaskAssignPanelOpen: m.isTaskAssignPanelOpen,
  toggleKanbanPanel: m.toggleKanbanPanel,
  closeKanbanPanel: m.closeKanbanPanel,
  isKanbanPanelOpen: m.isKanbanPanelOpen,
}));

vi.mock('../../terminalPanel.ts', () => ({
  terminalPanel: {
    isVisible: m.terminalVisible,
    hasFocus: m.terminalHasFocus,
    hide: m.terminalHide,
    toggle: m.terminalToggle,
  },
}));

vi.mock('../settingsPanel.ts', () => ({
  toggleSettingsPanel: m.toggleSettingsPanel,
  closeSettingsPanel: m.closeSettingsPanel,
}));

vi.mock('../agentsPanel.ts', () => ({
  toggleAgentsPanel: m.toggleAgentsPanel,
  closeAgentsPanel: m.closeAgentsPanel,
  isAgentsPanelOpen: m.isAgentsPanelOpen,
  openNewAgentSession: m.openNewAgentSession,
  openExternalAgentChat: m.openExternalAgentChat,
}));

vi.mock('../constructionPanel.ts', () => ({
  closeConstructionPanel: m.closeConstructionPanel,
  isConstructionPanelOpen: m.isConstructionPanelOpen,
}));

vi.mock('../mapEditor.ts', () => ({
  toggleMapEditor: m.toggleMapEditor,
  isMapEditorOpen: m.isMapEditorOpen,
  closeMapEditor: m.closeMapEditor,
}));

vi.mock('./spawn.ts', () => ({ selectHero: m.selectHero }));
vi.mock('./screenshot.ts', () => ({ takeScreenshot: m.takeScreenshot }));
vi.mock('../agentProfileStrip.ts', () => ({ getSelectedProfile: m.getSelectedProfile }));
vi.mock('../heroBarUnits.ts', () => ({ heroBarRoster: m.heroBarRoster }));
vi.mock('../agentDock.ts', () => ({
  activeSessionDock: m.activeSessionDock,
  visibleSessionDock: m.visibleSessionDock,
}));
vi.mock('../externalSessionDirectory.ts', () => ({
  externalSessionSnapshot: m.externalSessionSnapshot,
}));
vi.mock('../analytics.ts', () => ({
  trackHotkey: m.trackHotkey,
  trackPanelOpen: m.trackPanelOpen,
}));
vi.mock('../chat/slashPicker.ts', () => ({ isPickerOpen: m.isPickerOpen }));
vi.mock('../commandPalette.ts', () => ({ isCommandPaletteOpen: m.isCommandPaletteOpen }));
vi.mock('../idleAgentFinder.ts', () => ({ sharedIdleFinder: m.sharedIdleFinder }));

import { wireHotkeys } from './hotkeys.ts';

let keydown: ((e: unknown) => void) | null = null;

class FakeInputElement {
  value = '';
}
class FakeTextAreaElement {
  value = '';
}

function installDom(options: { dialog?: boolean } = {}): void {
  keydown = null;
  vi.stubGlobal('HTMLInputElement', FakeInputElement);
  vi.stubGlobal('HTMLTextAreaElement', FakeTextAreaElement);
  vi.stubGlobal('document', {
    addEventListener: vi.fn((type: string, fn: (e: unknown) => void) => {
      if (type === 'keydown') keydown = fn;
    }),
    querySelector: vi.fn((selector: string) =>
      options.dialog && selector === 'dialog[open]' ? {} : null,
    ),
    getElementById: vi.fn(() => null),
    body: { classList: { contains: vi.fn(() => false) } },
  });
}

const renderer = {
  selectUnit: vi.fn(),
  setActionMode: vi.fn(),
  sleepSelectedUnit: vi.fn(),
  toggleGrid: vi.fn(),
  toggleDebug: vi.fn(),
  toggleFog: vi.fn(),
  toggleLocalDebugOverlay: vi.fn(),
  focusOnCoord: vi.fn(),
  flashIdleHighlight: vi.fn(),
  toggleWorldRenderMode: vi.fn(),
  undoLastMapEdit: vi.fn(),
  redoLastMapEdit: vi.fn(),
};

const state = {
  selectedUnit: null as null | { id: string },
  selectUnit: vi.fn(),
  getUnit: vi.fn(() => null),
  getAllUnits: vi.fn(() => []),
  getMissionQueue: vi.fn(() => []),
  getLocalUnits: vi.fn(() => []),
  setLocalUnitTask: vi.fn(),
  unhideAllUnits: vi.fn(),
  dispatchMissionById: vi.fn(),
  viewMode: 'macro' as const,
};

function wire(): void {
  wireHotkeys(renderer as never, state as never, {} as never, m.toggleView);
}

function pressEscape(target: unknown = {}): void {
  keydown!({ key: 'Escape', target, preventDefault: vi.fn() });
}

class FakeKeyEvent {
  key: string;
  ctrlKey = false;
  metaKey = false;
  shiftKey = false;
  target: unknown;
  defaultPrevented = false;
  constructor(init: { key: string; target?: unknown } & Partial<FakeKeyEvent>) {
    this.key = init.key;
    this.target = init.target ?? {};
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

function pressKey(init: { key: string; target?: unknown } & Partial<FakeKeyEvent>): FakeKeyEvent {
  const event = new FakeKeyEvent(init);
  keydown!(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.isMapEditorOpen.mockReturnValue(false);
  m.isConstructionPanelOpen.mockReturnValue(false);
  m.isSidePanelOpen.mockReturnValue(false);
  m.isTaskPanelOpen.mockReturnValue(false);
  m.isPendingPanelOpen.mockReturnValue(false);
  m.isLogPanelOpen.mockReturnValue(false);
  m.isAgentsPanelOpen.mockReturnValue(false);
  m.isApprovalPanelOpen.mockReturnValue(false);
  m.isKanbanPanelOpen.mockReturnValue(false);
  m.isCityPanelOpen.mockReturnValue(false);
  m.terminalVisible.mockReturnValue(false);
  m.terminalHasFocus.mockReturnValue(false);
  m.isPickerOpen.mockReturnValue(false);
  m.isCommandPaletteOpen.mockReturnValue(false);
  state.selectedUnit = null;
});

describe('wireHotkeys — 2D/3D view toggle (F2)', () => {
  it('F2 toggles the renderer', () => {
    installDom();
    wire();
    const event = pressKey({ key: 'F2' });
    expect(m.toggleView).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('digits 2 and 3 select dock sessions again', () => {
    installDom();
    wire();
    m.visibleSessionDock.mockReturnValue([
      { kind: 'own', key: 'u1' },
      { kind: 'own', key: 'u2' },
      { kind: 'own', key: 'u3' },
    ] as never);
    const u2 = { id: 'u2' };
    const u3 = { id: 'u3' };
    (state.getUnit as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'u2' ? u2 : id === 'u3' ? u3 : null,
    );
    pressKey({ key: '2' });
    expect(m.selectHero.mock.calls[0]?.[0]).toBe(u2);
    pressKey({ key: '3' });
    expect(m.selectHero.mock.calls[1]?.[0]).toBe(u3);
    expect(m.toggleView).not.toHaveBeenCalled();
  });
});

describe('wireHotkeys — global chords inside text fields', () => {
  it('F-keys still toggle their panels while an input has focus', () => {
    installDom();
    wire();
    const input = new FakeInputElement();
    const f8 = pressKey({ key: 'F8', target: input });
    expect(m.toggleAgentsPanel).toHaveBeenCalledOnce();
    expect(f8.defaultPrevented).toBe(true);
    pressKey({ key: 'F10', target: input });
    expect(m.toggleLogPanel).toHaveBeenCalledOnce();
    pressKey({ key: 'F6', target: input });
    expect(m.toggleKanbanPanel).toHaveBeenCalledOnce();
  });

  it('Ctrl+S sleeps the selected unit while an input has focus', () => {
    installDom();
    wire();
    const event = pressKey({ key: 's', ctrlKey: true, target: new FakeInputElement() });
    expect(renderer.sleepSelectedUnit).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('typing keys keep their native field behavior', () => {
    installDom();
    wire();
    const input = new FakeInputElement();
    pressKey({ key: 'm', target: input });
    expect(renderer.setActionMode).not.toHaveBeenCalled();
    pressKey({ key: 'F', target: input });
    expect(renderer.toggleDebug).not.toHaveBeenCalled();
    pressKey({ key: '1', target: input });
    expect(m.selectHero).not.toHaveBeenCalled();
  });

  it('Ctrl+C copies a text selection instead of opening the wizard', () => {
    installDom();
    wire();
    vi.stubGlobal('getSelection', () => ({ toString: () => 'selected text' }));
    const event = pressKey({ key: 'c', ctrlKey: true });
    expect(m.openNewAgentSession).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    vi.unstubAllGlobals();
  });

  it('Ctrl+C still opens the claude wizard with nothing selected', () => {
    installDom();
    wire();
    vi.stubGlobal('getSelection', () => ({ toString: () => '' }));
    pressKey({ key: 'c', ctrlKey: true });
    expect(m.openNewAgentSession).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('modals keep priority over field hotkeys', () => {
    installDom();
    wire();
    m.isPickerOpen.mockReturnValue(true);
    pressKey({ key: 'F8', target: new FakeInputElement() });
    expect(m.toggleAgentsPanel).not.toHaveBeenCalled();
    m.isPickerOpen.mockReturnValue(false);
    m.isCommandPaletteOpen.mockReturnValue(true);
    pressKey({ key: 'F8', target: new FakeInputElement() });
    expect(m.toggleAgentsPanel).not.toHaveBeenCalled();
    m.isCommandPaletteOpen.mockReturnValue(false);
    m.terminalHasFocus.mockReturnValue(true);
    pressKey({ key: 's', ctrlKey: true, target: new FakeInputElement() });
    expect(renderer.sleepSelectedUnit).not.toHaveBeenCalled();
  });
});

describe('wireHotkeys — undo and redo shortcuts', () => {
  it('Ctrl+Z undoes while the map editor is open', () => {
    installDom();
    wire();
    m.isMapEditorOpen.mockReturnValue(true);

    const event = pressKey({ key: 'z', ctrlKey: true });

    expect(renderer.undoLastMapEdit).toHaveBeenCalledTimes(1);
    expect(renderer.redoLastMapEdit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('Cmd+Shift+Z and Ctrl+Y redo', () => {
    installDom();
    wire();
    m.isMapEditorOpen.mockReturnValue(true);

    pressKey({ key: 'z', metaKey: true, shiftKey: true });
    pressKey({ key: 'y', ctrlKey: true });

    expect(renderer.redoLastMapEdit).toHaveBeenCalledTimes(2);
    expect(renderer.undoLastMapEdit).not.toHaveBeenCalled();
  });

  it('does nothing when the editor is closed', () => {
    installDom();
    wire();
    m.isMapEditorOpen.mockReturnValue(false);

    const event = pressKey({ key: 'z', ctrlKey: true });

    expect(renderer.undoLastMapEdit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves the native undo alone when a field has text', () => {
    installDom();
    wire();
    m.isMapEditorOpen.mockReturnValue(true);
    const field = new FakeInputElement();
    field.value = 'borrador';

    const event = pressKey({ key: 'z', ctrlKey: true, target: field });

    expect(renderer.undoLastMapEdit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('sends the shortcut to the map when the field is empty', () => {
    installDom();
    wire();
    m.isMapEditorOpen.mockReturnValue(true);

    const event = pressKey({ key: 'z', ctrlKey: true, target: new FakeTextAreaElement() });

    expect(renderer.undoLastMapEdit).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does nothing under the slash picker or the command palette', () => {
    installDom();
    wire();
    m.isMapEditorOpen.mockReturnValue(true);
    m.isPickerOpen.mockReturnValue(true);

    pressKey({ key: 'z', ctrlKey: true });
    expect(renderer.undoLastMapEdit).not.toHaveBeenCalled();

    m.isPickerOpen.mockReturnValue(false);
    m.isCommandPaletteOpen.mockReturnValue(true);
    pressKey({ key: 'z', ctrlKey: true });
    expect(renderer.undoLastMapEdit).not.toHaveBeenCalled();
  });
});

describe('wireHotkeys — Escape chain and the map editor', () => {
  it('closes the editor without touching the unit selection', () => {
    installDom();
    wire();
    m.isMapEditorOpen.mockReturnValue(true);

    pressEscape();

    expect(m.closeMapEditor).toHaveBeenCalledTimes(1);
    expect(state.selectUnit).not.toHaveBeenCalled();
  });

  it('leaves the keyboard to the agent while the live terminal has focus', () => {
    // Esc interrupts the agent's turn; it must not close the panel on the way.
    installDom();
    wire();
    m.terminalVisible.mockReturnValue(true);
    m.terminalHasFocus.mockReturnValue(true);

    pressEscape();
    pressKey({ key: 't' });

    expect(m.terminalHide).not.toHaveBeenCalled();
    expect(m.terminalToggle).not.toHaveBeenCalled();
  });

  it('closes the terminal first when both are open', () => {
    installDom();
    wire();
    m.isMapEditorOpen.mockReturnValue(true);
    m.terminalVisible.mockReturnValue(true);

    pressEscape();

    expect(m.terminalHide).toHaveBeenCalledTimes(1);
    expect(m.closeMapEditor).not.toHaveBeenCalled();
  });

  it('leaves the editor open under the slash picker', () => {
    installDom();
    wire();
    m.isMapEditorOpen.mockReturnValue(true);
    m.isPickerOpen.mockReturnValue(true);

    pressEscape();

    expect(m.closeMapEditor).not.toHaveBeenCalled();
  });

  it('leaves the editor open under the command palette', () => {
    installDom();
    wire();
    m.isMapEditorOpen.mockReturnValue(true);
    m.isCommandPaletteOpen.mockReturnValue(true);

    pressEscape();

    expect(m.closeMapEditor).not.toHaveBeenCalled();
  });

  it('leaves the editor open under a modal dialog', () => {
    installDom({ dialog: true });
    wire();
    m.isMapEditorOpen.mockReturnValue(true);

    pressEscape();

    expect(m.closeMapEditor).not.toHaveBeenCalled();
  });

  it('leaves the editor open when Escape comes from an input', () => {
    installDom();
    wire();
    m.isMapEditorOpen.mockReturnValue(true);

    pressEscape(new FakeInputElement());

    expect(m.closeMapEditor).not.toHaveBeenCalled();
  });
});
