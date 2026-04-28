// ─── RepoCiv — Core Types ─────────────────────────────────────────────────────

import type { Axial } from './hex.ts';

// ─── Terrain types (inferred from repo contents) ─────────────────────────────
export type Terrain =
  | 'plains'    // .ts/.tsx/.js/.jsx — web/frontend
  | 'forest'    // .py/.ipynb — ML/data science
  | 'mountain'  // .cpp/.rs/.go — systems/low-level
  | 'desert'   // .md/.txt/.json/.yaml/.toml — config/docs
  | 'ocean'     // empty / no real code
  | 'ice';      // archived / legacy (>180 days no commits)

// ─── Tile ─────────────────────────────────────────────────────────────────
export interface Tile {
  coord: Axial;
  terrain: Terrain;
  city?: City;
  district?: District;
  resources: TileResources;
  inFog: boolean;
  revealed: boolean;
  skillHealth?: 'ok' | 'stale' | 'broken';
  sessionTint?: 'bright' | 'normal' | 'fog';
}

export interface TileResources {
  gold: number;       // commits / lines added
  science: number;    // test coverage / validations
  production: number; // features / PRs
}

// ─── City ─────────────────────────────────────────────────────────────────
export interface City {
  id: string;
  name: string;
  coord: Axial;
  population: number;   // total files in repo
  territory: Axial[];   // hexes controlled (range 2)
  districts: District[];
  buildings: Building[];
  currentProject?: Building; // what's being built right now
  isCapital: boolean;
}

export interface District {
  id: string;
  name: string;         // subdirectory name
  type: 'campus' | 'industrial' | 'commercial' | 'encamp' | 'aqueduct';
  coord: Axial;
}

// ─── Building & Wonder ─────────────────────────────────────────────────────
export type BuildingState = 'planned' | 'building' | 'complete' | 'failed';

export interface Building {
  id: string;
  name: string;
  type: 'building' | 'wonder';
  cityId: string;
  progress: number;       // 0–100
  durationSeconds: number;
  elapsedSeconds: number;
  state: BuildingState;
  sourceProcess?: {
    pid?: number;
    cmd?: string;
    startTime: number;
  };
}

// ─── Unit / Agent ───────────────────────────────────────────────────────────
export type UnitType = 'hero' | 'worker' | 'scout' | 'army' | 'caravan' | 'lexo';
export type UnitState = 'idle' | 'moving' | 'working' | 'sleeping' | 'building';

export interface Unit {
  id: string;
  name: string;
  type: UnitType;
  civ: string;            // "gris"
  coord: Axial;           // current position
  targetCoord?: Axial;    // destination (while moving)
  path: Axial[];          // A* path
  pathIndex: number;      // current step in path
  pathProgress: number;   // 0–1 tween between path[pathIndex] and path[pathIndex+1]
  state: UnitState;
  mission?: string;
  workProgress?: number; // 0–100 when working
  speed: number;          // hexes per second
  color: string;
  movesLeft: number;      // remaining movement points this "turn"
  maxMoves: number;
}

export const UNIT_COLORS: Record<string, string> = {
  hero:    '#c8a84b',
  worker:  '#5b9b5b',
  scout:   '#5b9bd5',
  army:    '#d45b5b',
  caravan: '#9b5bd4',
  lexo:    '#b86ce8',
};

// ─── World ──────────────────────────────────────────────────────────────────
export interface World {
  tiles: Map<string, Tile>; // key = "q,r"
  cities: City[];
  units: Unit[];
  buildings: Building[];
  resources: TileResources;
  generatedAt: number;
}

// ─── Bridge Events (from bridge.py → RepoCiv) ───────────────────────────────
export type BridgeEvent =
  | { type: 'unit_spawn';    unit: string; civ: string; hex: [number, number]; mission?: string; unitType?: UnitType }
  | { type: 'unit_move';     unit: string; from: [number, number]; to: [number, number]; mission?: string }
  | { type: 'unit_work';     unit: string; hex: [number, number]; progress: number; mission?: string }
  | { type: 'unit_state';   unit: string; state: UnitState }
  | { type: 'building_start';   city: string; building: string; durationSeconds: number; buildingType?: 'building' | 'wonder'; pid?: number; cmd?: string; missionId?: string }
  | { type: 'building_progress'; city: string; building: string; progress: number }
  | { type: 'building_complete'; city: string; building: string; missionId?: string }
  | { type: 'building_failed';   city: string; building: string; missionId?: string }
  | { type: 'city_founder';  name: string; hex: [number, number] }
  | { type: 'resource_update'; resource: 'gold' | 'science' | 'production'; delta: number }
  | { type: 'fog_reveal';    hexes: [number, number][] }
  | { type: 'mission_start';    missionId: string; unit: string; questName: string }
  | { type: 'mission_complete'; missionId: string; unit: string; success: boolean; duration: number }
  | { type: 'chat_chunk';       unit: string; missionId?: string; text: string }
  | { type: 'log';              msg: string; level?: 'info' | 'warn' | 'success' };

// ─── Renderer state ─────────────────────────────────────────────────────────
export type RendererState = 'no_input' | 'hover' | 'click' | 'drag' | 'animation';

// ─── Helpers ───────────────────────────────────────────────────────────────
export function tileKey(coord: Axial): string {
  return `${coord.q},${coord.r}`;
}

export function parseTileKey(key: string): Axial {
  const [q, r] = key.split(',').map(Number);
  if (q === undefined || r === undefined) return { q: 0, r: 0 };
  return { q, r };
}
