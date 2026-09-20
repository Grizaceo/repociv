// ─── Agent-session launch contract ──────────────────────────────────────────
// F8 creates an *intentional* RepoCiv session through the existing command bus.
// This module stays DOM-free so the request contract is testable without a HUD.

import { nativeProfileFor, type RepoCivProfile } from '../agentProfile.ts';
import type { CommandDraft } from '../commandSchema.ts';
import type { Unit } from '../types.ts';

export interface AgentSessionDraft {
  profile: RepoCivProfile | null | undefined;
  cityId: string;
  mission: string;
}

export interface AgentSessionCommandInput extends AgentSessionDraft {
  unitId: string;
}

/** A human-readable validation error, or null when the wizard can submit. */
export function validateAgentSessionDraft(draft: AgentSessionDraft): string | null {
  if (!draft.profile?.name.trim()) return 'Elegí un perfil válido.';
  if (!draft.cityId.trim()) return 'Elegí una ciudad del mapa.';
  if (!draft.mission.trim()) return 'Escribí la misión inicial.';
  return null;
}

/** Renderer-compatible type for a registered harness. */
export function unitTypeForProfile(profile: RepoCivProfile): Unit['type'] {
  const types: Record<RepoCivProfile['harness'], Unit['type']> = {
    claude: 'claude',
    codex: 'codex',
    cursor: 'cursor',
    hermes: 'hero',
    openclaw: 'hero',
  };
  return types[profile.harness];
}

/**
 * Canonical F1 backend contract. It deliberately carries a city id, not a
 * repoPath/cwd: the bridge resolves paths only from its selected RepoCiv roots.
 */
export function buildAgentSessionCommand(input: AgentSessionCommandInput): CommandDraft {
  const error = validateAgentSessionDraft(input);
  if (error) throw new Error(error);
  const profile = input.profile!;
  const cityId = input.cityId.trim();
  return {
    type: 'execute_agent',
    target: cityId,
    payload: {
      unit: input.unitId,
      city: cityId,
      mission: input.mission.trim(),
      agentType: unitTypeForProfile(profile),
      harness: profile.harness,
      provider: profile.provider ?? '',
      model: profile.model ?? '',
      profile: nativeProfileFor(profile),
    },
    created_by: 'agent-session-wizard',
  };
}
