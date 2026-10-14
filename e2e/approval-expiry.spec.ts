import { expect, test } from '@playwright/test';

// Real browser + real frontend modules, but no live command or approval writes.
test.beforeEach(async ({ page }) => {
  await page.route('**/__approval-expiry-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="chat-messages" data-active-unit="MAIN"></div></body></html>',
    }),
  );
  await page.goto('/__approval-expiry-test');
  await page.evaluate(async () => {
    const { setActiveChatUnit } = await import('/src/ui/chat/state.ts');
    const { appendApprovalCard } = await import('/src/ui/chat/history.ts');
    setActiveChatUnit('MAIN');
    appendApprovalCard('MAIN', 'pending', 'read_file', 'repo', 'medium');
  });
});

test('expired event removes actions and cannot be overwritten by a late success', async ({
  page,
}) => {
  await expect(page.locator('.approval-approve')).toBeVisible();
  await page.evaluate(async () => {
    const { expireApproval, settleApprovalCard } = await import('/src/ui/approvalCards.ts');
    expireApproval('pending');
    settleApprovalCard(document.querySelector('.chat-approval-card')!, 'approved');
  });
  await expect(page.locator('.chat-approval-card')).toContainText('Vencida — no ejecutada');
  await expect(page.locator('.approval-actions')).toHaveCount(0);
});

test('late HTTP response never paints optimistic approval', async ({ page }) => {
  let release!: () => void;
  const waitForResponse = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/approvals/pending/approve', async (route) => {
    await waitForResponse;
    await route.fulfill({ json: { ok: false, status: 'expired', error: 'approval expired' } });
  });
  await page.locator('.approval-approve').click();
  await expect(page.locator('.approval-approve')).toBeDisabled();
  await expect(page.locator('.chat-approval-card')).not.toContainText('Aprobado');
  release();
  await expect(page.locator('.chat-approval-card')).toContainText('no confirmado');
  await expect(page.locator('.approval-actions')).toHaveCount(0);
});

test('reconnect reconciliation closes a stale card without inventing success', async ({ page }) => {
  await page.evaluate(async () => {
    const { reconcileApprovalCards } = await import('/src/ui/approvalCards.ts');
    reconcileApprovalCards(new Set());
  });
  await expect(page.locator('.chat-approval-card')).toContainText('Ya no pendiente');
  await expect(page.locator('.chat-approval-card')).not.toContainText('Aprobado');
  await expect(page.locator('.approval-actions')).toHaveCount(0);
});
