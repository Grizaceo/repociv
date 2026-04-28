import { describe, it, assert } from 'vitest';
import { buildLocalWorld } from './localMap.js';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname); // src/ directory

describe('localMap', () => {
  it('returns a LocalWorld with width/height > 0', () => {
    const world = buildLocalWorld('repociv', REPO_ROOT);
    assert.ok(world.width > 0, 'width should be positive');
    assert.ok(world.height > 0, 'height should be positive');
  });

  it('has at least one room (root)', () => {
    const world = buildLocalWorld('repociv', REPO_ROOT);
    assert.ok(world.rooms.length >= 1, 'should have at least the root room');
  });

  it('rooms do not overlap (non-overlap invariant)', () => {
    const world = buildLocalWorld('repociv', REPO_ROOT);
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
    const world = buildLocalWorld('repociv', REPO_ROOT);
    for (const room of world.rooms) {
      assert.ok(room.x >= 0 && room.y >= 0, `room ${room.label} y should be >= 0`);
      assert.ok(room.x + room.w <= world.width, `room ${room.label} x+w exceeds world width`);
      assert.ok(room.y + room.h <= world.height, `room ${room.label} y+h exceeds world height`);
    }
  });

  it('workbenches have unique ids', () => {
    const world = buildLocalWorld('repociv', REPO_ROOT);
    const ids = world.workbenches.map(w => w.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, 'workbench ids should be unique');
  });

  it('smoke: generate works for a fresh repo id', () => {
    const w1 = buildLocalWorld('fresh-repo', REPO_ROOT);
    const w2 = buildLocalWorld('fresh-repo', REPO_ROOT);
    // Same repoId should produce the same layout (deterministic)
    assert.equal(w1.width, w2.width);
    assert.equal(w1.height, w2.height);
    assert.equal(w1.rooms.length, w2.rooms.length);
  });
});
