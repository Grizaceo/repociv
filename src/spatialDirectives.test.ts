import { describe, it, expect, beforeEach } from 'vitest';
import {
  interpretUnitDrag,
  interpretUnitToFileDrag,
  interpretCardDropOnUnit,
} from './spatialDirectives.ts';
import type { Unit, Tile, City } from './types.ts';
import type { Axial } from './hex.ts';
import { draftCommand, type CommandDraft } from './commandSchema.ts';
import { setCapabilitiesForAgentsForTesting } from './capabilitiesClient.ts';

const ALL_CAPS = [
  'inspect_repo',
  'read_file',
  'run_tests',
  'run_build',
  'edit_file',
  'create_branch',
  'git_commit',
  'execute_agent',
  'quest_add',
  'unit_command',
  'e2e_probe',
  'send_message',
];

const ARMY_CAPS = ['inspect_repo', 'read_file', 'run_tests', 'run_build', 'execute_agent'];

beforeEach(() => {
  setCapabilitiesForAgentsForTesting({
    davi: { capabilities: ALL_CAPS },
    scout1: { capabilities: ['inspect_repo', 'read_file'] },
    army1: { capabilities: ARMY_CAPS },
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAxial(q = 0, r = 0): Axial {
  return { q, r };
}

function makeCity(id: string, name: string): City {
  return {
    id,
    name,
    coord: makeAxial(0, 0),
    population: 0,
    territory: [],
    districts: [],
    buildings: [],
    isCapital: false,
  };
}

function makeTile(city?: City): Tile {
  return {
    coord: makeAxial(0, 0),
    terrain: 'plains',
    resources: { gold: 0, science: 0, production: 0 },
    city,
    inFog: false,
    revealed: true,
  };
}

function makeUnit(id: string, type: Unit['type'] = 'worker'): Unit {
  return {
    id,
    name: id.toUpperCase(),
    type,
    civ: 'gris',
    coord: makeAxial(0, 0),
    path: [],
    pathIndex: 0,
    pathProgress: 0,
    state: 'idle',
    speed: 1,
    color: '#fff',
    movesLeft: 2,
    maxMoves: 2,
    fatigue: 100,
    maxFatigue: 100,
    isResting: false,
    effectiveSpeed: 1,
  };
}

// ─── interpretUnitDrag ────────────────────────────────────────────────────────

describe('interpretUnitDrag', () => {
  const city = makeCity('repociv', 'repociv');
  const cityTile = makeTile(city);
  const unit = makeUnit('main', 'hero');

  it('plain drag onto a city returns null so the renderer performs a local move with no modal', () => {
    const result = interpretUnitDrag({
      unit,
      fromCoord: makeAxial(0, 0),
      toTile: cityTile,
      shiftHeld: false,
    });

    expect(result).toBeNull();
  });

  it('shift+drag onto a city still creates an explicit run_tests directive', () => {
    const result = interpretUnitDrag({
      unit,
      fromCoord: makeAxial(0, 0),
      toTile: cityTile,
      shiftHeld: true,
    });

    expect(result).not.toBeNull();
    expect(result!.draft.type).toBe('run_tests');
    expect(result!.draft.target).toBe('repociv');
    expect(result!.draft.payload).toMatchObject({
      unit: 'main',
      city: 'repociv',
      mission: 'Ejecutar tests en repociv',
      agentType: 'hero',
    });
  });
});

// ─── interpretUnitToFileDrag ─────────────────────────────────────────────────

describe('interpretUnitToFileDrag', () => {
  const city = makeCity('repociv', 'repociv');
  const cityTile = makeTile(city);
  const unit = makeUnit('main', 'hero');

  it('returns null when target tile has no city', () => {
    const emptyTile = makeTile(); // no city
    const result = interpretUnitToFileDrag({
      unit,
      fromCoord: makeAxial(0, 0),
      toTile: emptyTile,
      filePath: 'src/main.ts',
      shiftHeld: false,
    });
    expect(result).toBeNull();
  });

  it('regular drag → read_file command', () => {
    const result = interpretUnitToFileDrag({
      unit,
      fromCoord: makeAxial(0, 0),
      toTile: cityTile,
      filePath: 'src/main.ts',
      shiftHeld: false,
    });
    expect(result).not.toBeNull();
    expect(result!.gesture).toBe('drag_unit_to_file');
    expect(result!.draft.type).toBe('read_file');
    expect(result!.sourceUnitId).toBe('main');
    expect(result!.targetCityId).toBe('repociv');
    expect(result!.shiftHeld).toBe(false);
    expect(result!.confidence).toBe(0.85);
    expect(result!.userConfirmed).toBe(false);
  });

  it('shift+drag on non-test file → edit_file command', () => {
    const result = interpretUnitToFileDrag({
      unit,
      fromCoord: makeAxial(0, 0),
      toTile: cityTile,
      filePath: 'src/spatialDirectives.ts',
      shiftHeld: true,
    });
    expect(result).not.toBeNull();
    expect(result!.draft.type).toBe('edit_file');
    expect(result!.shiftHeld).toBe(true);
  });

  it('shift+drag on test file → run_tests command', () => {
    const result = interpretUnitToFileDrag({
      unit,
      fromCoord: makeAxial(0, 0),
      toTile: cityTile,
      filePath: 'src/spatialDirectives.test.ts',
      shiftHeld: true,
    });
    expect(result).not.toBeNull();
    expect(result!.draft.type).toBe('run_tests');
  });

  it('shift+drag on python test → run_tests command', () => {
    const result = interpretUnitToFileDrag({
      unit,
      fromCoord: makeAxial(0, 0),
      toTile: cityTile,
      filePath: 'server/test_scheduler.py',
      shiftHeld: true,
    });
    expect(result).not.toBeNull();
    expect(result!.draft.type).toBe('run_tests');
  });

  it('extracts filename from path in label', () => {
    const result = interpretUnitToFileDrag({
      unit,
      fromCoord: makeAxial(2, 3),
      toTile: cityTile,
      filePath: 'deep/nested/path/config.json',
      shiftHeld: false,
    });
    expect(result).not.toBeNull();
    expect(result!.label).toContain('config.json');
    expect(result!.label).toContain('@ repociv');
    expect(result!.label).toContain('read_file');
  });

  it('strips trailing slash from filePath', () => {
    const result = interpretUnitToFileDrag({
      unit,
      fromCoord: makeAxial(0, 0),
      toTile: cityTile,
      filePath: 'docs/',
      shiftHeld: false,
    });
    expect(result).not.toBeNull();
    // after stripping /, path becomes 'docs', filename = 'docs'
    expect(result!.label).toContain('docs');
  });

  it('stores filePath and fileName in draft payload', () => {
    const result = interpretUnitToFileDrag({
      unit,
      fromCoord: makeAxial(0, 0),
      toTile: cityTile,
      filePath: 'src/types.ts',
      shiftHeld: true,
    });
    expect(result!.draft.payload?.filePath).toBe('src/types.ts');
    expect(result!.draft.payload?.fileName).toBe('types.ts');
  });
});

// ─── interpretCardDropOnUnit ─────────────────────────────────────────────────

describe('interpretCardDropOnUnit', () => {
  const unit = makeUnit('SCOUT-1', 'scout');
  const unitCoord = makeAxial(5, 7);

  it('returns null when unit cannot execute card type', () => {
    // A scout can inspect_repo but NOT delete_file
    const card: CommandDraft = draftCommand('delete_file', 'some_repo', {
      reason: 'cleanup',
    });
    const result = interpretCardDropOnUnit({ card, unit, unitCoord });
    expect(result).toBeNull();
  });

  it('delegates inspect_repo card to a scout', () => {
    const card = draftCommand('inspect_repo', 'repociv', {
      mission: 'Check main branch',
    });
    const result = interpretCardDropOnUnit({ card, unit, unitCoord });
    expect(result).not.toBeNull();
    expect(result!.gesture).toBe('drop_card_on_unit');
    expect(result!.draft.type).toBe('inspect_repo');
    expect(result!.draft.created_by).toBe('SCOUT-1');
    expect(result!.sourceUnitId).toBe('SCOUT-1');
    expect(result!.confidence).toBe(0.8);
    expect(result!.userConfirmed).toBe(false);
    expect(result!.shiftHeld).toBe(false);
  });

  it('delegates execute_agent card to an orchestrator-class unit', () => {
    // CURSOR/CLAUDE/OPENCLAW are the shipped units that can do execute_agent.
    // MAIN's harness-driven capabilities are resolved at runtime; in the JS
    // module they are empty, so we use CURSOR-1 to exercise the dispatch path.
    const army = makeUnit('CURSOR-1', 'army');
    const card = draftCommand('execute_agent', 'target_repo', {
      mission: 'Deploy',
    });
    const result = interpretCardDropOnUnit({ card, unit: army, unitCoord });
    expect(result).not.toBeNull();
    expect(result!.draft.created_by).toBe('CURSOR-1');
  });

  it('merges card payload with unit assignment info', () => {
    const card = draftCommand('read_file', 'repociv', {
      filePath: 'README.md',
      mission: 'Read docs',
    });
    const result = interpretCardDropOnUnit({ card, unit, unitCoord });
    expect(result).not.toBeNull();
    const payload = result!.draft.payload;
    expect(payload?.filePath).toBe('README.md');
    expect(payload?.mission).toBe('Read docs');
    expect(payload?.unit).toBe('SCOUT-1');
    expect(payload?.agentType).toBe('scout');
    expect(payload?.delegatedFrom).toBe('user');
  });

  it('uses card.created_by as delegatedFrom when set', () => {
    const card: CommandDraft = {
      type: 'inspect_repo',
      target: 'repociv',
      created_by: 'main',
      payload: { mission: 'Audit' },
    };
    const result = interpretCardDropOnUnit({ card, unit, unitCoord });
    expect(result).not.toBeNull();
    expect(result!.draft.payload?.delegatedFrom).toBe('main');
  });

  it('preserves original card target', () => {
    const card = draftCommand('inspect_repo', 'lexo-alpha', {
      mission: 'Check legal DB',
    });
    const result = interpretCardDropOnUnit({ card, unit, unitCoord });
    expect(result!.draft.target).toBe('lexo-alpha');
  });
});
