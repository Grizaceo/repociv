import { describe, it, assert } from 'vitest';
import { buildMockLocalWorld, buildLocalWorldFromPaths } from './localMap.ts';
import { measureAisleWidth } from './officeLayout.ts';

describe('localMap — buildMockLocalWorld', () => {
  it('returns a LocalWorld with width/height > 0', () => {
    const world = buildMockLocalWorld('repociv');
    assert.ok(world.width > 0, 'width should be positive');
    assert.ok(world.height > 0, 'height should be positive');
  });

  it('has at least one room', () => {
    const world = buildMockLocalWorld('repociv');
    assert.ok(world.rooms.length >= 1, 'should have at least one room');
  });

  it('rooms do not overlap', () => {
    const world = buildMockLocalWorld('repociv');
    const { rooms } = world;
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i]!;
        const b = rooms[j]!;
        const overlapX = a.x < b.x + b.w && a.x + a.w > b.x;
        const overlapY = a.y < b.y + b.h && a.y + a.h > b.y;
        assert.ok(
          !(overlapX && overlapY),
          `Room ${i} (${a.label}) and room ${j} (${b.label}) should not overlap`,
        );
      }
    }
  });

  it('all rooms are within world bounds', () => {
    const world = buildMockLocalWorld('repociv');
    for (const room of world.rooms) {
      assert.ok(room.x >= 0 && room.y >= 0, `room ${room.label} position should be >= 0`);
      assert.ok(room.x + room.w <= world.width, `room ${room.label} x+w exceeds world width`);
      assert.ok(room.y + room.h <= world.height, `room ${room.label} y+h exceeds world height`);
    }
  });

  it('workbenches have unique ids', () => {
    const world = buildMockLocalWorld('repociv');
    const ids = world.workbenches.map((w) => w.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, 'workbench ids should be unique');
  });

  it('preserves workbench tiles even when power consumers are tracked', () => {
    const world = buildMockLocalWorld('repociv');
    const workbenchTiles = world.grid
      .flat()
      .filter((tile) => tile.workbench !== null && tile.type === 'workbench');

    assert.ok(workbenchTiles.length > 0, 'workbench tiles should remain addressable as workbench');
    assert.ok(
      (world.powerConsumers?.length ?? 0) >= workbenchTiles.length,
      'power consumers should still be tracked for workbenches',
    );
  });

  it('same repoId produces consistent dimensions', () => {
    const w1 = buildMockLocalWorld('fresh-repo');
    const w2 = buildMockLocalWorld('fresh-repo');
    assert.equal(w1.width, w2.width);
    assert.equal(w1.height, w2.height);
    assert.equal(w1.rooms.length, w2.rooms.length);
  });
});

describe('localMap — buildLocalWorldFromPaths', () => {
  const PATHS = [
    'src/main.ts',
    'src/game.ts',
    'src/ui/hud.ts',
    'src/ui/chat.ts',
    'docs/README.md',
    'package.json',
  ];

  it('builds a world from flat path list', () => {
    const world = buildLocalWorldFromPaths('test-repo', PATHS);
    assert.ok(world.width > 0);
    assert.ok(world.height > 0);
  });

  it('creates at least one workbench', () => {
    const world = buildLocalWorldFromPaths('test-repo', PATHS);
    assert.ok(world.workbenches.length > 0);
  });
});

describe('localMap — Office Zone Classification', () => {
  it('classifies src/ as team_cluster', () => {
    const world = buildLocalWorldFromPaths('test-repo', ['src/main.ts']);
    const srcRoom = world.rooms.find((r) => r.folderName === 'src');
    assert.ok(srcRoom, 'src room should exist');
    assert.equal(srcRoom!.zoneType, 'team_cluster');
    assert.equal(srcRoom!.zoneLabel, 'Engineering');
  });

  it('classifies docs/ as meeting', () => {
    const world = buildLocalWorldFromPaths('test-repo', ['docs/README.md']);
    const docsRoom = world.rooms.find((r) => r.folderName === 'docs');
    assert.ok(docsRoom, 'docs room should exist');
    assert.equal(docsRoom!.zoneType, 'meeting');
  });

  it('classifies root repo as reception', () => {
    const world = buildLocalWorldFromPaths('test-repo', ['src/main.ts']);
    const rootRoom = world.rooms.find((r) => r.folderName === 'test-repo');
    assert.ok(rootRoom, 'root room should exist');
    assert.equal(rootRoom!.zoneType, 'reception');
  });
});

describe('localMap — Office Furnishing', () => {
  it('places workbench desks with desk_bundle decor in team_cluster', () => {
    const paths = Array.from({ length: 8 }, (_, i) => `src/file${i}.ts`);
    const world = buildLocalWorldFromPaths('test-repo', paths);
    const srcRoom = world.rooms.find((r) => r.folderName === 'src');
    assert.ok(srcRoom, 'src room should exist');

    const deskWorkbenches = world.grid
      .flat()
      .filter(
        (t) =>
          t.roomId === srcRoom!.id &&
          t.type === 'workbench' &&
          t.decor === 'desk_bundle',
      );
    assert.ok(deskWorkbenches.length > 0, 'team_cluster should have desk-aligned workbenches');
  });

  it('places whiteboard in team_cluster rooms', () => {
    const world = buildLocalWorldFromPaths('test-repo', ['src/main.ts']);
    const srcRoom = world.rooms.find((r) => r.folderName === 'src');
    assert.ok(srcRoom, 'src room should exist');
    const whiteboards = world.grid
      .flat()
      .filter((t) => t.roomId === srcRoom!.id && t.type === 'whiteboard');
    assert.ok(whiteboards.length > 0, 'team_cluster should have whiteboards');
  });

  it('does not overwrite walls with furniture', () => {
    const world = buildMockLocalWorld('test-repo');
    let furnitureOnWall = 0;
    for (const row of world.grid) {
      for (const tile of row) {
        if (
          tile.type === 'workbench' ||
          tile.type === 'whiteboard' ||
          tile.type === 'planter' ||
          tile.type === 'meeting_room' ||
          tile.type === 'window'
        ) {
          const room = world.rooms.find((r) => r.id === tile.roomId);
          if (room) {
            const isWall =
              tile.x === room.x ||
              tile.x === room.x + room.width - 1 ||
              tile.y === room.y ||
              tile.y === room.y + room.height - 1;
            if (isWall) furnitureOnWall++;
          }
        }
      }
    }
    assert.equal(furnitureOnWall, 0, 'furniture should never be placed on wall tiles');
  });

  it('does not overwrite workbench tiles with furniture', () => {
    const world = buildMockLocalWorld('test-repo');
    const workbenchTiles = world.grid
      .flat()
      .filter((t) => t.type === 'workbench');
    assert.ok(workbenchTiles.length > 0, 'should have workbench tiles');

    for (const tile of workbenchTiles) {
      assert.ok(tile.workbench, 'every workbench tile should have a workbench');
      assert.equal(tile.decor, 'desk_bundle', 'workbench tiles should use desk_bundle decor');
    }
  });

  it('furnishes break rooms with sofa and watercooler', () => {
    const world = buildLocalWorldFromPaths('test-repo', ['examples/demo1.ts']);
    const breakRoom = world.rooms.find((r) => r.folderName === 'examples');
    assert.ok(breakRoom, 'examples room should exist');
    assert.equal(breakRoom!.zoneType, 'break');

    const sofas = world.grid.flat().filter((t) => t.type === 'sofa');
    const watercoolers = world.grid.flat().filter((t) => t.type === 'watercooler');
    assert.ok(sofas.length >= 1, 'break room should have sofas');
    assert.ok(watercoolers.length >= 1, 'break room should have watercoolers');
  });
});

describe('localMap — cubicle layout', () => {
  const SRC_FILES = Array.from({ length: 60 }, (_, i) => `src/module/file${i}.ts`);

  it('team_cluster has central aisle at least 2 tiles wide', () => {
    const world = buildLocalWorldFromPaths('cubicle-repo', SRC_FILES);
    const srcRoom = world.rooms.find((r) => r.folderName === 'src');
    assert.ok(srcRoom, 'src room should exist');
    const aisleWidth = measureAisleWidth(world.grid, srcRoom!);
    assert.ok(aisleWidth >= 2, `central aisle should be >= 2 tiles, got ${aisleWidth}`);
    assert.ok(srcRoom!.layoutPlan, 'room should record layout plan metadata');
  });

  it('each workbench is adjacent to a chair tile', () => {
    const world = buildLocalWorldFromPaths('cubicle-repo', SRC_FILES);
    const srcRoom = world.rooms.find((r) => r.folderName === 'src');
    assert.ok(srcRoom, 'src room should exist');

    const workbenchTiles = world.grid
      .flat()
      .filter((t) => t.roomId === srcRoom!.id && t.type === 'workbench');

    assert.ok(workbenchTiles.length > 0, 'should have workbenches in src room');

    const dirs = [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ];
    for (const wb of workbenchTiles) {
      const hasChairNeighbor = dirs.some(([dx, dy]) => {
        const n = world.grid[wb.y + dy!]?.[wb.x + dx!];
        return n?.type === 'chair';
      });
      assert.ok(hasChairNeighbor, `workbench at (${wb.x},${wb.y}) should be adjacent to a chair`);
    }
  });

  it('team_cluster fills the room with a desk grid (open plan, chair behind each desk)', () => {
    const world = buildLocalWorldFromPaths('cubicle-repo', SRC_FILES);
    const srcRoom = world.rooms.find((r) => r.folderName === 'src');
    assert.ok(srcRoom, 'src room should exist');

    const roomTiles = world.grid.flat().filter((t) => t.roomId === srcRoom!.id);
    const desks = roomTiles.filter((t) => t.type === 'workbench');
    const chairs = roomTiles.filter((t) => t.type === 'chair');
    assert.ok(desks.length > 0, 'team_cluster should place desks');
    // Open-plan grid: every desk faces south with the chair on the row below.
    for (const desk of desks) {
      assert.equal(desk.facing, 's', `desk at (${desk.x},${desk.y}) faces south`);
      const below = world.grid[desk.y + 1]?.[desk.x];
      assert.equal(below?.type, 'chair', `desk at (${desk.x},${desk.y}) has chair below`);
    }
    assert.ok(chairs.length >= desks.length, 'one chair per desk');
    // Desk capacity tracks room area (~4 tiles per desk after walls/aisle),
    // not just the two columns flanking the aisle.
    const innerArea = (srcRoom!.width - 2) * (srcRoom!.height - 2);
    const wbCount = srcRoom!.workbenches.length;
    const expected = Math.min(wbCount, Math.floor(innerArea / 8));
    assert.ok(
      desks.length >= expected,
      `desk grid should scale with area: got ${desks.length}, expected ≥ ${expected} (inner area ${innerArea}, wb ${wbCount})`,
    );
  });
});
