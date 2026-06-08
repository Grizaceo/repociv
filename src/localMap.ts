// ─── RepoCiv — Local Map Generator ───────────────────────────────────────────
// Converts a repo file tree into a RimWorld-style 2D grid of rooms + workbenches.
// BFS traversal assigns each folder a rectangular "room" proportional to its file count.
// Files become "workbench" tiles inside their room.

import type { LocalWorld, LocalRoom, LocalTile, LocalTileType, Workbench, PowerGrid, PowerSource, PowerConsumer, LocalRestArea, RoomClimate, ClimateDevice, Vent } from './types.ts';

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

// Power constants
export const CONDUIT_SPACING = 4; // tiles between conduit lines
export const GENERATOR_WATTS = 2000;
export const BATTERY_STORED = 5000;
export const SOLAR_WATTS = 800;

// Temperature constants
export const HEATER_WATTS = 500;
export const COOLER_WATTS = 500;
export const DEFAULT_TARGET_TEMP = 21; // Celsius
export const HEAT_TRANSFER_RATE = 0.02; // per tick through doors/vents

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

  // Colocar un kiosko en una coordenada central de la primera sala para CDaily
  if (repoId.toLowerCase() === 'cdaily' && rooms.length > 0 && rooms[0]) {
    const room = rooms[0];
    const kx = room.x + Math.floor(room.width / 2);
    const ky = room.y + Math.floor(room.height / 2);
    if (grid[ky] && grid[ky][kx]) {
      grid[ky][kx].type = 'kiosk';
    }
  }

  // ─── Power System: place conduits + generators/batteries/solar ──────────────
  const { powerGrid, powerSources, powerConsumers } = placePowerSystem(grid, rooms, gridWidth, gridHeight);

  // ─── Rest Areas: place beds in bedroom/barracks rooms ───────────────────────
  const restAreas = placeRestAreas(grid, rooms, gridWidth, gridHeight);

  // ─── Temperature System: place heaters/coolers/vents ─────────────────────────
  const roomClimates = placeTemperatureSystem(grid, rooms, gridWidth, gridHeight);

  return { repoId, grid, rooms, width: gridWidth, height: gridHeight, workbenches, powerGrid, powerSources, powerConsumers, restAreas, roomClimates };
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
        else if (tile.type === 'floor') tile.type = 'path';
      }
      // Widen corridor visually: paint adjacent floor tiles as path
      for (const dy of [-1, 1]) {
        const ny = y + dy;
        if (inBounds(x, ny, gridW, gridH)) {
          const neighbor = grid[ny]![x]!;
          if (neighbor.type === 'floor') neighbor.type = 'path';
        }
      }
    }
  }
}

function inBounds(x: number, y: number, w: number, h: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h;
}

// ─── Power System Placement ───────────────────────────────────────────────────
interface PowerSystemResult {
  powerGrid: PowerGrid;
  powerSources: PowerSource[];
  powerConsumers: PowerConsumer[];
}

function placePowerSystem(
  grid: LocalTile[][],
  rooms: LocalRoom[],
  gridW: number,
  gridH: number,
): PowerSystemResult {
  const conduits = new Set<string>();
  const sources: PowerSource[] = [];
  const consumers: PowerConsumer[] = [];

  // 1. Place conduits along corridors (horizontal lines every CONDUIT_SPACING tiles)
  for (let y = 0; y < gridH; y += CONDUIT_SPACING) {
    for (let x = 0; x < gridW; x++) {
      if (!inBounds(x, y, gridW, gridH)) continue;
      const tile = grid[y]![x]!;
      if (tile.type === 'path' || tile.type === 'floor') {
        conduits.add(`${x},${y}`);
        // Only change visual type if it's path/floor (don't overwrite walls/doors)
        if (tile.type === 'path' || tile.type === 'floor') {
          tile.type = 'conduit';
        }
      }
    }
  }

  // 2. Vertical conduits connecting rooms to main horizontal lines
  for (const room of rooms) {
    const roomCenterX = room.x + Math.floor(room.width / 2);
    const roomCenterY = room.y + Math.floor(room.height / 2);

    // Find nearest horizontal conduit line
    let nearestConduitY = 0;
    let minDist = gridH;
    for (let y = 0; y < gridH; y += CONDUIT_SPACING) {
      const dist = Math.abs(y - roomCenterY);
      if (dist < minDist) {
        minDist = dist;
        nearestConduitY = y;
      }
    }

    // Vertical conduit from room to main line
    const startY = Math.min(roomCenterY, nearestConduitY);
    const endY = Math.max(roomCenterY, nearestConduitY);
    for (let y = startY; y <= endY; y++) {
      if (inBounds(roomCenterX, y, gridW, gridH)) {
        const tile = grid[y]![roomCenterX]!;
        conduits.add(`${roomCenterX},${y}`);
        if (tile.type === 'floor' || tile.type === 'path') {
          tile.type = 'conduit';
        }
      }
    }

    // 3. Place power source in each room (generator/battery/solar based on room type)
    const sourceType = pickPowerSourceType(room);
    const sourceX = room.x + 1; // Just inside wall
    const sourceY = room.y + 1;
    if (inBounds(sourceX, sourceY, gridW, gridH)) {
      const tile = grid[sourceY]![sourceX]!;
      if (tile.type === 'floor') {
        tile.type = 'power_source';
        sources.push({
          id: `src-${room.id}`,
          tileX: sourceX,
          tileY: sourceY,
          type: sourceType,
          outputWatts: getSourceWatts(sourceType),
          fuel: sourceType === 'generator' ? 100 : undefined,
        });
        // Connect source to room's conduit
        connectToConduit(grid, conduits, sourceX, sourceY, roomCenterX, roomCenterY, gridW, gridH);
      }
    }

    // 4. Place power consumers for each workbench in this room
    for (const wb of room.workbenches) {
      // Find workbench tile position
      let wbX = -1, wbY = -1;
      for (let ry = room.y + WALL_THICKNESS; ry < room.y + room.height - WALL_THICKNESS; ry++) {
        for (let rx = room.x + WALL_THICKNESS; rx < room.x + room.width - WALL_THICKNESS; rx++) {
          if (inBounds(rx, ry, gridW, gridH)) {
            const tile = grid[ry]![rx]!;
            if (tile.workbench?.id === wb.id) {
              wbX = rx;
              wbY = ry;
              break;
            }
          }
        }
        if (wbX !== -1) break;
      }
      if (wbX !== -1) {
        consumers.push({
          id: `cons-${wb.id}`,
          tileX: wbX,
          tileY: wbY,
          watts: wb.isTest ? 50 : 100, // tests use less power
          required: true,
          roomId: room.id,
        });
      }
    }
  }

  // Calculate totals
  let generatedWatts = 0;
  for (const src of sources) generatedWatts += src.outputWatts;
  let consumedWatts = 0;
  for (const cons of consumers) consumedWatts += cons.watts;

  const powerGrid: PowerGrid = {
    conduits,
    sources,
    consumers,
    storedWatts: sources.find(s => s.type === 'battery')?.fuel ? BATTERY_STORED : 0,
    generatedWatts,
    consumedWatts,
  };

  return { powerGrid, powerSources: sources, powerConsumers: consumers };
}

function pickPowerSourceType(room: LocalRoom): 'generator' | 'battery' | 'solar' | 'wind' {
  const name = room.folderName.toLowerCase();
  // Heuristic: src/ = generator, docs/ = solar, tests/ = wind, others = battery
  if (name === 'src' || name === 'lib' || name === 'app') return 'generator';
  if (name === 'docs' || name === 'doc') return 'solar';
  if (name === 'test' || name === 'tests' || name === 'spec') return 'wind';
  return 'battery';
}

function getSourceWatts(type: 'generator' | 'battery' | 'solar' | 'wind'): number {
  switch (type) {
    case 'generator': return GENERATOR_WATTS;
    case 'battery': return 0; // batteries store, don't generate
    case 'solar': return SOLAR_WATTS;
    case 'wind': return SOLAR_WATTS;
  }
}

function connectToConduit(
  grid: LocalTile[][],
  conduits: Set<string>,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  gridW: number,
  gridH: number,
): void {
  // L-shaped path: horizontal then vertical
  let x = fromX;
  let y = fromY;

  // Horizontal
  while (x !== toX) {
    x += x < toX ? 1 : -1;
    if (inBounds(x, y, gridW, gridH)) {
      const tile = grid[y]![x]!;
      if (tile.type === 'floor' || tile.type === 'path') {
        tile.type = 'conduit';
        conduits.add(`${x},${y}`);
      }
    }
  }
  // Vertical
  while (y !== toY) {
    y += y < toY ? 1 : -1;
    if (inBounds(x, y, gridW, gridH)) {
      const tile = grid[y]![x]!;
      if (tile.type === 'floor' || tile.type === 'path') {
        tile.type = 'conduit';
        conduits.add(`${x},${y}`);
      }
    }
  }
}

// ─── Rest Areas Placement ─────────────────────────────────────────────────────
function placeRestAreas(
  grid: LocalTile[][],
  rooms: LocalRoom[],
  gridW: number,
  gridH: number,
): LocalRestArea[] {
  const restAreas: LocalRestArea[] = [];

  for (const room of rooms) {
    // Only place beds in rooms that look like bedrooms/barracks
    const name = room.folderName.toLowerCase();
    const isBedroom = name === 'bedroom' || name === 'barracks' || name === 'sleep' || name === 'rest';
    // Also place in small rooms that could be bedrooms (1-2 workbenches max)
    const isSmallRoom = room.workbenches.length <= 2 && room.width * room.height <= 36;

    if (!isBedroom && !isSmallRoom) continue;

    // Calculate bed positions (along one wall, leaving space for door)
    const bedTiles: Array<{ x: number; y: number }> = [];
    const innerX0 = room.x + WALL_THICKNESS;
    const innerY0 = room.y + WALL_THICKNESS;
    const innerX1 = room.x + room.width - WALL_THICKNESS - 1;
    const innerY1 = room.y + room.height - WALL_THICKNESS - 1;
    const innerW = innerX1 - innerX0 + 1;
    const innerH = innerY1 - innerY0 + 1;

    // Place beds along the longer wall
    let bedCount = 0;
    const maxBeds = isBedroom ? Math.max(2, Math.floor(Math.min(innerW, innerH) / 2)) : 1;

    if (innerW >= innerH) {
      // Horizontal placement along bottom wall
      for (let i = 0; i < maxBeds && innerX0 + i * 2 + 1 <= innerX1; i++) {
        const bx = innerX0 + i * 2 + 1;
        const by = innerY1;
        if (inBounds(bx, by, gridW, gridH) && grid[by]?.[bx]?.type === 'floor') {
          grid[by][bx].type = 'bed';
          bedTiles.push({ x: bx, y: by });
          bedCount++;
        }
      }
    } else {
      // Vertical placement along right wall
      for (let i = 0; i < maxBeds && innerY0 + i * 2 + 1 <= innerY1; i++) {
        const bx = innerX1;
        const by = innerY0 + i * 2 + 1;
        if (inBounds(bx, by, gridW, gridH) && grid[by]?.[bx]?.type === 'floor') {
          grid[by][bx].type = 'bed';
          bedTiles.push({ x: bx, y: by });
          bedCount++;
        }
      }
    }

    if (bedCount > 0) {
      restAreas.push({
        id: `rest-${room.id}`,
        roomId: room.id,
        tiles: bedTiles,
        recoveryRate: 10, // fatigue per second
        capacity: bedCount,
        unitsInside: [],
      });
    }
  }

  return restAreas;
}

// ─── Temperature System Placement ─────────────────────────────────────────────
function placeTemperatureSystem(
  grid: LocalTile[][],
  rooms: LocalRoom[],
  gridW: number,
  gridH: number,
): Map<string, RoomClimate> {
  const roomClimates = new Map<string, RoomClimate>();

  for (const room of rooms) {
    const name = room.folderName.toLowerCase();
    
    // Decide climate devices based on room type
    let hasHeater = false;
    let hasCooler = false;
    const isServerRoom = name === 'server' || name === 'servers' || name === 'data';
    const isColdStorage = name === 'archive' || name === 'archives' || name === 'cold';
    const isHotRoom = name === 'build' || name === 'dist' || name === 'out' || isServerRoom;
    const isLivingSpace = name === 'bedroom' || name === 'barracks' || name === 'living' || name === 'lounge';

    if (isColdStorage) hasCooler = true;
    else if (isHotRoom) hasCooler = true; // servers need cooling
    else if (isLivingSpace) { hasHeater = true; hasCooler = true; } // comfort
    else if (Math.random() < 0.3) { hasHeater = true; hasCooler = true; } // random climate control

    const heaters: ClimateDevice[] = [];
    const coolers: ClimateDevice[] = [];
    const vents: Vent[] = [];

    const innerX0 = room.x + WALL_THICKNESS;
    const innerY0 = room.y + WALL_THICKNESS;
    const innerX1 = room.x + room.width - WALL_THICKNESS - 1;
    const innerY1 = room.y + room.height - WALL_THICKNESS - 1;

    // Place heater on one wall
    if (hasHeater) {
      const hx = innerX0;
      const hy = innerY0 + Math.floor((innerY1 - innerY0) / 2);
      if (inBounds(hx, hy, gridW, gridH) && grid[hy]?.[hx]?.type === 'floor') {
        grid[hy][hx].type = 'heater';
        const consumerId = `cons-heater-${room.id}`;
        heaters.push({
          id: `heater-${room.id}`,
          tileX: hx,
          tileY: hy,
          type: 'heater',
          powerWatts: HEATER_WATTS,
          powerConsumerId: consumerId,
        });
      }
    }

    // Place cooler on opposite wall
    if (hasCooler) {
      const cx = innerX1;
      const cy = innerY0 + Math.floor((innerY1 - innerY0) / 2);
      if (inBounds(cx, cy, gridW, gridH) && grid[cy]?.[cx]?.type === 'floor') {
        grid[cy][cx].type = 'cooler';
        const consumerId = `cons-cooler-${room.id}`;
        coolers.push({
          id: `cooler-${room.id}`,
          tileX: cx,
          tileY: cy,
          type: 'cooler',
          powerWatts: COOLER_WATTS,
          powerConsumerId: consumerId,
        });
      }
    }

    // Place vents on walls connecting to adjacent rooms (for heat transfer)
    // Find adjacent rooms and place vents on shared walls
    for (const otherRoom of rooms) {
      if (otherRoom.id === room.id) continue;
      
      // Check if rooms are adjacent horizontally
      const horizontalAdjacent = 
        (room.x + room.width === otherRoom.x || otherRoom.x + otherRoom.width === room.x) &&
        !(room.y + room.height <= otherRoom.y || otherRoom.y + otherRoom.height <= room.y);
      
      // Check if rooms are adjacent vertically
      const verticalAdjacent = 
        (room.y + room.height === otherRoom.y || otherRoom.y + otherRoom.height === room.y) &&
        !(room.x + room.width <= otherRoom.x || otherRoom.x + otherRoom.width <= room.x);

      if (horizontalAdjacent || verticalAdjacent) {
        // Place vent on shared wall
        let vx = -1, vy = -1;
        if (horizontalAdjacent) {
          // Vent on vertical shared wall
          vx = room.x + room.width === otherRoom.x ? room.x + room.width - 1 : room.x;
          vy = Math.max(room.y + WALL_THICKNESS, otherRoom.y + WALL_THICKNESS);
        } else if (verticalAdjacent) {
          // Vent on horizontal shared wall
          vy = room.y + room.height === otherRoom.y ? room.y + room.height - 1 : room.y;
          vx = Math.max(room.x + WALL_THICKNESS, otherRoom.x + WALL_THICKNESS);
        }
        
        if (vx !== -1 && inBounds(vx, vy, gridW, gridH)) {
          const tile = grid[vy]?.[vx];
          if (tile != null && tile.type === 'wall') {
            tile.type = 'vent';
            vents.push({
              id: `vent-${room.id}-${otherRoom.id}`,
              tileX: vx,
              tileY: vy,
              connectedRoomId: otherRoom.id,
              open: true,
            });
          }
        }
      }
    }

    roomClimates.set(room.id, {
      roomId: room.id,
      temperature: DEFAULT_TARGET_TEMP,
      targetTemperature: DEFAULT_TARGET_TEMP,
      heaters,
      coolers,
      vents,
    });
  }

  return roomClimates;
}
