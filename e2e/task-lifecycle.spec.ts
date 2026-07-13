import { expect, test } from '@playwright/test';
import { dirname } from 'node:path';

const bridgeBase = `http://127.0.0.1:${process.env.BRIDGE_PORT ?? '5274'}`;
const token = process.env.REPOCIV_TOKEN ?? '';
const repoPath = process.cwd();
const rootPath = dirname(repoPath);

function encodeRepoId(path: string): string {
  return `repo:${Buffer.from(path).toString('base64url')}`;
}

test('canonical task lifecycle exposes evidence and cancellation', async ({ page, request }) => {
  const headers = {
    'Content-Type': 'application/json',
    'X-RepoCiv-Token': token,
  };

  const selection = await request.post('/api/repo-selections', {
    headers,
    data: { rootPath, selectedRepoIds: [encodeRepoId(repoPath)] },
  });
  expect(selection.ok()).toBeTruthy();

  const probe = await request.post(`${bridgeBase}/commands`, {
    headers,
    data: {
      id: 'e2e-evidence-command',
      type: 'e2e_probe',
      target: 'main',
      payload: { unit: 'MAIN', marker: 'timeline-evidence' },
    },
  });
  expect(probe.ok()).toBeTruthy();
  const probeId = (await probe.json()).commandId as string;
  expect(probeId).toBeTruthy();

  await expect
    .poll(async () => {
      const response = await request.get(`${bridgeBase}/commands/${probeId}/artifacts`, {
        headers,
      });
      if (!response.ok()) return '';
      return (await response.json()).terminalEvent?.type ?? '';
    })
    .toBe('CommandCompleted');

  const queued = await request.post(`${bridgeBase}/commands`, {
    headers,
    data: {
      id: 'e2e-waiting-command',
      type: 'execute_agent',
      target: 'repociv',
      risk: 'low',
      payload: {
        unit: 'WORKER',
        city: encodeRepoId(repoPath),
        repoPath,
        mission: 'integration test must remain waiting for approval',
        harness: 'claude',
      },
    },
  });
  expect(queued.status()).toBe(200);
  const queuedBody = await queued.json();
  expect(queuedBody.status).toBe('waiting_approval');
  const waitingId = queuedBody.commandId as string;
  expect(waitingId).toBeTruthy();

  await page.addInitScript(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    localStorage.setItem('repociv:renderer', 'flat');
    localStorage.setItem('repociv:auto-start-wonders', 'false');
  });
  await page.goto('/');
  await expect(page.locator('html[data-app-ready="1"]')).toBeAttached({ timeout: 20_000 });
  await expect(page.locator('#hero-bar-slots .hero-slot').first()).toBeVisible();
  await page.locator('#btn-timeline').click();

  const waitingRow = page.locator(`.tl-entry[data-cmd="${waitingId}"]`);
  await expect(waitingRow).toContainText(waitingId);
  await waitingRow.locator('.tl-cancel-btn').click();
  await expect(waitingRow.locator('.tl-type')).toHaveText('Rejected');
  await expect(waitingRow.locator('.tl-cancel-btn')).toHaveCount(0);

  const evidenceRow = page.locator(`.tl-entry[data-cmd="${probeId}"]`);
  await expect(evidenceRow).toBeVisible();
  const evidenceButton = evidenceRow.locator('.tl-evidence-btn');
  await evidenceButton.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(evidenceRow.locator('.tl-evidence')).toContainText('artifactRefs');
  await expect(evidenceRow.locator('.tl-evidence')).toContainText('runState');

  const cancelled = await request.get(`${bridgeBase}/commands/${waitingId}/artifacts`, { headers });
  expect(cancelled.ok()).toBeTruthy();
  expect((await cancelled.json()).terminalEvent.type).toBe('CommandRejected');
});
