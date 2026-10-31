// ─── RepoCiv — City panel: last completed mission ────────────────────────────
// The "ÚLTIMAS MISIONES" section used to render only active buildings because
// Mission records carried no cityId. Now the panel also shows the most recent
// completed/failed mission for the city.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { City } from '../types.ts';
import type { Mission } from '../game.ts';
import { openCityPanel } from './city.ts';

vi.mock('../bridge.ts', () => ({ getLatestNews: vi.fn(), markNewsAsRead: vi.fn() }));
vi.mock('./focusTrap.ts', () => ({ trapFocus: () => () => {} }));
vi.mock('./analytics.ts', () => ({ trackCityVisit: () => {} }));
vi.mock('./chat/panel.ts', () => ({ loadFilesInfo: vi.fn(), loadGitInfo: vi.fn() }));

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
  for (const id of ['city-panel', 'city-missions-list']) {
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

const city = { id: 'c1', name: 'taskforge', population: 3 } as City;
const doneMission = {
  id: 'm1',
  unit: 'SCOUT-1',
  questName: 'Auditar bridge.py',
  status: 'complete',
  startedAt: 1,
  completedAt: 2,
  cityId: 'c1',
} as Mission;

afterEach(() => vi.unstubAllGlobals());

describe('city panel — últimas misiones', () => {
  it('shows the last finished mission when nothing is active', () => {
    const elements = installDom();
    openCityPanel(city, [], undefined, doneMission);
    const html = elements.get('city-missions-list')!.innerHTML;
    expect(html).toContain('Auditar bridge.py');
    expect(html).toContain('✓');
    expect(html).not.toContain('Sin misiones activas');
  });

  it('keeps active entries and appends the last finished mission', () => {
    const elements = installDom();
    const active = { cityId: 'c1', name: 'build daemon', state: 'building', progress: 40 } as never;
    openCityPanel(city, [active], undefined, doneMission);
    const html = elements.get('city-missions-list')!.innerHTML;
    expect(html).toContain('build daemon');
    expect(html).toContain('Auditar bridge.py');
  });

  it('keeps the empty state when there is nothing to show', () => {
    const elements = installDom();
    openCityPanel(city, []);
    expect(elements.get('city-missions-list')!.innerHTML).toContain('Sin misiones activas');
  });
});
