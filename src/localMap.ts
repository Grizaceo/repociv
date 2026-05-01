// ─── RepoCiv — Local Map Generator ───────────────────────────────────────────
// Converts a repo file tree into a RimWorld-style 2D grid of rooms + workbenches.
// BFS traversal assigns each folder a rectangular "room" proportional to its file count.
// Files become "workbench" tiles inside their room.

import type { LocalWorld, LocalRoom, LocalTile, LocalTileType, Workbench } from './types.ts';

// ─── File tree node (mirrors bridge API shape) ────────────────────────────────
export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

// ─── Grid constants ────────────────────────────────────────────────────────────
const WALL_THICKNESS = 1;
const MIN_ROOM_SIZE = 4;
const MAX_DEPTH = 3;
const MIN_GRID = 60;

let _workbenchIdCounter = 0;

// ─── Entry point (browser-safe: accepts FileNode tree) ───────────────────────
export function buildLocalWorld(repoId: string, root: FileNode): LocalWorld {
  const folders = collectFolders(root, MAX_DEPTH);
  folders.unshift({ path: root.path, name: root.name, node: root, depth: 0 });
  folders.sort((a, b) => b.depth - a.depth);

  let gridWidth = Math.max(MIN_ROOM_SIZE * 2 + WALL_THICKNESS * 2, MIN_GRID);
  let gridHeight = Math.max(MIN_ROOM_SIZE * 2 + WALL_THICKNESS * 2, MIN_GRID);

  const rooms: LocalRoom[] = [];
  const workbenches: Workbench[] = [];

  for (const folder of folders) {
    const fileCount = countFiles(folder.node, MAX_DEPTH - folder.depth);
    if (fileCount === 0) continue;

    const { width, height } = computeRoomSize(fileCount);
    const placed = placeRoom(gridWidth, gridHeight, rooms, width, height, WALL_THICKNESS);

    if (!placed.fits) {
      const newSize = expandGrid(
        gridWidth,
        gridHeight,
        width,
        height,
        placed.reason ?? 'vertical_overflow',
      );
      gridWidth = newSize.w;
      gridHeight = newSize.h;
      const retry = placeRoom(gridWidth, gridHeight, rooms, width, height, WALL_THICKNESS);
      if (!retry.fits) continue;
      rooms.push(makeRoom(folder, retry.x!, retry.y!, width, height));
    } else {
      rooms.push(makeRoom(folder, placed.x!, placed.y!, width, height));
    }

    const room = rooms[rooms.length - 1]!;
    const files = collectFiles(folder.node, MAX_DEPTH - folder.depth);
    for (const file of files) {
      if (room.workbenches.length >= (width - WALL_THICKNESS * 2) * (height - WALL_THICKNESS * 2))
        break;
      const wb = makeWorkbench(file, repoId);
      room.workbenches.push(wb);
      workbenches.push(wb);
    }
  }

  const grid = buildGrid(gridWidth, gridHeight, rooms, WALL_THICKNESS);
  addCorridors(grid, rooms, gridWidth, gridHeight);

  return { repoId, grid, rooms, width: gridWidth, height: gridHeight, workbenches };
}

// ─── Browser API entry point: convert flat path list → FileNode tree ──────────
export function buildLocalWorldFromPaths(repoId: string, filePaths: string[]): LocalWorld {
  const root: FileNode = { name: repoId, path: repoId, type: 'dir', children: [] };

  for (const fp of filePaths) {
    const parts = fp.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isFile = i === parts.length - 1;
      let child = node.children!.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          type: isFile ? 'file' : 'dir',
          children: isFile ? undefined : [],
        };
        node.children!.push(child);
      }
      if (!isFile) node = child;
    }
  }

  return buildLocalWorld(repoId, root);
}

// ─── Async: fetch file list from bridge API, build world ─────────────────────
export async function generateLocalWorldFromApi(repoId: string): Promise<LocalWorld> {
  try {
    const res = await fetch(`/api/files/${encodeURIComponent(repoId)}`);
    if (res.ok) {
      const data = (await res.json()) as { files?: string[]; tree?: FileNode };
      if (data.tree) return buildLocalWorld(repoId, data.tree);
      if (data.files) return buildLocalWorldFromPaths(repoId, data.files);
    }
  } catch {
    // fall through to mock
  }
  return buildMockLocalWorld(repoId);
}

// ─── Mock builder (for tests and fallback) ────────────────────────────────────
export function buildMockLocalWorld(repoId = 'repociv'): LocalWorld {
  const root: FileNode = {
    name: repoId,
    path: `/repos/${repoId}`,
    type: 'dir',
    children: [
      {
        name: 'src',
        path: `/repos/${repoId}/src`,
        type: 'dir',
        children: [
          { name: 'main.ts', path: `/repos/${repoId}/src/main.ts`, type: 'file' },
          { name: 'game.ts', path: `/repos/${repoId}/src/game.ts`, type: 'file' },
          { name: 'renderer.ts', path: `/repos/${repoId}/src/renderer.ts`, type: 'file' },
          { name: 'hex.ts', path: `/repos/${repoId}/src/hex.ts`, type: 'file' },
          { name: 'pathfinding.ts', path: `/repos/${repoId}/src/pathfinding.ts`, type: 'file' },
          { name: 'localMap.ts', path: `/repos/${repoId}/src/localMap.ts`, type: 'file' },
          {
            name: 'ui',
            path: `/repos/${repoId}/src/ui`,
            type: 'dir',
            children: [
              { name: 'hud.ts', path: `/repos/${repoId}/src/ui/hud.ts`, type: 'file' },
              { name: 'chat.ts', path: `/repos/${repoId}/src/ui/chat.ts`, type: 'file' },
            ],
          },
        ],
      },
      {
        name: 'docs',
        path: `/repos/${repoId}/docs`,
        type: 'dir',
        children: [{ name: 'ROADMAP.md', path: `/repos/${repoId}/docs/ROADMAP.md`, type: 'file' }],
      },
      { name: 'package.json', path: `/repos/${repoId}/package.json`, type: 'file' },
    ],
  };
  return buildLocalWorld(repoId, root);
}

// ─── Folder collector (BFS) ───────────────────────────────────────────────────
interface FolderEntry {
  path: string;
  name: string;
  node: FileNode;
  depth: number;
}

function collectFolders(node: FileNode, maxDepth: number): FolderEntry[] {
  const result: FolderEntry[] = [];
  const queue: Array<{ node: FileNode; depth: number }> = [];

  for (const child of node.children ?? []) {
    if (child.type === 'dir') queue.push({ node: child, depth: 1 });
  }

  while (queue.length > 0) {
    const entry = queue.shift()!;
    const { node: dir, depth } = entry;
    if (!dir || depth > maxDepth) continue;
    result.push({ path: dir.path, name: dir.name, node: dir, depth });
    for (const child of dir.children ?? []) {
      if (child.type === 'dir') queue.push({ node: child, depth: depth + 1 });
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
  const area = fileCount + WALL_THICKNESS * 4;
  const cols = Math.max(MIN_ROOM_SIZE, Math.min(12, Math.ceil(Math.sqrt(area))));
  const rows = Math.max(MIN_ROOM_SIZE, Math.ceil(area / cols));
  return { width: cols, height: rows };
}

// ─── Rect packing (shelf algorithm) ───────────────────────────────────────────
interface PlaceResult {
  fits: boolean;
  x?: number;
  y?: number;
  reason?: string;
}

function placeRoom(
  gridW: number,
  gridH: number,
  existingRooms: LocalRoom[],
  width: number,
  height: number,
  wallThick: number,
): PlaceResult {
  const SHELF_SPACE = 3;
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
  shelves.sort((a, b) => a.y - b.y);

  let cursorY = wallThick;
  for (const shelf of shelves) {
    let cursorX = wallThick;
    for (const r of shelf.rooms) cursorX = Math.max(cursorX, r.x + r.width + SHELF_SPACE);
    if (cursorX + width <= gridW - wallThick) return { fits: true, x: cursorX, y: shelf.y };
    const shelfBottom = Math.max(...shelf.rooms.map((r) => r.y + r.height));
    cursorY = Math.max(cursorY, shelfBottom + SHELF_SPACE);
  }

  if (cursorY + height <= gridH - wallThick) return { fits: true, x: wallThick, y: cursorY };
  return { fits: false, reason: 'vertical_overflow' };
}

function expandGrid(
  currentW: number,
  currentH: number,
  roomW: number,
  roomH: number,
  reason: string,
): { w: number; h: number } {
  if (reason === 'vertical_overflow') {
    return { w: currentW, h: Math.max(currentH * 2, currentH + roomH + 10) };
  }
  return { w: Math.max(currentW * 2, currentW + roomW + 10), h: currentH };
}

// ─── Room factory ──────────────────────────────────────────────────────────────
function makeRoom(
  folder: FolderEntry,
  x: number,
  y: number,
  width: number,
  height: number,
): LocalRoom {
  return {
    id: folder.path,
    label: folder.name,
    w: width,
    h: height,
    folderPath: folder.path,
    folderName: folder.name,
    x,
    y,
    width,
    height,
    workbenches: [],
  };
}

// ─── Workbench factory ─────────────────────────────────────────────────────────
function makeWorkbench(file: FileNode, repoId: string): Workbench {
  const ext = file.name.includes('.') ? file.name.split('.').pop()! : '';
  return {
    id: String(++_workbenchIdCounter),
    filePath: file.path,
    fileName: file.name,
    extension: ext,
    isTest: /\.(test|spec)\.[^.]+$/.test(file.name),
    repoPath: repoId,
  };
}

// ─── Grid builder ──────────────────────────────────────────────────────────────
function buildGrid(
  width: number,
  height: number,
  rooms: LocalRoom[],
  wallThick: number,
): LocalTile[][] {
  const grid: LocalTile[][] = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => ({
      x,
      y,
      type: 'floor' as LocalTileType,
      roomId: null,
      workbench: null,
    })),
  );

  for (const room of rooms) {
    const { x, y, width: w, height: h, workbenches } = room;

    for (let ry = y; ry < y + h; ry++) {
      for (let rx = x; rx < x + w; rx++) {
        if (!inBounds(rx, ry, width, height)) continue;
        const isWall = ry === y || ry === y + h - 1 || rx === x || rx === x + w - 1;
        grid[ry]![rx]!.type = isWall ? 'wall' : 'floor';
        grid[ry]![rx]!.roomId = room.id;
      }
    }

    const floorTiles: Array<{ x: number; y: number }> = [];
    for (let ry = y + wallThick; ry < y + h - wallThick; ry++) {
      for (let rx = x + wallThick; rx < x + w - wallThick; rx++) {
        if (inBounds(rx, ry, width, height)) floorTiles.push({ x: rx, y: ry });
      }
    }

    for (let i = 0; i < workbenches.length && i < floorTiles.length; i++) {
      const { x: tx, y: ty } = floorTiles[i]!;
      const tile = grid[ty]![tx]!;
      tile.type = 'workbench';
      tile.workbench = workbenches[i]!;
    }
  }

  return grid;
}

// ─── Corridors: connect adjacent rooms ─────────────────────────────────────────
function addCorridors(grid: LocalTile[][], rooms: LocalRoom[], gridW: number, gridH: number): void {
  if (rooms.length < 2) return;

  const sorted = [...rooms].sort((a, b) => (Math.abs(a.y - b.y) < 5 ? a.x - b.x : a.y - b.y));

  for (let i = 0; i < sorted.length - 1; i++) {
    const roomA = sorted[i]!;
    const roomB = sorted[i + 1]!;
    const y = Math.round((roomA.y + roomA.height / 2 + roomB.y + roomB.height / 2) / 2);
    const xStart = roomA.x + roomA.width - 1;
    const xEnd = roomB.x;
    for (let x = xStart; x <= xEnd; x++) {
      if (inBounds(x, y, gridW, gridH)) {
        const tile = grid[y]![x]!;
        if (tile.type === 'wall') tile.type = 'door';
      }
    }
  }
}

function inBounds(x: number, y: number, w: number, h: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h;
}
