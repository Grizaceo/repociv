import { describe, expect, it } from 'vitest';
import {
  fitFontSize,
  reasonText,
  runtimeText,
  sortAgents,
  terminalKeyAction,
} from './terminalPanel.ts';
import type { TerminalAgent } from './terminalLink.ts';

const key = (init: Partial<KeyboardEvent> & { key: string }) => ({
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...init,
});

describe('terminalKeyAction', () => {
  it('leaves Esc and every plain key to the agent', () => {
    expect(terminalKeyAction(key({ key: 'Escape' }))).toBeNull();
    expect(terminalKeyAction(key({ key: 'Enter' }))).toBeNull();
    expect(terminalKeyAction(key({ key: 'c', ctrlKey: true }))).toBeNull();
    expect(terminalKeyAction(key({ key: 'v', ctrlKey: true }))).toBeNull();
    expect(terminalKeyAction(key({ key: 't' }))).toBeNull();
  });

  it('takes only the chords a terminal keeps for itself', () => {
    expect(terminalKeyAction(key({ key: 'Enter', shiftKey: true }))).toBe('newline');
    expect(terminalKeyAction(key({ key: 'Escape', shiftKey: true }))).toBe('leave');
    expect(terminalKeyAction(key({ key: 'C', ctrlKey: true, shiftKey: true }))).toBe('copy');
    expect(terminalKeyAction(key({ key: 'V', ctrlKey: true, shiftKey: true }))).toBe('paste');
  });

  it('does not steal other modified combinations', () => {
    expect(terminalKeyAction(key({ key: 'Enter', shiftKey: true, altKey: true }))).toBeNull();
    expect(terminalKeyAction(key({ key: 'Enter', shiftKey: true, ctrlKey: true }))).toBeNull();
    expect(terminalKeyAction(key({ key: 'x', ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});

describe('fitFontSize', () => {
  it('shrinks the font so the PTY grid fits', () => {
    expect(fitFontSize(13, { cols: 150, rows: 50 }, { cols: 200, rows: 40 })).toBe(9.5);
    expect(fitFontSize(14, { cols: 100, rows: 40 }, { cols: 120, rows: 40 })).toBe(11.5);
  });

  it('is limited by the tighter axis', () => {
    expect(fitFontSize(12, { cols: 200, rows: 30 }, { cols: 100, rows: 40 })).toBe(9);
  });

  it('never goes past the readable range', () => {
    expect(fitFontSize(13, { cols: 10, rows: 10 }, { cols: 300, rows: 90 })).toBe(6);
    expect(fitFontSize(13, { cols: 400, rows: 200 }, { cols: 80, rows: 24 })).toBe(16);
  });

  it('keeps the font while the panel cannot be measured', () => {
    expect(fitFontSize(13, undefined, { cols: 80, rows: 24 })).toBe(13);
    expect(fitFontSize(13, { cols: 0, rows: 0 }, { cols: 80, rows: 24 })).toBe(13);
  });
});

describe('sortAgents', () => {
  it('puts the agents waiting for a human first', () => {
    const agent = (status: string): TerminalAgent => ({
      paneId: status,
      terminalId: status,
      agent: 'claude',
      status,
      name: '',
      folder: '',
    });
    const sorted = sortAgents(['idle', 'unknown', 'done', 'working', 'blocked'].map(agent));
    expect(sorted.map((a) => a.status)).toEqual(['blocked', 'working', 'done', 'idle', 'unknown']);
  });
});

describe('messages', () => {
  it('explains a refusal in plain words and shows unknown codes as they are', () => {
    expect(reasonText('herdr_stopped')).toBe('herdr no está corriendo.');
    expect(reasonText('terminal exited')).toBe('terminal exited');
  });

  it('names both versions for an old herdr', () => {
    expect(runtimeText({ state: 'outdated', version: '0.8.0', minVersion: '0.9.1' })).toContain('0.8.0');
    expect(runtimeText({ state: 'missing', version: '', minVersion: '0.9.1' })).toBe(
      'herdr no está instalado.',
    );
  });
});
