import { afterEach, describe, expect, it, vi } from 'vitest';
import type { City } from '../types.ts';
import { openCityPanel } from './city.ts';
import { loadFilesInfo, loadGitInfo } from './chat/panel.ts';

vi.mock('../bridge.ts', () => ({ getLatestNews: vi.fn(), markNewsAsRead: vi.fn() }));
vi.mock('./focusTrap.ts', () => ({ trapFocus: () => () => {} }));
vi.mock('./analytics.ts', () => ({ trackCityVisit: () => {} }));

function installDom() {
  const elements = new Map<
    string,
    {
      innerHTML: string;
      textContent: string;
      dataset: Record<string, string>;
      classList: { contains: () => boolean; remove: () => void };
    }
  >();
  for (const id of [
    'city-panel',
    'city-git-details',
    'city-files-list',
    'git-info',
    'files-info',
  ]) {
    elements.set(id, {
      innerHTML: '',
      textContent: '',
      dataset: {},
      classList: { contains: () => false, remove: () => {} },
    });
  }
  vi.stubGlobal('document', { getElementById: (id: string) => elements.get(id) ?? null });
  return elements;
}

const git = { branch: 'main', lastCommit: 'abc|commit|today', changes: [] };
const files = { files: ['second.txt'] };
afterEach(() => vi.unstubAllGlobals());

describe('city repository references', () => {
  it.each([
    [{ id: 'repo:encoded', name: 'api', repoPath: '/b/api' }, '%2Fb%2Fapi'],
    [{ id: 'legacy-api', name: 'api' }, 'legacy-api'],
  ])('loads city panel git and files by repository reference', async (city, expected) => {
    const elements = installDom();
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url.startsWith('/api/git/') ? git : files),
    }));
    vi.stubGlobal('fetch', fetchMock);
    openCityPanel({ ...city, population: 0 } as City, []);
    await vi.waitFor(() =>
      expect(elements.get('city-files-list')?.innerHTML).toContain('second.txt'),
    );
    expect(fetchMock).toHaveBeenCalledWith(`/api/git/${expected}`);
    expect(fetchMock).toHaveBeenCalledWith(`/api/files/${expected}`);
    expect(
      [...elements.values()].map((el) => el.innerHTML + el.textContent).join(''),
    ).not.toContain('/b/api');
  });

  it.each([
    [{ id: 'repo:encoded', name: 'api', repoPath: '/b/api' }, '%2Fb%2Fapi'],
    [{ id: 'legacy-api', name: 'api' }, 'legacy-api'],
  ])(
    'loads side tabs by repository reference without displaying the path',
    async (city, expected) => {
      const elements = installDom();
      const fetchMock = vi.fn(async (url: string) => ({
        ok: true,
        json: async () => (url.startsWith('/api/git/') ? git : files),
      }));
      vi.stubGlobal('fetch', fetchMock);
      await loadGitInfo(city);
      await loadFilesInfo(city);
      expect(fetchMock).toHaveBeenCalledWith(`/api/git/${expected}`);
      expect(fetchMock).toHaveBeenCalledWith(`/api/files/${expected}`);
      expect(
        [...elements.values()].map((el) => el.innerHTML + el.textContent).join(''),
      ).not.toContain('/b/api');
    },
  );
});
