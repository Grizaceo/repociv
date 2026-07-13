import { expect, test } from '@playwright/test';
import { dirname } from 'node:path';

const bridgeBase = `http://127.0.0.1:${process.env.BRIDGE_PORT ?? '5274'}`;
const token = process.env.REPOCIV_TOKEN ?? '';
const repoPath = process.cwd();
const rootPath = dirname(repoPath);

type CommandEvidence = {
  terminalEvent?: { type?: string; data?: { repoPath?: string } };
  runState?: { runtimeId?: string; status?: string; result?: string };
};

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

  const realCommand = await request.post(`${bridgeBase}/commands`, {
    headers,
    data: {
      type: 'execute_agent',
      target: 'repociv',
      risk: 'low',
      payload: {
        unit: 'WORKER',
        city: encodeRepoId(repoPath),
        repoPath,
        mission: 'inspect selected repo through real fixture subprocess',
        harness: 'fixture',
      },
    },
  });
  expect(realCommand.ok()).toBeTruthy();
  const realBody = await realCommand.json();
  expect(realBody.status).toBe('waiting_approval');
  const realId = realBody.commandId as string;
  expect(realId).toBeTruthy();

  const approval = await request.post(`${bridgeBase}/approvals/${realId}/approve`, {
    headers,
    data: {},
  });
  expect(approval.ok()).toBeTruthy();
  expect((await approval.json()).status).toBe('queued');

  let realEvidence: CommandEvidence | undefined;
  await expect
    .poll(async () => {
      const response = await request.get(`${bridgeBase}/commands/${realId}/artifacts`, {
        headers,
      });
      if (!response.ok()) return '';
      realEvidence = await response.json();
      return realEvidence?.terminalEvent?.type ?? '';
    })
    .toBe('CommandCompleted');

  expect(realEvidence?.runState?.runtimeId).toBe('fixture');
  expect(realEvidence?.runState?.status).toBe('completed');
  expect(realEvidence?.runState?.result).toContain('FIXTURE_AGENT_EXECUTED');
  expect(realEvidence?.runState?.result).toContain('mission=inspect selected repo');
  expect(realEvidence?.terminalEvent?.data?.repoPath).toBe(repoPath);

  await expect
    .poll(async () => {
      const response = await request.get(`${bridgeBase}/missions/${realId}/tree`, { headers });
      if (!response.ok()) return '';
      const tree = await response.json();
      if (tree.mission?.repo !== repoPath) return '';
      return tree.mission?.outcome ?? '';
    })
    .toBe('success');

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

  const evidenceRow = page.locator(`.tl-entry[data-cmd="${realId}"]`);
  await expect(evidenceRow).toBeVisible();
  const evidenceButton = evidenceRow.locator('.tl-evidence-btn');
  await evidenceButton.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(evidenceRow.locator('.tl-evidence')).toContainText('artifactRefs');
  await expect(evidenceRow.locator('.tl-evidence')).toContainText('runState');

  const cancelled = await request.get(`${bridgeBase}/commands/${waitingId}/artifacts`, { headers });
  expect(cancelled.ok()).toBeTruthy();
  expect((await cancelled.json()).terminalEvent.type).toBe('CommandRejected');
});
