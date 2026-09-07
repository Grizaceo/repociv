import { describe, expect, it } from 'vitest';
import { basenameFromPath, findCityByWonderSelection, findNearbyCities } from './cityLookup.ts';

const cities = [
  {
    id: 'workspace__repociv',
    name: 'RepoCiv',
    repoPath: '/workspace/repos/repociv',
  },
  {
    id: 'workspace__agent-lab',
    name: 'Agent Lab',
    repoPath: '/workspace/repos/agent-lab',
  },
];

describe('cityLookup', () => {
  it('matches cities by exact repo path and basename fallback', () => {
    expect(
      findCityByWonderSelection(cities, 'missing-id', '/workspace/repos/repociv/src/main.ts'),
    )?.toMatchObject({ id: 'workspace__repociv' });

    expect(findCityByWonderSelection(cities, 'agent-lab'))?.toMatchObject({
      id: 'workspace__agent-lab',
    });
  });

  it('returns nearby matches instead of failing silently', () => {
    const nearby = findNearbyCities(cities, 'repocv');
    expect(nearby.length).toBeGreaterThan(0);
    expect(nearby[0]?.city.id).toBe('workspace__repociv');
  });

  it('extracts basenames from linux and windows paths', () => {
    expect(basenameFromPath('/tmp/foo/bar/')).toBe('bar');
    expect(basenameFromPath('C:\\Users\\gris\\repo')).toBe('repo');
  });
});
