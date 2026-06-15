// ─── pickerLogic.ts unit tests ───────────────────────────────────────────────
// Pure data-in → data-out tests — no DOM, no localStorage (node vitest env).

import { describe, it, expect } from 'vitest';
import {
  parseSlash,
  classifyModelArgs,
  buildHarnessOptions,
  buildProviderOptions,
  buildModelOptions,
  filterOptions,
  firstSelectableIndex,
  moveCursor,
  digitToIndex,
  type RawHarness,
  type RawProvider,
  type CurrentSelection,
  type PickerOption,
} from './pickerLogic.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const HARNESSES: RawHarness[] = [
  { id: 'hermes', name: 'Hermes', available: true },
  { id: 'claude-code', name: 'Claude Code', available: true },
  { id: 'cursor', name: 'Cursor', available: false },
];

const PROVIDERS: RawProvider[] = [
  {
    id: 'openai-api',
    name: 'OpenAI',
    available: true,
    defaultModel: 'gpt-4o',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', reachable: true },
      { id: 'gpt-3.5', name: 'GPT-3.5', reachable: false },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    available: true,
    defaultModel: 'claude-opus-4-8',
    models: [
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', reachable: true },
      { id: 'claude-haiku', name: 'Claude Haiku', reachable: true },
    ],
  },
  {
    id: 'xai',
    name: 'xAI',
    available: false, // not configured — skipped in model list
    defaultModel: 'grok',
    models: [{ id: 'grok', name: 'Grok', reachable: false }],
  },
];

const NO_SELECTION: CurrentSelection = { harness: '', provider: '', model: '' };

// ─── parseSlash ────────────────────────────────────────────────────────────

describe('parseSlash', () => {
  it('returns null for non-slash text', () => {
    expect(parseSlash('hello world')).toBeNull();
    expect(parseSlash('  not a command')).toBeNull();
  });

  it('parses a bare command', () => {
    expect(parseSlash('/model')).toEqual({ cmd: 'model', args: '' });
  });

  it('lowercases the command and keeps args verbatim', () => {
    expect(parseSlash('/MODEL gpt-4o')).toEqual({ cmd: 'model', args: 'gpt-4o' });
  });

  it('joins multiple args with a single space', () => {
    expect(parseSlash('/model  openai   gpt-4o ')).toEqual({
      cmd: 'model',
      args: 'openai gpt-4o',
    });
  });

  it('trims leading whitespace before the slash', () => {
    expect(parseSlash('   /harness')).toEqual({ cmd: 'harness', args: '' });
  });
});

// ─── classifyModelArgs ───────────────────────────────────────────────────────

describe('classifyModelArgs', () => {
  const isProvider = (id: string) => ['openai-api', 'anthropic', 'ollama-cloud'].includes(id);

  it('opens the picker (no filter) for empty args', () => {
    expect(classifyModelArgs('', isProvider)).toEqual({ kind: 'picker', filter: '' });
  });

  it('opens the picker seeded with a single-token filter', () => {
    expect(classifyModelArgs('gpt', isProvider)).toEqual({ kind: 'picker', filter: 'gpt' });
  });

  it('applies a real provider+model pair', () => {
    expect(classifyModelArgs('ollama-cloud deepseek-v4-pro', isProvider)).toEqual({
      kind: 'apply',
      provider: 'ollama-cloud',
      model: 'deepseek-v4-pro',
    });
  });

  it('joins a multi-word model id', () => {
    expect(classifyModelArgs('anthropic claude opus 4 8', isProvider)).toEqual({
      kind: 'apply',
      provider: 'anthropic',
      model: 'claude opus 4 8',
    });
  });

  it('falls back to the picker when the first token is not a known provider', () => {
    // "gpt 4o" → no provider → filter, not a cryptic error
    expect(classifyModelArgs('gpt 4o', isProvider)).toEqual({ kind: 'picker', filter: 'gpt 4o' });
  });
});

// ─── buildHarnessOptions ─────────────────────────────────────────────────────

describe('buildHarnessOptions', () => {
  it('prepends an Auto option', () => {
    const opts = buildHarnessOptions(HARNESSES, NO_SELECTION);
    expect(opts[0]!.id).toBe('auto');
    expect(opts[0]!.current).toBe(true); // empty selection → auto is current
  });

  it('marks unavailable harnesses disabled + off', () => {
    const opts = buildHarnessOptions(HARNESSES, NO_SELECTION);
    const cursor = opts.find((o) => o.id === 'cursor')!;
    expect(cursor.disabled).toBe(true);
    expect(cursor.status).toBe('off');
  });

  it('marks the active harness as current', () => {
    const opts = buildHarnessOptions(HARNESSES, { harness: 'hermes', provider: '', model: '' });
    expect(opts.find((o) => o.id === 'hermes')!.current).toBe(true);
    expect(opts[0]!.current).toBe(false); // auto no longer current
  });
});

// ─── buildProviderOptions ────────────────────────────────────────────────────

describe('buildProviderOptions', () => {
  it('prepends an Auto option', () => {
    const opts = buildProviderOptions(PROVIDERS, NO_SELECTION);
    expect(opts[0]!.id).toBe('auto');
  });

  it('flags a partially-reachable provider as warn', () => {
    const opts = buildProviderOptions(PROVIDERS, NO_SELECTION);
    expect(opts.find((o) => o.id === 'openai-api')!.status).toBe('warn'); // one of two reachable
  });

  it('flags a fully-reachable provider as ok', () => {
    const opts = buildProviderOptions(PROVIDERS, NO_SELECTION);
    expect(opts.find((o) => o.id === 'anthropic')!.status).toBe('ok');
  });

  it('disables an unavailable provider with no reachable models', () => {
    const opts = buildProviderOptions(PROVIDERS, NO_SELECTION);
    const xai = opts.find((o) => o.id === 'xai')!;
    expect(xai.disabled).toBe(true);
    expect(xai.status).toBe('off');
  });

  it('marks the active provider as current', () => {
    const opts = buildProviderOptions(PROVIDERS, {
      harness: '',
      provider: 'anthropic',
      model: '',
    });
    expect(opts.find((o) => o.id === 'anthropic')!.current).toBe(true);
  });
});

// ─── buildModelOptions ───────────────────────────────────────────────────────

describe('buildModelOptions', () => {
  it('lists models only from available providers', () => {
    const opts = buildModelOptions(PROVIDERS, NO_SELECTION);
    expect(opts.some((o) => o.provider === 'xai')).toBe(false); // xai unavailable
    expect(opts.map((o) => o.id)).toEqual(['gpt-4o', 'gpt-3.5', 'claude-opus-4-8', 'claude-haiku']);
  });

  it('disables unreachable models but keeps them visible', () => {
    const opts = buildModelOptions(PROVIDERS, NO_SELECTION);
    const dead = opts.find((o) => o.id === 'gpt-3.5')!;
    expect(dead.disabled).toBe(true);
    expect(dead.status).toBe('off');
  });

  it('carries the owning provider id and name', () => {
    const opts = buildModelOptions(PROVIDERS, NO_SELECTION);
    const m = opts.find((o) => o.id === 'claude-opus-4-8')!;
    expect(m.provider).toBe('anthropic');
    expect(m.sublabel).toBe('Anthropic');
  });

  it('treats unknown reachability as a selectable warn row', () => {
    const opts = buildModelOptions(
      [
        {
          id: 'local',
          name: 'Local',
          available: true,
          defaultModel: 'm',
          models: [{ id: 'm', name: 'M' }], // reachable undefined
        },
      ],
      NO_SELECTION,
    );
    expect(opts[0]!.status).toBe('warn');
    expect(opts[0]!.disabled).toBe(false);
  });

  it('marks the active provider+model pair as current', () => {
    const opts = buildModelOptions(PROVIDERS, {
      harness: '',
      provider: 'anthropic',
      model: 'claude-haiku',
    });
    expect(opts.find((o) => o.id === 'claude-haiku')!.current).toBe(true);
    expect(opts.find((o) => o.id === 'gpt-4o')!.current).toBe(false);
  });
});

// ─── filterOptions ───────────────────────────────────────────────────────────

describe('filterOptions', () => {
  const opts = buildModelOptions(PROVIDERS, NO_SELECTION);

  it('returns everything (original order) for an empty query', () => {
    expect(filterOptions(opts, '')).toEqual(opts);
    expect(filterOptions(opts, '   ')).toEqual(opts);
  });

  it('substring-matches across model name, id and provider', () => {
    const r = filterOptions(opts, 'gpt');
    expect(r.map((o) => o.id)).toEqual(['gpt-4o', 'gpt-3.5']);
  });

  it('matches by provider name, preserving declared model order', () => {
    // A provider-name query matches via the search haystack, not the label;
    // the declared order (opus before haiku) must survive — it must not be
    // reordered by label length.
    const r = filterOptions(opts, 'anthropic');
    expect(r.every((o) => o.provider === 'anthropic')).toBe(true);
    expect(r.map((o) => o.id)).toEqual(['claude-opus-4-8', 'claude-haiku']);
  });

  it('ranks a label-prefix match above a mid-string match', () => {
    const r = filterOptions(opts, 'claude');
    // both anthropic models match; both labels start with "Claude" → stable order
    expect(r[0]!.id).toBe('claude-opus-4-8');
  });

  it('falls back to subsequence when no substring matches', () => {
    // "gpo" is not a substring of any haystack but is a subsequence of "gpt-4o"
    const r = filterOptions(opts, 'gpo');
    expect(r.map((o) => o.id)).toContain('gpt-4o');
  });

  it('returns empty when nothing matches', () => {
    expect(filterOptions(opts, 'zzzznotreal')).toEqual([]);
  });
});

// ─── navigation ──────────────────────────────────────────────────────────────

describe('firstSelectableIndex', () => {
  it('skips leading disabled rows', () => {
    const rows: PickerOption[] = [
      { id: 'a', label: 'a', status: 'off', disabled: true, search: 'a' },
      { id: 'b', label: 'b', status: 'ok', search: 'b' },
    ];
    expect(firstSelectableIndex(rows)).toBe(1);
  });

  it('returns -1 when all rows are disabled', () => {
    const rows: PickerOption[] = [
      { id: 'a', label: 'a', status: 'off', disabled: true, search: 'a' },
    ];
    expect(firstSelectableIndex(rows)).toBe(-1);
  });
});

describe('moveCursor', () => {
  const rows: PickerOption[] = [
    { id: 'a', label: 'a', status: 'ok', search: 'a' },
    { id: 'b', label: 'b', status: 'off', disabled: true, search: 'b' },
    { id: 'c', label: 'c', status: 'ok', search: 'c' },
  ];

  it('skips disabled rows moving down', () => {
    expect(moveCursor(0, 1, rows)).toBe(2); // 0 → skip 1 → 2
  });

  it('wraps around the ends', () => {
    expect(moveCursor(2, 1, rows)).toBe(0); // wrap to top
    expect(moveCursor(0, -1, rows)).toBe(2); // wrap to bottom (skipping disabled)
  });

  it('returns -1 for an empty list', () => {
    expect(moveCursor(0, 1, [])).toBe(-1);
  });

  it('returns the same index when every row is disabled', () => {
    const allDisabled: PickerOption[] = [
      { id: 'a', label: 'a', status: 'off', disabled: true, search: 'a' },
    ];
    expect(moveCursor(0, 1, allDisabled)).toBe(0);
  });

  it('lands on an enabled row from the initial -1 cursor', () => {
    // slashPicker seeds cursor = firstSelectableIndex(), which is -1 when the
    // filtered list has no selectable row; the next arrow feeds -1 into
    // moveCursor — it must land on an enabled row, never loop.
    expect(moveCursor(-1, 1, rows)).toBe(0);
    expect(rows[moveCursor(-1, -1, rows)]!.disabled).toBeFalsy();
  });

  it('stays at -1 from -1 when every row is disabled (no infinite loop)', () => {
    const allDisabled: PickerOption[] = [
      { id: 'a', label: 'a', status: 'off', disabled: true, search: 'a' },
      { id: 'b', label: 'b', status: 'off', disabled: true, search: 'b' },
    ];
    expect(moveCursor(-1, 1, allDisabled)).toBe(-1);
  });
});

describe('digitToIndex', () => {
  it('maps 1–9 to 0-based indices', () => {
    expect(digitToIndex('1')).toBe(0);
    expect(digitToIndex('9')).toBe(8);
  });

  it('rejects 0 and non-digits', () => {
    expect(digitToIndex('0')).toBeNull();
    expect(digitToIndex('a')).toBeNull();
    expect(digitToIndex('12')).toBeNull();
  });
});
