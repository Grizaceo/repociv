import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginMapEditGroup,
  canRedoMapEdit,
  canUndoMapEdit,
  clearMapEditHistory,
  endMapEditGroup,
  nextRedoLabel,
  nextUndoLabel,
  onMapEditHistoryChange,
  pushMapEdit,
  redoMapEdit,
  undoMapEdit,
} from './mapEditHistory.ts';

function step(label: string, log: string[]) {
  return {
    label,
    undo: () => log.push(`undo:${label}`),
    redo: () => log.push(`redo:${label}`),
  };
}

afterEach(() => clearMapEditHistory());

describe('map edit history', () => {
  it('stacks, undoes and redoes in order', () => {
    const log: string[] = [];
    pushMapEdit(step('a', log));
    pushMapEdit(step('b', log));

    expect(nextUndoLabel()).toBe('b');
    expect(undoMapEdit()).toBe('b');
    expect(undoMapEdit()).toBe('a');
    expect(undoMapEdit()).toBeNull();
    expect(canUndoMapEdit()).toBe(false);
    expect(canRedoMapEdit()).toBe(true);

    expect(nextRedoLabel()).toBe('a');
    expect(redoMapEdit()).toBe('a');
    expect(redoMapEdit()).toBe('b');
    expect(redoMapEdit()).toBeNull();
    expect(log).toEqual(['undo:b', 'undo:a', 'redo:a', 'redo:b']);
  });

  it('drops the redo branch when a new edit lands after an undo', () => {
    const log: string[] = [];
    pushMapEdit(step('a', log));
    pushMapEdit(step('b', log));
    undoMapEdit();
    expect(canRedoMapEdit()).toBe(true);

    pushMapEdit(step('c', log));

    expect(canRedoMapEdit()).toBe(false);
    expect(redoMapEdit()).toBeNull();
    expect(nextUndoLabel()).toBe('c');
  });

  it('keeps at most 100 entries, dropping the oldest', () => {
    const log: string[] = [];
    for (let i = 0; i < 105; i++) pushMapEdit(step(`e${i}`, log));

    let undone = 0;
    while (undoMapEdit() !== null) undone++;
    expect(undone).toBe(100);
    // The five oldest fell off the bottom.
    expect(log[0]).toBe('undo:e104');
    expect(log[99]).toBe('undo:e5');
  });

  it('collapses a group into one step: undo reversed, redo in order', () => {
    const log: string[] = [];
    beginMapEditGroup('Pintar');
    pushMapEdit(step('h1', log));
    pushMapEdit(step('h2', log));
    pushMapEdit(step('h3', log));
    endMapEditGroup();

    expect(nextUndoLabel()).toBe('Pintar');
    expect(undoMapEdit()).toBe('Pintar');
    expect(log).toEqual(['undo:h3', 'undo:h2', 'undo:h1']);

    expect(redoMapEdit()).toBe('Pintar');
    expect(log.slice(3)).toEqual(['redo:h1', 'redo:h2', 'redo:h3']);
  });

  it('does not stack an empty group', () => {
    beginMapEditGroup('Pintar');
    endMapEditGroup();

    expect(canUndoMapEdit()).toBe(false);
    expect(nextUndoLabel()).toBeNull();
  });

  it('nests groups: the inner one joins the outer', () => {
    const log: string[] = [];
    beginMapEditGroup('Exterior');
    pushMapEdit(step('a', log));
    beginMapEditGroup('Interior');
    pushMapEdit(step('b', log));
    endMapEditGroup();
    pushMapEdit(step('c', log));
    endMapEditGroup();

    expect(nextUndoLabel()).toBe('Exterior');
    undoMapEdit();
    expect(log).toEqual(['undo:c', 'undo:b', 'undo:a']);
  });

  it('tells subscribers about pushes, undos, redos and clears', () => {
    const listener = vi.fn();
    const unsubscribe = onMapEditHistoryChange(listener);
    const log: string[] = [];

    pushMapEdit(step('a', log));
    expect(listener).toHaveBeenCalledTimes(1);
    undoMapEdit();
    expect(listener).toHaveBeenCalledTimes(2);
    redoMapEdit();
    expect(listener).toHaveBeenCalledTimes(3);
    clearMapEditHistory();
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    pushMapEdit(step('b', log));
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
