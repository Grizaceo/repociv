// Approval cards display server-confirmed outcomes, never optimistic success.
import { updateCommandStatus } from '../commandBus.ts';

export type ApprovalOutcome = 'approved' | 'rejected' | 'expired' | 'unavailable';

export function settleApprovalCard(card: HTMLElement, outcome: ApprovalOutcome): void {
  if (card.dataset['approvalOutcome'] === 'expired' && outcome !== 'expired') return;
  card.dataset['approvalOutcome'] = outcome;
  const strip = card.querySelector<HTMLElement>('.approval-strip');
  if (!strip) return;
  strip.querySelector('.approval-actions')?.remove();
  strip.querySelector('.approval-result')?.remove();
  const approved = outcome === 'approved';
  const color = approved ? 'var(--civ-food)' : 'var(--civ-happiness)';
  const result = document.createElement('span');
  result.className = 'approval-result';
  result.style.color = color;
  result.textContent = {
    approved: '✓ Aprobado',
    rejected: '✗ Rechazado',
    expired: '⌛ Vencida — no ejecutada',
    unavailable: '— Ya no pendiente / no confirmado',
  }[outcome];
  strip.appendChild(result);
  const icon = strip.querySelector<HTMLElement>('.approval-icon');
  if (icon) {
    icon.textContent = approved ? '✓' : outcome === 'expired' ? '⌛' : '✗';
    icon.style.setProperty('color', color);
  }
}

export function expireApproval(commandId: string): void {
  updateCommandStatus(commandId, 'rejected');
  for (const card of document.querySelectorAll<HTMLElement>('.chat-approval-card')) {
    if (card.dataset['commandId'] === commandId) settleApprovalCard(card, 'expired');
  }
}

/** Reconcile missed terminal events after reconnect using the existing poll. */
export function reconcileApprovalCards(pendingIds: ReadonlySet<string>): void {
  for (const card of document.querySelectorAll<HTMLElement>('.chat-approval-card')) {
    const id = card.dataset['commandId'];
    if (id && !pendingIds.has(id) && !card.dataset['approvalOutcome']) {
      settleApprovalCard(card, 'unavailable');
    }
  }
}
