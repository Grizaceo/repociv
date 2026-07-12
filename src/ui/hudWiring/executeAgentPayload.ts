import type { City } from '../../types.ts';

export function buildExecuteAgentPayload(
  city: (Pick<City, 'id' | 'name'> & { repoPath?: string }) | null,
  unit: string,
  mission: string,
  harness = '',
  model = '',
  provider = '',
  agentType = '',
): Record<string, unknown> {
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
  return payload;
}
