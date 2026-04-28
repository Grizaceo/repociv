// ─── RepoCiv — Local Map Generator ───────────────────────────────────────────
// Converts a repo file tree into a RimWorld-style 2D grid of rooms + workbenches.
// BFS traversal assigns each folder a rectangular "room" proportional to its file count.
// Files become "workbench" tiles inside their room.

import type { LocalWorld, LocalRoom, LocalTile, LocalTileType, Workbench } from './types.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── File tree (from bridge API) ───────────────────────────────────────────────
export interface FileNode {
  name: string;
  path: string;      // absolute path
  type: 'file' | 'dir';
  children?: FileNode[];
}

// ─── Grid constants ────────────────────────────────────────────────────────────
const TILE_SIZE       = 24;   // px per tile in local view
const WALL_THICKNESS  = 1;     // tiles
const MIN_ROOM_SIZE   = 4;     // minimum room dimension (tiles)
const FILES_PER_TILE  = 1;     // one workbench per tile
const DOOR_WIDTH      = 1;     // tiles
const MAX_DEPTH       = 3;     // max folder depth to traverse

let _workbenchIdCounter = 0;

// ─── Directory scanner ─────────────────────────────────────────────────────────
function scanDir(dirPath: string, depth = 0): FileNode {
  const name = path.basename(dirPath);
  const node: FileNode = { name, path: dirPath, type: 'dir', children: [] };
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) {
          node.children!.push(scanDir(full, depth + 1));
        }
      } else if (entry.isFile()) {
        node.children!.push({ name: entry.name, path: full, type: 'file' });
      }
    }
  } catch {
    // Directory does not exist or inaccessible — return empty node
  }
  return node;
}

// ─── Entry point ──────────────────────────────────────────────────────────────
export function buildLocalWorld(repoId: string, rootPath: string): LocalWorld {
  const root: FileNode = (rootPath as FileNode).type === 'dir'
    ? (rootPath as FileNode)
    : scanDir(rootPath as string);
  // Step 1: BFS collect all folders up to MAX_DEPTH
  const folders = collectFolders(root, MAX_DEPTH);
  folders.unshift({ path: root.path, name: root.name, depth: 0 });

  // Step 2: Sort by depth descending (process deepest rooms first so they carve space)
  folders.sort((a, b) => b.depth - a.depth);

  // Step 3: Assign rooms
  // We'll use a greedy rect packing: each room gets a rectangle.
  // Grid starts small and grows as needed.
  let gridWidth  = MIN_ROOM_SIZE * 2 + WALL_THICKNESS * 2;
  let gridHeight = MIN_ROOM_SIZE * 2 + WALL_THICKNESS * 2;

  // Pad grid generously so we don't hit edges
  const MIN_GRID = 60;
  gridWidth  = Math.max(gridWidth,  MIN_GRID);
  gridHeight = Math.max(gridHeight, MIN_GRID);

  const rooms: LocalRoom[] = [];
  const workbenches: Workbench[] = [];

  for (const folder of folders) {
    // Count files in this folder (including nested, up to depth limit)
    const fileCount = countFiles(folder.node, MAX_DEPTH - folder.depth);
    if (fileCount === 0) continue;

    // Calculate room dimensions from file count
    const { width, height } = computeRoomSize(fileCount);

    // Try to place the room using rect packing (scanline)
    const placed = placeRoom(gridWidth, gridHeight, rooms, width, height, WALL_THICKNESS);

    if (!placed.fits) {
      // Expand grid and retry
      const newSize = expandGrid(gridWidth, gridHeight, width, height, placed.reason);
      gridWidth  = newSize.w;
      gridHeight = newSize.h;
      const retry = placeRoom(gridWidth, gridHeight, rooms, width, height, WALL_THICKNESS);
      if (!retry.fits) continue; // skip this room if it really doesn't fit
      rooms.push(makeRoom(folder, retry.x!, retry.y!, width, height));
    } else {
      rooms.push(makeRoom(folder, placed.x!, placed.y!, width, height));
    }

    // Collect workbenches for this room
    const room = rooms[rooms.length - 1]!;
    const files = collectFiles(folder.node, MAX_DEPTH - folder.depth);
    for (const file of files) {
      if (room.workbenches.length >= (width - WALL_THICKNESS * 2) * (height - WALL_THICKNESS * 2)) break;
      const wb = makeWorkbench(file, repoId);
      room.workbenches.push(wb);
      workbenches.push(wb);
    }
  }

  // Step 4: Build the 2D grid tile array
  const grid = buildGrid(gridWidth, gridHeight, rooms, WALL_THICKNESS);

  // Step 5: Add corridors between adjacent rooms
  addCorridors(grid, rooms, gridWidth, gridHeight);

  return { repoId, grid, rooms, width: gridWidth, height: gridHeight, workbenches };
}

// ─── Folder collector (BFS with depth) ───────────────────────────────────────
interface FolderEntry { path: string; name: string; node: FileNode; depth: number }

function collectFolders(node: FileNode, maxDepth: number): FolderEntry[] {
  const result: FolderEntry[] = [];
  const queue: Array<{ node: FileNode; depth: number }> = [];

  for (const child of node.children ?? []) {
    if (child.type === 'dir') {
      queue.push({ node: child, depth: 1 });
    }
  }

  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (!entry) break;
    const { node: dir, depth } = entry;
    if (!dir || depth > maxDepth) continue;
    result.push({ path: dir.path, name: dir.name, node: dir, depth });
    for (const child of dir.children ?? []) {
      if (child.type === 'dir') {
        queue.push({ node: child, depth: depth + 1 });
      }
    }
  }

  return result;
}

function countFiles(node: FileNode | undefined, remainingDepth: number): number {
  if (!node || remainingDepth <= 0) return 0;
  let count = 0;
  for (const child of node.children ?? []) {
    if (child.type === 'file') count++;
    else if (child.type === 'dir') count += countFiles(child, remainingDepth - 1);
  }
  return count;
}

function collectFiles(node: FileNode | undefined, remainingDepth: number): FileNode[] {
  if (!node || remainingDepth <= 0) return [];
  const files: FileNode[] = [];
  for (const child of node.children ?? []) {
    if (child.type === 'file') files.push(child);
    else if (child.type === 'dir') files.push(...collectFiles(child, remainingDepth - 1));
  }
  return files;
}

// ─── Room sizing ───────────────────────────────────────────────────────────────
function computeRoomSize(fileCount: number): { width: number; height: number } {
  const area       = fileCount + WALL_THICKNESS * 2 * 2; // add space for walls
  const cols       = Math.max(MIN_ROOM_SIZE, Math.min(12, Math.ceil(Math.sqrt(area))));
  const rows       = Math.max(MIN_ROOM_SIZE, Math.ceil(area / cols));
  return { width: cols, height: rows };
}

// ─── Rect packing (simple shelf algorithm) ────────────────────────────────────
interface PlaceResult { fits: boolean; x?: number; y?: number; reason?: string }

function placeRoom(
  gridW: number, gridH: number,
  existingRooms: LocalRoom[],
  width: number, height: number,
  wallThick: number,
): PlaceResult {
  // Shelf-based packing: scan each row for available horizontal space
  // Group rooms by approximate y-coordinate (shelf)
  const SHELF_SPACE = 3; // tiles between shelves
  const shelves: Array<{ y: number; rooms: LocalRoom[] }> = [];

  for (const room of existingRooms) {
    let added = false;
    for (const shelf of shelves) {
      if (Math.abs(shelf.y - room.y) < SHELF_SPACE) {
        shelf.rooms.push(room);
        added = true;
        break;
      }
    }
    if (!added) shelves.push({ y: room.y, rooms: [room] });
  }

  // Sort shelves by y
  shelves.sort((a, b) => a.y - b.y);

  let cursorY = wallThick;
  for (const shelf of shelves) {
    // Try to pack in this shelf
    let cursorX = wallThick;
    const shelfRooms = shelf.rooms;
    for (const r of shelfRooms) {
      cursorX = Math.max(cursorX, r.x + r.width + SHELF_SPACE);
    }
    // Check if our room fits at (cursorX, shelf.y)
    if (cursorX + width <= gridW - wallThick) {
      return { fits: true, x: cursorX, y: shelf.y };
    }
    // Next shelf
    const shelfBottom = Math.max(...shelfRooms.map(r => r.y + r.height));
    cursorY = Math.max(cursorY, shelfBottom + SHELF_SPACE);
  }

  // Try at cursorY on the leftmost side
  if (cursorY + height <= gridH - wallThick) {
    return { fits: true, x: wallThick, y: cursorY };
  }

  return { fits: false, reason: 'vertical_overflow' };
}

function expandGrid(
  currentW: number, currentH: number,
  roomW: number, roomH: number,
  reason: string,
): { w: number; h: number } {
  // Grow by 50% or enough to fit the new room
  if (reason === 'vertical_overflow') {
    return { w: currentW, h: Math.max(currentH * 2, currentH + roomH + 10) };
  }
  return { w: Math.max(currentW * 2, currentW + roomW + 10), h: currentH };
}

// ─── Room factory ──────────────────────────────────────────────────────────────
function makeRoom(folder: FolderEntry, x: number, y: number, width: number, height: number): LocalRoom {
  return {
    id:         folder.path,
    label:      folder.name,
    w:          width,
    h:          height,
    folderPath: folder.path,
    folderName: folder.name,
    x, y, width, height,
    workbenches: [],
  };
}

// ─── Workbench factory ─────────────────────────────────────────────────────────
function makeWorkbench(file: FileNode, repoId: string): Workbench {
  const ext = file.name.includes('.') ? file.name.split('.').pop()! : '';
  return {
    id:        String(++_workbenchIdCounter),
    filePath:  file.path,
    fileName:  file.name,
    extension: ext,
    isTest:    /\.(test|spec)\.[^.]+$/.test(file.name),
    repoPath:  repoId,
  };
}

// ─── Grid builder ──────────────────────────────────────────────────────────────
function buildGrid(
  width: number, height: number,
  rooms: LocalRoom[],
  wallThick: number,
): LocalTile[][] {
  // Initialize with floor tiles
  const grid: LocalTile[][] = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => ({
      x, y,
      type: 'floor' as LocalTileType,
      roomId: null,
      workbench: null,
    })),
  );

  // Draw rooms: walls + floor + workbenches
  for (const room of rooms) {
    const { x, y, width: w, height: h, workbenches } = room;

    // Outer wall perimeter
    for (let ry = y; ry < y + h; ry++) {
      for (let rx = x; rx < x + w; rx++) {
        if (!inBounds(rx, ry, width, height)) continue;
        const isWall = (
          ry === y || ry === y + h - 1 ||
          rx === x || rx === x + w - 1
        );
        grid[ry]![rx]!.type   = isWall ? 'wall' : 'floor';
        grid[ry]![rx]!.roomId = room.id;
      }
    }

    // Place workbenches on floor tiles (left-to-right, top-to-bottom)
    const floorTiles: Array<{ x: number; y: number }> = [];
    for (let ry = y + wallThick; ry < y + h - wallThick; ry++) {
      for (let rx = x + wallThick; rx < x + w - wallThick; rx++) {
        if (inBounds(rx, ry, width, height)) {
          floorTiles.push({ x: rx, y: ry });
        }
      }
    }

    for (let i = 0; i < workbenches.length && i < floorTiles.length; i++) {
      const { x: tx, y: ty } = floorTiles[i]!;
      const tile = grid[ty]![tx]!;
      tile.type       = 'workbench';
      tile.workbench  = workbenches[i]!;
    }
  }

  return grid;
}

// ─── Corridors: connect adjacent rooms ─────────────────────────────────────────
function addCorridors(
  grid: LocalTile[][],
  rooms: LocalRoom[],
  gridW: number,
  gridH: number,
): void {
  if (rooms.length < 2) return;

  // Simple horizontal corridor: connect rooms by drawing a floor path
  // between room right-edge to next room's left-edge on same approximate y
  const sorted = [...rooms].sort((a, b) => {
    if (Math.abs(a.y - b.y) < 5) return a.x - b.x;
    return a.y - b.y;
  });

  for (let i = 0; i < sorted.length - 1; i++) {
    const roomA = sorted[i]!;
    const roomB = sorted[i + 1]!;
    // Horizontal corridor from A's right edge to B's left edge
    const y = Math.round((roomA.y + roomA.height / 2 + roomB.y + roomB.height / 2) / 2);
    // x range: cover the wall of roomA, the gap between rooms, and the wall of roomB
    const xStart = roomA.x + roomA.width - 1; // right wall of A (includes wall tile)
    const xEnd   = roomB.x;                   // left wall of B (includes wall tile)
    for (let x = xStart; x <= xEnd; x++) {
      if (inBounds(x, y, gridW, gridH)) {
        const tile = grid[y]![x]!;
        if (tile.type === 'wall') {
          tile.type = 'door'; // replace wall with door
        }
      }
    }
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function inBounds(x: number, y: number, w: number, h: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h;
}

// ─── Mock builder (for tests) ─────────────────────────────────────────────────
export function buildMockLocalWorld(): LocalWorld {
  const mockRoot: FileNode = {
    name: 'repociv',
    path: '/home/gris/.hermes/workspace/repos/repociv',
    type: 'dir',
    children: [
      { name: 'src', path: '/home/gris/.hermes/workspace/repos/repociv/src', type: 'dir', children: [
        { name: 'main.ts', path: '/home/gris/.hermes/workspace/repos/repociv/src/main.ts', type: 'file' },
        { name: 'game.ts', path: '/home/gris/.hermes/workspace/repos/repociv/src/game.ts', type: 'file' },
        { name: 'renderer.ts', path: '/home/gris/.hermes/workspace/repos/repociv/src/renderer.ts', type: 'file' },
        { name: 'hex.ts', path: '/home/gris/.hermes/workspace/repos/repociv/src/hex.ts', type: 'file' },
        { name: 'pathfinding.ts', path: '/home/gris/.hermes/workspace/repos/repociv/src/pathfinding.ts', type: 'file' },
        { name: 'hex.test.ts', path: '/home/gris/.hermes/workspace/repos/repociv/src/hex.test.ts', type: 'file' },
        { name: 'pathfinding.test.ts', path: '/home/gris/.hermes/workspace/repos/repociv/src/pathfinding.test.ts', type: 'file' },
        { name: 'localMap.ts', path: '/home/gris/.hermes/workspace/repos/repociv/src/localMap.ts', type: 'file' },
        { name: 'ui', path: '/home/gris/.hermes/workspace/repos/repociv/src/ui', type: 'dir', children: [
          { name: 'hud.ts', path: '/home/gris/.hermes/workspace/repos/repociv/src/ui/hud.ts', type: 'file' },
          { name: 'chat.ts', path: '/home/gris/.hermes/workspace/repos/repociv/src/ui/chat.ts', type: 'file' },
        ]},
      ]},
      { name: 'docs', path: '/home/gris/.hermes/workspace/repos/repociv/docs', type: 'dir', children: [
        { name: 'ROADMAP.md', path: '/home/gris/.hermes/workspace/repos/repociv/docs/ROADMAP.md', type: 'file' },
      ]},
      { name: 'package.json', path: '/home/gris/.hermes/workspace/repos/repociv/package.json', type: 'file' },
    ],
  };

  return buildLocalWorld('repociv', mockRoot);
}
