// ─── RepoCiv — BridgeEvent runtime validation (Valibot) ──────────────────────
// Valida cada evento que llega desde bridge.py. Si no parsea, devuelve null
// (el caller decide loguear/descartar). Evita crashes silenciosos por payloads
// mal formados — esta es la frontera de sistema.

import * as v from 'valibot';
import type { BridgeEvent } from './types.ts';

const Hex = v.tuple([v.number(), v.number()]);
const UnitType = v.picklist([
  'hero',
  'worker',
  'scout',
  'army',
  'caravan',
  'lexo',
  'openclaw',
  'claude',
  'codex',
]);
const UnitState = v.picklist(['idle', 'moving', 'working', 'sleeping', 'building']);
const Resource = v.picklist(['gold', 'science', 'production']);
const LogLevel = v.picklist(['info', 'warn', 'success']);
const BuildingKind = v.picklist(['building', 'wonder']);

const Schemas = [
  v.object({
    type: v.literal('unit_spawn'),
    unit: v.string(),
    civ: v.string(),
    hex: Hex,
    mission: v.optional(v.string()),
    unitType: v.optional(UnitType),
    cityId: v.optional(v.string()),
    parentUnit: v.optional(v.string()),
    ephemeral: v.optional(v.boolean()),
    subagentRunId: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('unit_move'),
    unit: v.string(),
    from: Hex,
    to: Hex,
    mission: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('unit_work'),
    unit: v.string(),
    hex: v.optional(Hex),
    progress: v.number(),
    mission: v.optional(v.string()),
    cityId: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('unit_despawn'),
    unit: v.string(),
    mission: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('unit_state'),
    unit: v.string(),
    state: UnitState,
  }),
  v.object({
    type: v.literal('building_start'),
    city: v.string(),
    building: v.string(),
    durationSeconds: v.number(),
    buildingType: v.optional(BuildingKind),
    pid: v.optional(v.number()),
    cmd: v.optional(v.string()),
    missionId: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('building_progress'),
    city: v.string(),
    building: v.string(),
    progress: v.number(),
  }),
  v.object({
    type: v.literal('building_complete'),
    city: v.string(),
    building: v.string(),
    missionId: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('building_failed'),
    city: v.string(),
    building: v.string(),
    missionId: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('city_founder'),
    name: v.string(),
    hex: Hex,
  }),
  v.object({
    type: v.literal('resource_update'),
    resource: Resource,
    delta: v.number(),
  }),
  v.object({
    type: v.literal('fog_reveal'),
    hexes: v.array(Hex),
    sourceSubagentId: v.optional(v.string()),
    cityId: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('subagent_spawn'),
    subagentId: v.string(),
    parentMissionId: v.string(),
    parentUnit: v.string(),
    kind: v.string(),
    label: v.string(),
    hex: Hex,
    unitType: v.optional(UnitType),
    risk: v.string(),
    ephemeralUnitId: v.string(),
    targetCityId: v.optional(v.string()),
    status: v.optional(v.picklist(['proposed', 'running'])),
    parentHarness: v.optional(v.string()),
    harness: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('subagent_progress'),
    subagentId: v.string(),
    phase: v.optional(v.string()),
    text: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('subagent_complete'),
    subagentId: v.string(),
    success: v.boolean(),
    summary: v.string(),
    duration: v.number(),
    ephemeralUnitId: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('subagent_proposed'),
    subagentId: v.string(),
    parentMissionId: v.string(),
    parentUnit: v.string(),
    kind: v.string(),
    label: v.string(),
    risk: v.string(),
    approvalRequired: v.boolean(),
    commandId: v.string(),
  }),
  v.object({
    type: v.literal('subagent_cancel'),
    subagentId: v.string(),
    reason: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('mission_start'),
    missionId: v.string(),
    unit: v.string(),
    questName: v.string(),
  }),
  v.object({
    type: v.literal('mission_complete'),
    missionId: v.string(),
    unit: v.string(),
    success: v.boolean(),
    duration: v.number(),
  }),
  v.object({
    type: v.literal('waiting_approval'),
    commandId: v.string(),
    commandType: v.string(),
    target: v.string(),
    risk: v.string(),
  }),
  v.object({
    type: v.literal('chat_chunk'),
    unit: v.string(),
    text: v.string(),
    missionId: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('unit_fatigue_update'),
    unit: v.string(),
    fatigue: v.number(),
    maxFatigue: v.optional(v.number()),
    atRest: v.optional(v.boolean()),
    restAreaId: v.optional(v.union([v.string(), v.null()])),
  }),
  v.object({
    type: v.literal('unit_sent_to_rest'),
    unit: v.string(),
    restAreaId: v.string(),
    fatigue: v.number(),
    maxFatigue: v.number(),
    atRest: v.boolean(),
  }),
  v.object({
    type: v.literal('rest_area_discovered'),
    restArea: v.object({
      id: v.string(),
      roomId: v.string(),
      coord: Hex,
      recoveryRate: v.number(),
      capacity: v.number(),
      unitsInside: v.array(v.string()),
    }),
  }),
  v.object({
    type: v.literal('rest_area_entered'),
    unit: v.string(),
    restAreaId: v.string(),
  }),
  v.object({
    type: v.literal('rest_area_exited'),
    unit: v.string(),
    restAreaId: v.string(),
  }),
  v.object({
    type: v.literal('context_exhausted'),
    unit: v.string(),
    hex: Hex,
  }),
  v.object({
    type: v.literal('log'),
    msg: v.string(),
    level: v.optional(LogLevel),
  }),
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BridgeEventSchema = v.variant('type', Schemas as any);

export function parseBridgeEvent(raw: unknown): BridgeEvent | null {
  const result = v.safeParse(BridgeEventSchema, raw);
  if (result.success) return result.output as BridgeEvent;
  return null;
}

export function describeBridgeEventError(raw: unknown): string {
  const result = v.safeParse(BridgeEventSchema, raw);
  if (result.success) return 'ok';
  const issue = result.issues[0];
  const path = issue?.path?.map((p: { key: PropertyKey }) => String(p.key)).join('.') ?? '(root)';
  return `${path}: ${issue?.message ?? 'invalid'}`;
}
