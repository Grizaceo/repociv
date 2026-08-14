import type { City } from '../../types.ts';

export function buildExecuteAgentPayload(
  city: (Pick<City, 'id' | 'name' | 'repoPath'> & { repoPath?: string }) | null,
  unit: string,
  mission: string,
  harness = '',
  model = '',
  provider = '',
  agentType = '',
  profile = '',
): Record<string, unknown> {
  // Always send a real repoPath when the city has one. Chat may target any
  // unit (MAIN/WORKER/SCOUT/…); the bridge allows hermes/auto without a
  // repoPath, but CLI harnesses still require a selected repository.
  const payload: Record<string, unknown> = {
    unit,
    city: city?.id ?? 'main',
    repoPath: city?.repoPath ?? '',
    mission,
  };
  if (agentType) payload['agentType'] = agentType;
  if (harness && harness !== 'auto') payload['harness'] = harness;
  if (provider && provider !== 'auto') payload['provider'] = provider;
  if (model) payload['model'] = model;
  if (profile) payload['profile'] = profile;
  return payload;
}
