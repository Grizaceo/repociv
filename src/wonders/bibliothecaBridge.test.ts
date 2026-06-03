import { describe, expect, it } from 'vitest';
import type { GraphRelationCandidate } from '../bridge.ts';
import {
  basenameFromPath,
  findCityByWonderSelection,
  findNearbyCities,
  rankRelationsWithFeedback,
  relationFeedbackKey,
} from './bibliothecaBridge.ts';

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

describe('bibliothecaBridge', () => {
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

  it('reranks accepted relations above rejected ones', () => {
    const relations: GraphRelationCandidate[] = [
      {
        fromId: 'workspace__repociv',
        fromName: 'RepoCiv',
        toId: 'workspace__agent-lab',
        toName: 'Agent Lab',
        relationType: 'shared_dependency',
        score: 0.4,
        evidence: ['Both depend on vitest'],
        suggestedActions: ['linkear', 'ignorar'],
      },
      {
        fromId: 'workspace__repociv',
        fromName: 'RepoCiv',
        toId: 'workspace__other',
        toName: 'Other',
        relationType: 'conceptual_overlap',
        score: 0.8,
        evidence: ['Shared concepts'],
        suggestedActions: ['linkear', 'ignorar'],
      },
    ];

    const ranked = rankRelationsWithFeedback(relations, {
      [relationFeedbackKey('workspace__repociv', 'workspace__agent-lab')]: {
        accepted: true,
        rejected: false,
      },
      [relationFeedbackKey('workspace__repociv', 'workspace__other')]: {
        accepted: false,
        rejected: true,
      },
    });

    expect(ranked[0]?.toId).toBe('workspace__agent-lab');
    expect(ranked[0]?.accepted).toBe(true);
    expect(ranked[ranked.length - 1]?.toId).toBe('workspace__other');
    expect(ranked[ranked.length - 1]?.rejected).toBe(true);
  });

  it('extracts basenames from linux and windows paths', () => {
    expect(basenameFromPath('/tmp/foo/bar/')).toBe('bar');
    expect(basenameFromPath('C:\\Users\\gris\\repo')).toBe('repo');
  });
});
