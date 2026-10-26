// ─── RepoCiv — Map edit history (undo / redo) ───────────────────────────────
//
// Session-only stack for the map editor: it survives closing the editor but not
// a reload. Entries know how to put their edit back and how to apply it again;
// this module only orders them, groups a brush stroke into one step and tells
// the UI when something changed. No DOM, no world.

export interface MapEditHistoryEntry {
  /** Shown in the toolbar ("Deshacer: <label>"). */
  label: string;
  undo(): void;
  redo(): void;
}

/** Oldest entries fall off past this depth. */
const LIMIT = 100;

let undoStack: MapEditHistoryEntry[] = [];
let redoStack: MapEditHistoryEntry[] = [];
let groups: Array<{ label: string; entries: MapEditHistoryEntry[] }> = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to stack changes; returns the unsubscribe function. */
export function onMapEditHistoryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function appendToUndo(entry: MapEditHistoryEntry): void {
  undoStack.push(entry);
  if (undoStack.length > LIMIT) undoStack.splice(0, undoStack.length - LIMIT);
}

/** Stack an edit. A new edit after an undo drops the redo branch. */
export function pushMapEdit(entry: MapEditHistoryEntry): void {
  redoStack = [];
  const group = groups[groups.length - 1];
  if (group) group.entries.push(entry);
  else appendToUndo(entry);
  notify();
}

/**
 * Start collecting edits into a single step (a brush stroke is many hexes but
 * one undo). Groups nest: a closed group joins its parent group if there is one.
 */
export function beginMapEditGroup(label: string): void {
  groups.push({ label, entries: [] });
}

/** Close the innermost group. An empty group stacks nothing. */
export function endMapEditGroup(): void {
  const group = groups.pop();
  if (!group || group.entries.length === 0) return;
  const entries = group.entries;
  const composite: MapEditHistoryEntry = {
    label: group.label,
    undo: () => {
      for (let i = entries.length - 1; i >= 0; i--) entries[i]!.undo();
    },
    redo: () => {
      for (const entry of entries) entry.redo();
    },
  };
  const parent = groups[groups.length - 1];
  if (parent) parent.entries.push(composite);
  else appendToUndo(composite);
  redoStack = [];
  notify();
}

/** Undo the last step. Returns its label, or null when there is nothing left. */
export function undoMapEdit(): string | null {
  const entry = undoStack.pop();
  if (!entry) return null;
  entry.undo();
  redoStack.push(entry);
  notify();
  return entry.label;
}

/** Redo the last undone step. Returns its label, or null when there is none. */
export function redoMapEdit(): string | null {
  const entry = redoStack.pop();
  if (!entry) return null;
  entry.redo();
  undoStack.push(entry);
  notify();
  return entry.label;
}

export function canUndoMapEdit(): boolean {
  return undoStack.length > 0;
}

export function canRedoMapEdit(): boolean {
  return redoStack.length > 0;
}

export function nextUndoLabel(): string | null {
  return undoStack[undoStack.length - 1]?.label ?? null;
}

export function nextRedoLabel(): string | null {
  return redoStack[redoStack.length - 1]?.label ?? null;
}

/** Forget everything (scene teardown, tests, "restore everything"). */
export function clearMapEditHistory(): void {
  undoStack = [];
  redoStack = [];
  groups = [];
  notify();
}
