import { describe, it, expect } from 'vitest';
import { parseBridgeEvent, describeBridgeEventError } from './bridgeSchema.ts';

describe('parseBridgeEvent', () => {
  it('accepts a valid unit_spawn event', () => {
    const evt = parseBridgeEvent({ type: 'unit_spawn', unit: 'MAIN', civ: 'capital', hex: [0, 0] });
    expect(evt).not.toBeNull();
    expect(evt?.type).toBe('unit_spawn');
  });

  it('accepts unit_spawn with optional fields', () => {
    const evt = parseBridgeEvent({
      type: 'unit_spawn',
      unit: 'MAIN',
      civ: 'capital',
      hex: [3, -1],
      mission: 'scout area',
      unitType: 'hero',
    });
    expect(evt).not.toBeNull();
  });

  it('rejects unit_spawn with missing unit', () => {
    const evt = parseBridgeEvent({ type: 'unit_spawn', civ: 'capital', hex: [0, 0] });
    expect(evt).toBeNull();
  });

  it('rejects unit_spawn with hex containing non-numbers', () => {
    const evt = parseBridgeEvent({
      type: 'unit_spawn',
      unit: 'X',
      civ: 'capital',
      hex: ['a', 'b'],
    });
    expect(evt).toBeNull();
  });

  it('accepts log event', () => {
    const evt = parseBridgeEvent({ type: 'log', msg: 'hello' });
    expect(evt).not.toBeNull();
    expect(evt?.type).toBe('log');
  });

  it('accepts log event with level', () => {
    const evt = parseBridgeEvent({ type: 'log', msg: 'ok', level: 'success' });
    expect(evt).not.toBeNull();
  });

  it('rejects log event with invalid level', () => {
    const evt = parseBridgeEvent({ type: 'log', msg: 'ok', level: 'critical' });
    expect(evt).toBeNull();
  });

  it('accepts building_start event', () => {
    const evt = parseBridgeEvent({
      type: 'building_start',
      city: 'main',
      building: 'Library',
      durationSeconds: 60,
    });
    expect(evt).not.toBeNull();
  });

  it('accepts mission_start event', () => {
    const evt = parseBridgeEvent({
      type: 'mission_start',
      missionId: 'abc123',
      unit: 'MAIN',
      questName: 'Explorar',
    });
    expect(evt).not.toBeNull();
  });

  it('accepts mission_complete event', () => {
    const evt = parseBridgeEvent({
      type: 'mission_complete',
      missionId: 'abc123',
      unit: 'MAIN',
      success: true,
      duration: 42,
    });
    expect(evt).not.toBeNull();
  });

  it('accepts chat_chunk event', () => {
    const evt = parseBridgeEvent({ type: 'chat_chunk', unit: 'MAIN', text: 'hello world' });
    expect(evt).not.toBeNull();
  });

  it('rejects unknown event type', () => {
    const evt = parseBridgeEvent({ type: 'unknown_type', foo: 'bar' });
    expect(evt).toBeNull();
  });

  it('rejects null input', () => {
    expect(parseBridgeEvent(null)).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseBridgeEvent('string')).toBeNull();
    expect(parseBridgeEvent(42)).toBeNull();
  });

  it('accepts unit_fatigue_update event', () => {
    const evt = parseBridgeEvent({ type: 'unit_fatigue_update', unit: 'MAIN', fatigue: 80 });
    expect(evt).not.toBeNull();
  });

  it('accepts rest_area_discovered event', () => {
    const evt = parseBridgeEvent({
      type: 'rest_area_discovered',
      restArea: {
        id: 'ra1',
        roomId: 'r0',
        coord: [1, 1],
        recoveryRate: 8,
        capacity: 4,
        unitsInside: [],
      },
    });
    expect(evt).not.toBeNull();
  });

  it('accepts subagent_spawn event', () => {
    const evt = parseBridgeEvent({
      type: 'subagent_spawn',
      subagentId: 'sub-abc',
      parentMissionId: 'm1',
      parentUnit: 'MAIN',
      kind: 'explore',
      label: 'scan repo',
      hex: [0, 0],
      risk: 'low',
      ephemeralUnitId: 'SCOUT-sub-abc',
    });
    expect(evt?.type).toBe('subagent_spawn');
  });

  it('accepts subagent_complete event', () => {
    const evt = parseBridgeEvent({
      type: 'subagent_complete',
      subagentId: 'sub-abc',
      success: true,
      summary: 'done',
      duration: 12,
    });
    expect(evt).not.toBeNull();
  });

  it('accepts fog_reveal with cityId', () => {
    const evt = parseBridgeEvent({
      type: 'fog_reveal',
      hexes: [[1, 0]],
      cityId: 'other-repo',
    });
    expect(evt).not.toBeNull();
  });
});

describe('describeBridgeEventError', () => {
  it('returns "ok" for valid event', () => {
    expect(describeBridgeEventError({ type: 'log', msg: 'test' })).toBe('ok');
  });

  it('returns a non-empty error string for invalid event', () => {
    const msg = describeBridgeEventError({ type: 'log' });
    expect(typeof msg).toBe('string');
    expect(msg).not.toBe('ok');
  });

  it('returns a non-empty error string for unknown type', () => {
    const msg = describeBridgeEventError({ type: 'totally_invalid' });
    expect(msg).not.toBe('ok');
  });
});
