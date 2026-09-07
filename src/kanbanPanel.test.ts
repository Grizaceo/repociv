// ─── RepoCiv — kanbanPanel unit tests ────────────────────────────────────────
// Tests pure logic mirrored from kanbanPanel.ts (same pattern as
// pendingPanel.test.ts / taskPanel.test.ts): HTML escaping, column filtering,
// count totals, column labels, and board-select option rendering.

import { describe, expect, it } from 'vitest';

// ─── Helpers mirrored from kanbanPanel.ts for test isolation ────────────────

const COLUMN_LABELS: Record<string, string> = {
  triage: 'Triage',
  todo: 'Por hacer',
  scheduled: 'Programado',
  ready: 'Listo',
  running: 'En curso',
  blocked: 'Bloqueado',
  review: 'Revisión',
  done: 'Hecho',
};

interface KanbanTask {
  id: string;
  title: string;
  status: string;
  assignee: string;
  priority: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  last_failure_error: string | null;
  consecutive_failures: number;
}

interface KanbanBoard {
  slug: string;
  name: string;
  active: boolean;
  available: boolean;
  columns: Record<string, KanbanTask[]>;
}

interface KanbanBoardMeta {
  slug: string;
  name: string;
  counts: Record<string, number>;
}

function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnLabel(status: string): string {
  return COLUMN_LABELS[status] ?? status;
}

function countTotal(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

function nonEmptyColumns(board: KanbanBoard): [string, KanbanTask[]][] {
  return Object.entries(board.columns).filter(([, tasks]) => tasks.length > 0);
}

function renderCard(t: KanbanTask): string {
  const assignee = t.assignee ? `<span class="kb-assignee">${escapeHtml(t.assignee)}</span>` : '';
  const prio = t.priority > 0 ? `<span class="kb-prio">${t.priority}</span>` : '';
  const fail =
    t.consecutive_failures > 0
      ? `<span class="kb-fail" title="${escapeHtml(t.last_failure_error ?? '')}">✗${t.consecutive_failures}</span>`
      : '';
  return `
    <div class="kb-card" data-status="${escapeHtml(t.status)}">
      <div class="kb-card-title">${escapeHtml(t.title)}</div>
      <div class="kb-card-meta">${assignee}${prio}${fail}</div>
    </div>
  `;
}

function renderBoardSelect(boards: KanbanBoardMeta[], currentSlug: string): string {
  return boards
    .map(
      (b) =>
        `<option value="${escapeHtml(b.slug)}" ${b.slug === currentSlug ? 'selected' : ''}>${escapeHtml(b.name)} (${countTotal(b.counts)})</option>`,
    )
    .join('');
}

// ── Sample data ─────────────────────────────────────────────────────────────

const SAMPLE_TASKS: KanbanTask[] = [
  {
    id: 't1',
    title: 'Fix bridge auth',
    status: 'blocked',
    assignee: 'davi',
    priority: 2,
    created_at: 1,
    started_at: null,
    completed_at: null,
    last_failure_error: 'timeout after 30s',
    consecutive_failures: 3,
  },
  {
    id: 't2',
    title: 'Ship kanban panel',
    status: 'todo',
    assignee: '',
    priority: 0,
    created_at: 2,
    started_at: null,
    completed_at: null,
    last_failure_error: null,
    consecutive_failures: 0,
  },
  {
    id: 't3',
    title: 'Write docs <v2> & "final"',
    status: 'done',
    assignee: 'cristobal',
    priority: 1,
    created_at: 3,
    started_at: 3,
    completed_at: 4,
    last_failure_error: null,
    consecutive_failures: 0,
  },
];

const SAMPLE_BOARD: KanbanBoard = {
  slug: 'hackathon-2026',
  name: 'Hackathon 2026',
  active: true,
  available: true,
  columns: {
    todo: [SAMPLE_TASKS[1]!],
    blocked: [SAMPLE_TASKS[0]!],
    done: [SAMPLE_TASKS[2]!],
    review: [],
  },
};

const SAMPLE_BOARDS: KanbanBoardMeta[] = [
  { slug: 'hackathon-2026', name: 'Hackathon 2026', counts: { todo: 1, blocked: 1, done: 1 } },
  { slug: 'cdaily', name: 'CDaily', counts: { todo: 2 } },
];

// ── HTML escaping ─────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('coerces non-strings', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

// ── Column labels ─────────────────────────────────────────────────────────────

describe('columnLabel', () => {
  it('maps known statuses to Spanish labels', () => {
    expect(columnLabel('blocked')).toBe('Bloqueado');
    expect(columnLabel('todo')).toBe('Por hacer');
    expect(columnLabel('done')).toBe('Hecho');
  });

  it('falls back to raw status for unknown columns', () => {
    expect(columnLabel('weird')).toBe('weird');
  });
});

// ── Count totals ─────────────────────────────────────────────────────────────

describe('countTotal', () => {
  it('sums all column counts', () => {
    expect(countTotal({ todo: 1, blocked: 1, done: 1 })).toBe(3);
  });

  it('returns 0 for empty counts', () => {
    expect(countTotal({})).toBe(0);
  });
});

// ── Column filtering ──────────────────────────────────────────────────────────

describe('nonEmptyColumns', () => {
  it('drops empty columns', () => {
    const cols = nonEmptyColumns(SAMPLE_BOARD);
    expect(cols.map(([status]) => status)).toEqual(['todo', 'blocked', 'done']);
  });

  it('keeps task counts intact', () => {
    const cols = nonEmptyColumns(SAMPLE_BOARD);
    expect(cols.find(([s]) => s === 'blocked')?.[1]).toHaveLength(1);
  });
});

// ── Card rendering ─────────────────────────────────────────────────────────────

describe('renderCard', () => {
  it('renders title and assignee', () => {
    const html = renderCard(SAMPLE_TASKS[0]!);
    expect(html).toContain('Fix bridge auth');
    expect(html).toContain('kb-assignee');
    expect(html).toContain('davi');
  });

  it('renders failure badge with escaped title tooltip', () => {
    const html = renderCard(SAMPLE_TASKS[0]!);
    expect(html).toContain('✗3');
    expect(html).toContain('title="timeout after 30s"');
  });

  it('omits assignee/prio/fail when absent', () => {
    const html = renderCard(SAMPLE_TASKS[1]!);
    expect(html).not.toContain('kb-assignee');
    expect(html).not.toContain('kb-prio');
    expect(html).not.toContain('kb-fail');
  });

  it('escapes HTML in title', () => {
    const html = renderCard(SAMPLE_TASKS[2]!);
    expect(html).toContain('&lt;v2&gt;');
    expect(html).toContain('&quot;final&quot;');
    expect(html).not.toContain('<v2>');
  });
});

// ── Board select options ──────────────────────────────────────────────────────

describe('renderBoardSelect', () => {
  it('renders one option per board with total count', () => {
    const html = renderBoardSelect(SAMPLE_BOARDS, 'hackathon-2026');
    expect(html).toContain('Hackathon 2026 (3)');
    expect(html).toContain('CDaily (2)');
  });

  it('marks the current board as selected', () => {
    const html = renderBoardSelect(SAMPLE_BOARDS, 'hackathon-2026');
    expect(html).toContain('value="hackathon-2026" selected');
    expect(html).not.toContain('value="cdaily" selected');
  });

  it('escapes board names', () => {
    const evil: KanbanBoardMeta = { slug: 'x', name: '<b>evil</b>', counts: {} };
    const html = renderBoardSelect([evil], 'x');
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;');
  });
});
