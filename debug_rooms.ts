import { buildLocalWorld } from './src/localMap.js';
import * as path from 'node:path';

const world = buildLocalWorld('repociv', path.resolve('src'));

const spawnRoom = world.rooms[0];
if (!spawnRoom) { console.error('No rooms!'); process.exit(1); }
const spawnTileX = spawnRoom.x + 1;
const spawnTileY = spawnRoom.y + 1;

console.log('=== All rooms ===');
for (let i = 0; i < world.rooms.length; i++) {
  const r = world.rooms[i];
  const wbNames = r.workbenches.slice(0, 3).map(w => w.fileName).join(', ');
  console.log(`  [${i}] ${r.label} | x:${r.x} y:${r.y} | ${r.width}x${r.height} | files:${r.workbenches.length} | ${wbNames}${r.workbenches.length > 3 ? '...' : ''}`);
}

const lastRoom = world.rooms[world.rooms.length - 1];
const midRoom = world.rooms[Math.floor(world.rooms.length / 2)];
console.log('\n=== Distance check ===');
console.log('Last room:', lastRoom?.label, 'x:', lastRoom?.x, 'y:', lastRoom?.y, 'files:', lastRoom?.workbenches.length);
console.log('Mid room:', midRoom?.label, 'x:', midRoom?.x, 'y:', midRoom?.y, 'files:', midRoom?.workbenches.length);
console.log('Dist spawn->lastRoom:', Math.abs((lastRoom?.x ?? 0) - spawnTileX) + Math.abs((lastRoom?.y ?? 0) - spawnTileY), 'tiles');
console.log('Dist spawn->midRoom:', Math.abs((midRoom?.x ?? 0) - spawnTileX) + Math.abs((midRoom?.y ?? 0) - spawnTileY), 'tiles');
