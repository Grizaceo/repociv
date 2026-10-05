// ─── Local view chat: thread selection ─────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  officeChatKeys,
  initialsOf,
  visibleMessages,
  isEmptyThread,
  agentChipsHtml,
  threadHtml,
  emptyStateHtml,
} from './thread.ts';
import type { LocalUnit } from '../../types.ts';
import type { ChatMessage } from '../chat/state.ts';

function unit(overrides: Partial<LocalUnit>): LocalUnit {
  return {
    id: 'MAIN',
    name: 'MAIN',
    macroUnitId: 'MAIN',
    gridX: 0,
    gridY: 0,
    ...overrides,
  } as LocalUnit;
}

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return { role: 'agent', text: 'hola', timestamp: '10:00', ...overrides };
}

describe('officeChatKeys', () => {
  it('returns the hero thread', () => {
    expect(officeChatKeys([unit({ id: 'MAIN', macroUnitId: 'MAIN' })])).toEqual(['MAIN']);
  });

  it('excludes ephemeral subagents — they speak through the parent thread', () => {
    const units = [
      unit({ id: 'MAIN', macroUnitId: 'MAIN' }),
      unit({ id: 'SCOUT-sub-1', macroUnitId: 'MAIN', ephemeral: true }),
    ];
    expect(officeChatKeys(units)).toEqual(['MAIN']);
  });

  it('falls back to macroUnitId when the local id is empty', () => {
    expect(officeChatKeys([unit({ id: '', macroUnitId: 'HERMES' })])).toEqual(['HERMES']);
  });

  it('dedupes when several non-ephemeral units share a macro id', () => {
    const units = [
      unit({ id: 'A', macroUnitId: 'SHARED' }),
      unit({ id: 'B', macroUnitId: 'SHARED' }),
    ];
    expect(officeChatKeys(units)).toEqual(['A', 'B']);
  });

  it('returns nothing for an empty office', () => {
    expect(officeChatKeys([])).toEqual([]);
  });

  it('returns nothing when every unit is ephemeral', () => {
    expect(officeChatKeys([unit({ id: 'S1', ephemeral: true })])).toEqual([]);
  });
});

describe('initialsOf', () => {
  it('takes the first two characters uppercased', () => {
    expect(initialsOf('worker')).toBe('WO');
  });

  it('is safe on a short or empty label', () => {
    expect(initialsOf('W')).toBe('W');
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
});

describe('visibleMessages', () => {
  it('drops the trailing empty agent slot left by appendUserMessage', () => {
    const history = [
      msg({ role: 'user', text: 'revisá el MCP' }),
      msg({ role: 'agent', text: '' }),
    ];
    expect(visibleMessages(history)).toHaveLength(1);
  });

  it('keeps a trailing agent message that has content', () => {
    const history = [msg({ role: 'agent', text: 'listo' })];
    expect(visibleMessages(history)).toHaveLength(1);
  });

  it('drops a whitespace-only trailing agent slot', () => {
    expect(visibleMessages([msg({ role: 'agent', text: '   \n' })])).toHaveLength(0);
  });

  it('does not mutate the input', () => {
    const history = [msg({ role: 'agent', text: '' })];
    visibleMessages(history);
    expect(history).toHaveLength(1);
  });

  it('keeps a mid-thread empty agent message (a real turn that failed)', () => {
    const history = [msg({ role: 'agent', text: '' }), msg({ role: 'user', text: 'otra' })];
    expect(visibleMessages(history)).toHaveLength(2);
  });
});

describe('isEmptyThread', () => {
  it('is true for no messages', () => {
    expect(isEmptyThread([])).toBe(true);
  });

  it('is true when only the streaming slot exists', () => {
    expect(isEmptyThread([msg({ role: 'agent', text: '' })])).toBe(true);
  });

  it('is false once anything real arrived', () => {
    expect(isEmptyThread([msg({ role: 'agent', text: 'x' })])).toBe(false);
  });
});

// ─── Markup ────────────────────────────────────────────────────────────────
// The feed's HTML is pure data so the presentation is testable in a repo with
// no DOM test environment.

describe('agentChipsHtml', () => {
  it('renders one chip per key with its initials', () => {
    const html = agentChipsHtml(['MAIN', 'worker']);
    expect(html).toContain('MA');
    expect(html).toContain('MAIN');
    expect(html).toContain('WO');
    expect(html).toContain('WORKER');
  });

  it('escapes a hostile key rather than injecting markup', () => {
    expect(agentChipsHtml(['<img src=x>'])).not.toContain('<img');
  });

  it('is empty for no keys', () => {
    expect(agentChipsHtml([])).toBe('');
  });
});

describe('threadHtml', () => {
  const md = (t: string) => `<p>${t}</p>`;
  const store = (m: ChatMessage[]) => () => m;

  it('renders both sides of the conversation', () => {
    const html = threadHtml(
      ['MAIN'],
      store([msg({ role: 'user', text: 'hola' }), msg({ role: 'agent', text: 'buenas' })]),
      md,
    );
    expect(html).toContain('local-chat-msg user');
    expect(html).toContain('local-chat-msg agent');
    expect(html).toContain('hola');
    expect(html).toContain('buenas');
  });

  it('runs agent text through the markdown renderer', () => {
    const html = threadHtml(['MAIN'], store([msg({ role: 'agent', text: '**fuerte**' })]), md);
    expect(html).toContain('<p>**fuerte**</p>');
  });

  it('escapes user text instead of markdown — the side panel does the same', () => {
    const html = threadHtml(
      ['MAIN'],
      store([msg({ role: 'user', text: '<script>alert(1)</script>' })]),
      md,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('skips a thread with nothing in it', () => {
    expect(threadHtml(['MAIN'], store([]), md)).toBe('');
  });

  it('skips a thread holding only the streaming slot', () => {
    expect(threadHtml(['MAIN'], store([msg({ role: 'agent', text: '' })]), md)).toBe('');
  });

  it('does not repeat a subagent thread present in the unit list', () => {
    // officeChatKeys already filters ephemerals; this pins that the two halves
    // agree — a key list with only MAIN never reads a subagent's transcript.
    const html = threadHtml(
      officeChatKeys([unit({ id: 'MAIN' }), unit({ id: 'S1', ephemeral: true })]),
      (key) => (key === 'MAIN' ? [msg({ role: 'agent', text: 'del padre' })] : []),
      md,
    );
    expect(html).toContain('del padre');
    expect(html).not.toContain('S1');
  });

  it('shows the speaker and the timestamp', () => {
    const html = threadHtml(
      ['MAIN'],
      store([msg({ role: 'agent', text: 'x', timestamp: '09:41' })]),
      md,
    );
    expect(html).toContain('MAIN');
    expect(html).toContain('09:41');
  });

  it('labels the user side as TÚ', () => {
    const html = threadHtml(['MAIN'], store([msg({ role: 'user', text: 'x' })]), md);
    expect(html).toContain('TÚ');
  });
});

describe('emptyStateHtml', () => {
  it('distinguishes an empty office from an idle one', () => {
    expect(emptyStateHtml([])).toContain('Sin agentes');
    expect(emptyStateHtml(['MAIN'])).toContain('Sin actividad');
  });
});
