import type { City } from '../../types.ts';

export function buildExecuteAgentPayload(
  city: (Pick<City, 'id' | 'name' | 'repoPath'> & { repoPath?: string }) | null,
  unit: string,
  mission: string,
  harness = '',
  model = '',
  provider = '',
  agentType = '',
): Record<string, unknown> {
  // Always send a real repoPath when the city has one. The backend rejects
  // execute_agent with `requires repoPath for non-MAIN or CLI harnesses`
  // when target isn't MAIN and repoPath is empty — leaving dispatch silently
  // dropped on the bridge floor. Pass an empty string only when there's
  // nothing else to send; the backend's schema will accept MAIN targets
  // with empty repoPath.
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
