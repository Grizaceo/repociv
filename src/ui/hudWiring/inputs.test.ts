import { describe, expect, it } from 'vitest';

import { buildExecuteAgentPayload } from './executeAgentPayload.ts';

describe('buildExecuteAgentPayload', () => {
  it('includes the selected city canonical repoPath', () => {
    expect(
      buildExecuteAgentPayload(
        {
          id: 'repo:abc',
          name: 'repo-a',
          repoPath: '/workspace/repo-a',
        },
        'WORKER',
        'Implement the task',
        'claude',
        'sonnet',
      ),
    ).toMatchObject({
      city: 'repo:abc',
      repoPath: '/workspace/repo-a',
      unit: 'WORKER',
      mission: 'Implement the task',
      harness: 'claude',
      model: 'sonnet',
    });
  });

  it('keeps repo-less MAIN conversation explicit', () => {
    expect(buildExecuteAgentPayload(null, 'MAIN', 'Explain status', 'hermes', '')).toMatchObject({
      city: 'main',
      repoPath: '',
      unit: 'MAIN',
      mission: 'Explain status',
      harness: 'hermes',
    });
  });
});
