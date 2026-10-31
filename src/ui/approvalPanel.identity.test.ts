// ─── RepoCiv — approval identity, "Ir al chat" y fanfarria (LOTE D) ─────────
// The panel hid who requested each approval and gave no way to jump to the
// agent. Items now render a requester line plus a navigation affordance, and
// each newly-arriving approval id rings the one-shot fanfare.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ signalApproval: vi.fn(), logEvent: vi.fn() }));
vi.mock('./payoffs.ts', () => ({ signalApproval: m.signalApproval }));
// hud.ts touches window at import time; only logEvent is needed here.
vi.mock('./hud.ts', () => ({ logEvent: m.logEvent }));

import {
  approvalChatRef,
  approvalRequesterLabel,
  diffNewApprovalIds,
  noteApprovalFanfare,
  resetApprovalTrackingForTests,
} from './approvalPanel.ts';

interface Item {
  id: string;
  type: string;
  target: string;
  risk: string;
  payload: Record<string, unknown>;
  created_by: string;
  created_at: number;
}

function item(props: Partial<Item> = {}): Item {
  return {
    id: 'c1',
    type: 'edit_file',
    target: 'src/main.ts',
    risk: 'high',
    payload: {},
    created_by: 'user',
    created_at: 0,
    ...props,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetApprovalTrackingForTests();
});

describe('approvalRequesterLabel', () => {
  it('prefers the unit in the payload over created_by', () => {
    expect(approvalRequesterLabel(item({ payload: { unit: 'SCOUT-1' }, created_by: 'mcp' }))).toBe(
      'SCOUT-1',
    );
  });
  it('falls back to created_by', () => {
    expect(approvalRequesterLabel(item({ created_by: 'codex-1' }))).toBe('codex-1');
  });
});

describe('approvalChatRef', () => {
  it('resolves the unit or session to navigate to', () => {
    expect(approvalChatRef(item({ payload: { unit: 'MAIN' } }))).toBe('MAIN');
    expect(approvalChatRef(item({ payload: { sessionId: 'codex-9' } }))).toBe('codex-9');
    expect(approvalChatRef(item({ created_by: 'ext-1' }))).toBe('ext-1');
    expect(approvalChatRef(item())).toBe('user');
  });
});

describe('approval fanfare — one shot per new id', () => {
  it('rings once for newly arrived ids only', () => {
    expect(diffNewApprovalIds(['a', 'b'])).toEqual(['a', 'b']);
    expect(diffNewApprovalIds(['a', 'b'])).toEqual([]);
    expect(diffNewApprovalIds(['a', 'b', 'c'])).toEqual(['c']);
    expect(diffNewApprovalIds([])).toEqual([]);
    expect(diffNewApprovalIds(['d'])).toEqual(['d']);
  });

  it('noteApprovalFanfare calls signalApproval only for new ids', () => {
    noteApprovalFanfare([item({ id: 'x1' }), item({ id: 'x2' })]);
    expect(m.signalApproval).toHaveBeenCalledTimes(1);
    noteApprovalFanfare([item({ id: 'x1' }), item({ id: 'x2' })]);
    expect(m.signalApproval).toHaveBeenCalledTimes(1);
    noteApprovalFanfare([item({ id: 'x1' }), item({ id: 'x3' })]);
    expect(m.signalApproval).toHaveBeenCalledTimes(2);
  });
});
