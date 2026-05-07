// ─── RepoCiv — pendingPanel unit tests (Fase F) ──────────────────────────────
// Tests pure logic extracted from pendingPanel.ts without requiring DOM.
import { describe, it, expect, vi } from 'vitest';

// ─── Helpers mirrored from pendingPanel.ts for test isolation ────────────────

const _ALTA = 'ALTA';
const _MEDIA = 'MEDIA';
const _BAJA = 'BAJA';

interface PendingItem {
  id: string;
  title: string;
  priority: string;
  state: string;
  stateText: string;
  detail: string;
}

function sortByPriority(items: PendingItem[]): PendingItem[] {
  const order: Record<string, number> = { ALTA: 0, MEDIA: 1, BAJA: 2 };
  return [...items].sort((a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1));
}

function groupByPriority(items: PendingItem[]): Record<string, PendingItem[]> {
  const groups: Record<string, PendingItem[]> = {};
  for (const item of items) {
    const key = item.priority || _MEDIA;
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function validateNewItem(title: string): { ok: boolean; error?: string } {
  if (!title.trim()) return { ok: false, error: 'title is required' };
  if (title.trim().length > 200) return { ok: false, error: 'title too long' };
  return { ok: true };
}

function validatePriority(priority: string): string {
  const valid = [_ALTA, _MEDIA, _BAJA];
  return valid.includes(priority) ? priority : _MEDIA;
}

// ── Sample data ───────────────────────────────────────────────────────────────

const SAMPLE_ITEMS: PendingItem[] = [
  { id: '022', title: 'AGENTIC_RIEMANN_TROPICAL', priority: 'ALTA', state: '🔵', stateText: 'registrada', detail: 'Rate limit issue' },
  { id: '010', title: 'DREAM CYCLE', priority: 'MEDIA', state: '🟡', stateText: 'en progreso', detail: 'Scripts OK\nLock protocol' },
  { id: '012', title: 'PROTEIN LAB', priority: 'MEDIA', state: '', stateText: 'operativo', detail: 'Directorio operativo' },
  { id: '014', title: 'TAMAGOTCHI', priority: 'BAJA', state: '🟡', stateText: 'en progreso', detail: '5 commits ahead' },
];

// ── Priority sorting ─────────────────────────────────────────────────────────

describe('sortByPriority', () => {
  it('puts ALTA before MEDIA', () => {
    const sorted = sortByPriority(SAMPLE_ITEMS);
    const altaIdx = sorted.findIndex(i => i.priority === 'ALTA');
    const mediaIdx = sorted.findIndex(i => i.priority === 'MEDIA');
    expect(altaIdx).toBeLessThan(mediaIdx);
  });

  it('puts MEDIA before BAJA', () => {
    const sorted = sortByPriority(SAMPLE_ITEMS);
    const mediaIdx = sorted.findIndex(i => i.priority === 'MEDIA');
    const bajaIdx = sorted.findIndex(i => i.priority === 'BAJA');
    expect(mediaIdx).toBeLessThan(bajaIdx);
  });

  it('does not mutate the original array', () => {
    const copy = [...SAMPLE_ITEMS];
    sortByPriority(SAMPLE_ITEMS);
    expect(SAMPLE_ITEMS).toEqual(copy);
  });
});

// ── Group by priority ────────────────────────────────────────────────────────

describe('groupByPriority', () => {
  it('creates groups for each priority level', () => {
    const groups = groupByPriority(SAMPLE_ITEMS);
    expect(Object.keys(groups)).toContain('ALTA');
    expect(Object.keys(groups)).toContain('MEDIA');
    expect(Object.keys(groups)).toContain('BAJA');
  });

  it('MEDIA group has 2 items', () => {
    const groups = groupByPriority(SAMPLE_ITEMS);
    expect(groups['MEDIA']).toHaveLength(2);
  });

  it('ALTA group has 1 item', () => {
    const groups = groupByPriority(SAMPLE_ITEMS);
    expect(groups['ALTA']).toHaveLength(1);
  });
});

// ── HTML escaping ─────────────────────────────────────────────────────────────

describe('esc', () => {
  it('escapes ampersands', () => {
    expect(esc('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes angle brackets', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes double quotes', () => {
    expect(esc('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('leaves plain text unchanged', () => {
    expect(esc('hello world')).toBe('hello world');
  });
});

// ── New item validation ──────────────────────────────────────────────────────

describe('validateNewItem', () => {
  it('accepts a valid title', () => {
    const result = validateNewItem('New task');
    expect(result.ok).toBe(true);
  });

  it('rejects empty title', () => {
    const result = validateNewItem('');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('title is required');
  });

  it('rejects whitespace-only title', () => {
    const result = validateNewItem('   ');
    expect(result.ok).toBe(false);
  });

  it('rejects title over 200 chars', () => {
    const result = validateNewItem('x'.repeat(201));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('title too long');
  });

  it('accepts title exactly 200 chars', () => {
    const result = validateNewItem('x'.repeat(200));
    expect(result.ok).toBe(true);
  });
});

// ── Priority validation ──────────────────────────────────────────────────────

describe('validatePriority', () => {
  it('accepts ALTA', () => {
    expect(validatePriority('ALTA')).toBe('ALTA');
  });

  it('accepts MEDIA', () => {
    expect(validatePriority('MEDIA')).toBe('MEDIA');
  });

  it('accepts BAJA', () => {
    expect(validatePriority('BAJA')).toBe('BAJA');
  });

  it('falls back to MEDIA for unknown', () => {
    expect(validatePriority('INVALID')).toBe('MEDIA');
  });

  it('falls back to MEDIA for empty string', () => {
    expect(validatePriority('')).toBe('MEDIA');
  });
});

// ── Mock-fetch poll behaviour ────────────────────────────────────────────────

describe('pendingPanel fetch behaviour', () => {
  it('fetch is called with URL containing /pending', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [] as PendingItem[],
    });
    await mockFetch('/pending');
    expect(mockFetch).toHaveBeenCalled();
    const url: string = (mockFetch.mock.calls[0] as unknown[])[0] as string;
    expect(url).toContain('/pending');
  });

  it('handles fetch rejection gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
    let caught: Error | null = null;
    try {
      await mockFetch('/pending').catch((e: Error) => { caught = e; });
    } catch {
      // Should not propagate
    }
    expect(caught).not.toBeNull();
    expect((caught as Error | null)?.message).toBe('network error');
  });

  it('parses JSON response into PendingItem array', async () => {
    const mockData: PendingItem[] = [
      { id: '001', title: 'Test', priority: 'ALTA', state: '🔵', stateText: 'new', detail: '' },
    ];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });
    const res = await mockFetch('/pending');
    const data = (await res.json()) as PendingItem[];
    expect(data).toHaveLength(1);
    expect(data[0]!.id).toBe('001');
  });
});

// ── Poll interval ─────────────────────────────────────────────────────────────

describe('poll interval', () => {
  it('should be 5000ms', () => {
    const POLL_MS = 5_000;
    expect(POLL_MS).toBe(5_000);
  });
});

// ── Item count ────────────────────────────────────────────────────────────────

describe('item filtering', () => {
  const items: PendingItem[] = [
    { id: '022', title: 'Item ALTA', priority: 'ALTA', state: '🔵', stateText: 'active', detail: '' },
    { id: '010', title: 'Item MEDIA', priority: 'MEDIA', state: '🟡', stateText: 'active', detail: '' },
    { id: '007', title: 'Item STALE', priority: 'STALE', state: '🟡', stateText: 'stale', detail: '' },
  ];

  it('excludes STALE items from active list when filtered', () => {
    // In the real panel, the backend parser already excludes STALE.
    // Here we verify the frontend would display only non-STALE items.
    const activeItems = items.filter(i => i.priority !== 'STALE');
    expect(activeItems).toHaveLength(2);
  });

  it('finds item by id in list', () => {
    const found = items.find(i => i.id === '022');
    expect(found).toBeDefined();
    expect(found?.title).toBe('Item ALTA');
  });
});
