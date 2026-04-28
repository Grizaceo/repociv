import { describe, it, assert } from 'vitest';
import { buildMockLocalWorld, buildLocalWorldFromPaths } from './localMap.ts';

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
        assert.ok(!(overlapX && overlapY), `Room ${i} (${a.label}) and room ${j} (${b.label}) should not overlap`);
      }
    }
  });

  it('all rooms are within world bounds', () => {
    const world = buildMockLocalWorld('repociv');
    for (const room of world.rooms) {
      assert.ok(room.x >= 0 && room.y >= 0, `room ${room.label} position should be >= 0`);
      assert.ok(room.x + room.w <= world.width,  `room ${room.label} x+w exceeds world width`);
      assert.ok(room.y + room.h <= world.height, `room ${room.label} y+h exceeds world height`);
    }
  });

  it('workbenches have unique ids', () => {
    const world = buildMockLocalWorld('repociv');
    const ids = world.workbenches.map(w => w.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, 'workbench ids should be unique');
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
