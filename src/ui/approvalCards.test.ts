import { afterEach, describe, expect, it, vi } from 'vitest';
import { expireApproval, reconcileApprovalCards, settleApprovalCard } from './approvalCards.ts';
import { parseBridgeEvent } from '../bridgeSchema.ts';
import { dispatchBridgeEvent, type MessageContext } from '../bridgeMessageHandlers.ts';

vi.mock('../commandBus.ts', () => ({ updateCommandStatus: vi.fn() }));

function fakeCard(commandId: string) {
  const nodes = new Map<string, unknown>();
  const actions = { remove: vi.fn(() => nodes.delete('.approval-actions')) };
  const icon = { textContent: '', style: { setProperty: vi.fn() } };
  const strip = {
    querySelector: (selector: string) => nodes.get(selector) ?? null,
    appendChild: vi.fn((node: unknown) => nodes.set('.approval-result', node)),
  };
  nodes.set('.approval-actions', actions);
  nodes.set('.approval-icon', icon);
  const card = {
    dataset: { commandId } as Record<string, string>,
    querySelector: (selector: string) => (selector === '.approval-strip' ? strip : null),
  };
  return { card: card as unknown as HTMLElement, nodes, actions, icon, strip };
}

function installDocument(cards: HTMLElement[]) {
  vi.stubGlobal('document', {
    querySelectorAll: () => cards,
    createElement: () => ({
      className: '',
      textContent: '',
      style: { color: '' },
      remove: vi.fn(),
    }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('approval expiry UI contract', () => {
  it('validates the server event and rejects incomplete expiry events', () => {
    expect(
      parseBridgeEvent({ type: 'approval_expired', commandId: 'p1', reason: 'approval expired' }),
    ).toEqual({ type: 'approval_expired', commandId: 'p1', reason: 'approval expired' });
    expect(parseBridgeEvent({ type: 'approval_expired', reason: 'approval expired' })).toBeNull();
  });

  it('dispatches expiry to the UI callback, without approving', () => {
    const expire = vi.fn();
    const approve = vi.fn();
    const ctx = { expireApproval: expire, approveCommand: approve } as unknown as MessageContext;
    dispatchBridgeEvent(ctx, {
      type: 'approval_expired',
      commandId: 'p1',
      reason: 'approval expired',
    });
    expect(expire).toHaveBeenCalledWith('p1');
    expect(approve).not.toHaveBeenCalled();
  });

  it('closes only the exact expired card and never overwrites expiry with success', () => {
    const expired = fakeCard('p1');
    const other = fakeCard('p1-extra');
    installDocument([expired.card, other.card]);
    expireApproval('p1');
    expect(expired.actions.remove).toHaveBeenCalledOnce();
    expect(other.actions.remove).not.toHaveBeenCalled();
    expect(expired.card.dataset['approvalOutcome']).toBe('expired');
    expect((expired.nodes.get('.approval-result') as HTMLElement).textContent).toContain(
      'no ejecutada',
    );
    settleApprovalCard(expired.card, 'approved');
    expect(expired.card.dataset['approvalOutcome']).toBe('expired');
  });

  it('reconciles a missed event without pretending an absent command was approved', () => {
    const gone = fakeCard('gone');
    const pending = fakeCard('pending');
    installDocument([gone.card, pending.card]);
    reconcileApprovalCards(new Set(['pending']));
    expect(gone.card.dataset['approvalOutcome']).toBe('unavailable');
    expect((gone.nodes.get('.approval-result') as HTMLElement).textContent).not.toContain(
      'Aprobado',
    );
    expect(pending.actions.remove).not.toHaveBeenCalled();
  });

  it('does not overwrite a confirmed result during reconciliation', () => {
    const approved = fakeCard('p1');
    installDocument([approved.card]);
    settleApprovalCard(approved.card, 'approved');
    reconcileApprovalCards(new Set());
    expect(approved.card.dataset['approvalOutcome']).toBe('approved');
  });
});
