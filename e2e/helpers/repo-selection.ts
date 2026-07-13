import type { Page } from '@playwright/test';

export async function syncServerRepoSelection(page: Page, selectedRepoPaths: string[]) {
  const firstPath = selectedRepoPaths[0];
  if (!firstPath) throw new Error('Cannot sync an empty RepoCiv selection');

  const separator = Math.max(firstPath.lastIndexOf('/'), firstPath.lastIndexOf('\\'));
  const rootPath = separator > 0 ? firstPath.slice(0, separator) : firstPath;
  const probe = await page.request.get('/api/repos');
  if (!probe.ok()) throw new Error(`RepoCiv origin probe failed (${probe.status()})`);
  const origin = new URL(probe.url()).origin;
  const response = await page.request.post('/api/repo-selections', {
    headers: { Origin: origin },
    data: { rootPath, selectedRepoPaths },
  });
  if (!response.ok()) {
    throw new Error(
      `RepoCiv selection sync failed (${response.status()}): ${await response.text()}`,
    );
  }
}
