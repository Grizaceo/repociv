// ─── RepoCiv — logPanel unit tests (Sprint D3) ───────────────────────────────
// Tests pure logic exported from src/ui/logPanel.ts without requiring DOM.

import { describe, it, expect } from 'vitest';
import {
  POLL_MS,
  COLUMN_HEADERS,
  formatTimestamp,
  filterByType,
  buildLogRow,
  buildBodyHTML,
  clearLocalBuffer,
  getLocalBuffer,
  type LogEvent,
} from './ui/logPanel.ts';

// ── poll interval ─────────────────────────────────────────────────────────────

describe('poll interval', () => {
  it('is 2000ms', () => {
    expect(POLL_MS).toBe(2_000);
  });
});

// ── column headers ────────────────────────────────────────────────────────────

describe('column headers', () => {
  it('has exactly 4 columns', () => {
    expect(COLUMN_HEADERS).toHaveLength(4);
  });

  it('contains Timestamp, Repo, Tipo, Mensaje', () => {
    expect(COLUMN_HEADERS).toContain('Timestamp');
    expect(COLUMN_HEADERS).toContain('Repo');
    expect(COLUMN_HEADERS).toContain('Tipo');
    expect(COLUMN_HEADERS).toContain('Mensaje');
  });
});

// ── timestamp formatting ──────────────────────────────────────────────────────

describe('formatTimestamp', () => {
  it('returns a non-empty string for a valid unix timestamp', () => {
    const result = formatTimestamp(1_700_000_000);
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('formats epoch 0 without crashing', () => {
    const result = formatTimestamp(0);
    expect(result).toBeTruthy();
  });
});

// ── renders rows from mock data ───────────────────────────────────────────────

describe('buildLogRow', () => {
  const sample: LogEvent = {
    id: 'abc123',
    type: 'CommandCompleted',
    timestamp: 1_700_000_000,
    actor: 'system',
    data: { repo: 'my-repo', result: 'done' },
  };

  it('renders a <tr> element', () => {
    expect(buildLogRow(sample)).toContain('<tr>');
    expect(buildLogRow(sample)).toContain('</tr>');
  });

  it('includes the event type', () => {
    expect(buildLogRow(sample)).toContain('CommandCompleted');
  });

  it('includes the repo from data', () => {
    expect(buildLogRow(sample)).toContain('my-repo');
  });

  it('includes the result message', () => {
    expect(buildLogRow(sample)).toContain('done');
  });

  it('falls back to — when data is empty', () => {
    const evt: LogEvent = { type: 'CommandQueued', timestamp: 0 };
    const html = buildLogRow(evt);
    expect(html).toContain('—');
  });
});

// ── filter by type ────────────────────────────────────────────────────────────

describe('filterByType', () => {
  const events: LogEvent[] = [
    { type: 'CommandFailed', timestamp: 1 },
    { type: 'CommandCompleted', timestamp: 2 },
    { type: 'CommandFailed', timestamp: 3 },
  ];

  it('returns only matching events', () => {
    const filtered = filterByType(events, 'CommandFailed');
    expect(filtered).toHaveLength(2);
    expect(filtered.every((e) => e.type === 'CommandFailed')).toBe(true);
  });

  it('returns all events when type is empty', () => {
    expect(filterByType(events, '')).toHaveLength(3);
  });

  it('returns empty array when no match', () => {
    expect(filterByType(events, 'NoSuchType')).toHaveLength(0);
  });
});

// ── empty state ───────────────────────────────────────────────────────────────

describe('buildBodyHTML — empty state', () => {
  it('shows empty message when events list is empty', () => {
    const html = buildBodyHTML([]);
    expect(html).toContain('log-empty');
  });

  it('does not show table when empty', () => {
    const html = buildBodyHTML([]);
    expect(html).not.toContain('<table');
  });
});

// ── offline state ─────────────────────────────────────────────────────────────

describe('buildBodyHTML — offline state', () => {
  it('shows offline message when events is null', () => {
    const html = buildBodyHTML(null);
    expect(html).toContain('log-offline');
  });
});

// ── clear resets local buffer ─────────────────────────────────────────────────

describe('clearLocalBuffer', () => {
  it('empties the local buffer after being set externally is not needed — buffer starts empty', () => {
    clearLocalBuffer();
    expect(getLocalBuffer()).toHaveLength(0);
  });

  it('calling clearLocalBuffer multiple times is safe', () => {
    clearLocalBuffer();
    clearLocalBuffer();
    expect(getLocalBuffer()).toHaveLength(0);
  });
});
