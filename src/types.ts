// ─── RepoCiv — Core Types ─────────────────────────────────────────────────────

import type { Axial } from './hex.ts';

export interface CDailyArticle {
  id: number;
  title: string;
  url: string;
  publishedDate: string;
  blogName: string;
  category?: string;
  emoji?: string;
}

// ─── Foreign Relations Report ─────────────────────────────────────────────────
export interface ForeignRelationsReport {
  id: string;
  createdAt: string;
  articleIds: string[];
  targetCityId: string;
  targetRepoPath: string;
  agentId: string;
  title: string;
  summary: string;
  impact: 'none' | 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  markdown: string;
  evidence: Array<{
    type: 'article' | 'repo_file' | 'event' | 'graph';
    ref: string;
    quote?: string;
  }>;
  recommendations: Array<{
    label: string;
    risk: 'safe' | 'approval' | 'manual';
    command?: string;
  }>;
  requiresFollowUp?: boolean;
  llmUnavailable?: boolean;
}

export interface RepoProfile {
  repoPath: string;
  repoName: string;
  readmePreview: string;
  manifestSnippet: string | null;
  manifestType: string | null;
  topLevelDirs: string[];
  recentFilesCount: number;
  recentFiles: string[];
  skillTags: string[];
  isGitRepo: boolean;
}

export interface ArticleRepoScore {
  score: number;
  confidence: string;
  shouldTriggerLLM: boolean;
  dimensions: {
    keywordOverlap: number;
    tfidfScore: number;
    categoryFit: number;
    manifestFit: number;
    eventFit: number;
  };
}

export interface ForeignScoreResponse {
  scoring: ArticleRepoScore;
  profile: {
    repoName: string;
    repoPath: string;
    topLevelDirs: string[];
    recentFilesCount: number;
    skillTags: string[];
  };
}

// ─── Terrain types (inferred from repo contents) ─────────────────────────────
export type Terrain =
  | 'plains' // .ts/.tsx/.js/.jsx — web/frontend
  | 'forest' // .py/.ipynb — ML/data science
  | 'mountain' // .cpp/.rs/.go — systems/low-level
  | 'desert' // .md/.txt/.json/.yaml/.toml — config/docs
  | 'ocean' // empty / no real code
  | 'ice' // archived / legacy (>180 days no commits)
  | 'hills' // mixed / generic
  | 'sacred'; // imperial wonder districts (capital buildings)

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
  // Estructura de carpetas (para casillas intermedias que conectan ciudades desconectadas)
  folderStructure?: string[]; // Lista de rutas de carpetas del repo principal
}

export interface TileResources {
  gold: number; // commits / lines added
  science: number; // test coverage / validations
  production: number; // features / PRs
}

// ─── City ─────────────────────────────────────────────────────────────────
export interface City {
  id: string;
  name: string;
  coord: Axial;
  /** Filesystem path from scanned repo / manual layout (optional for legacy saves). */
  repoPath?: string;
  population: number; // total files in repo
  territory: Axial[]; // hexes controlled (range 2)
  districts: District[];
  buildings: Building[];
  wonders?: Building[]; // Edificios tipo wonder construidos en esta ciudad
  currentProject?: Building; // what's being built right now
  isCapital: boolean;
}

export interface District {
  id: string;
  name: string; // subdirectory name
  type: 'campus' | 'industrial' | 'commercial' | 'encamp' | 'aqueduct' | 'wonder';
  coord: Axial;
  /** For wonder districts: which wonder type this district represents. */
  wonderType?: WonderType;
}

// ─── Building & Wonder ─────────────────────────────────────────────────────
export type BuildingState = 'planned' | 'building' | 'complete' | 'failed';

export type WonderType = 'gaceta' | 'bibliotheca' | 'institutum';

export interface Building {
  id: string;
  name: string;
  type: 'building' | 'wonder';
  wonderType?: WonderType;
  cityId: string;
  progress: number; // 0–100
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
export type UnitType =
  | 'hero'
  | 'worker'
  | 'scout'
  | 'army'
  | 'caravan'
  | 'lexo'
  | 'openclaw'
  | 'claude'
  | 'codex';

export type UnitState = 'idle' | 'moving' | 'working' | 'sleeping' | 'building';

export interface Unit {
  id: string;
  name: string;
  type: UnitType;
  civ: string; // "gris"
  coord: Axial; // current position
  targetCoord?: Axial; // destination (while moving)
  path: Axial[]; // A* path
  pathIndex: number; // current step in path
  pathProgress: number; // 0–1 tween between path[pathIndex] and path[pathIndex+1]
  state: UnitState;
  mission?: string;
  cityId?: string; // which city/repo this unit is working at
  workProgress?: number; // 0–100 when working
  speed: number; // hexes per second
  color: string;
  movesLeft: number; // remaining movement points this "turn"
  maxMoves: number;
  // ─── Phase 9: XCOM Context Fatigue ───────────────────────────────
  fatigue: number; // 0–100 (100 = fresh, 0 = exhausted)
  maxFatigue: number; // always 100
  isResting: boolean; // true when in a rest area
  restingRoomId?: string; // which rest area room they're recovering in
  effectiveSpeed: number; // speed after fatigue penalty (computed)
  trailPositions?: { q: number; r: number }[]; // last 5 hex positions (index 0=oldest, 4=most recent)
}

export const UNIT_COLORS: Record<string, string> = {
  hero: '#c8a84b',
  worker: '#5b9b5b',
  scout: '#5b9bd5',
  army: '#d45b5b',
  caravan: '#9b5bd4',
  lexo: '#b86ce8',
  openclaw: '#7bd6c8',
  claude: '#d4a574',
  codex: '#e87d7d',
};

// ─── World ──────────────────────────────────────────────────────────────────
export interface World {
  tiles: Map<string, Tile>; // key = "q,r"
  cities: City[];
  units: Unit[];
  buildings: Building[];
  resources: TileResources;
  generatedAt: number;
  restAreas: RestArea[]; // Phase 9: Context Fatigue
}

// ─── Rest Area (Phase 9: XCOM Context Fatigue) ─────────────────────────────
export interface RestArea {
  id: string;
  roomId: string; // maps to LocalRoom.id
  coord: Axial; // hex center
  recoveryRate: number; // fatigue restored per second (default 8)
  capacity: number; // max units at once
  unitsInside: string[]; // unit ids currently resting
}

// ─── Bridge Events (from bridge.py → RepoCiv) ───────────────────────────────
export type BridgeEvent =
  | {
      type: 'unit_spawn';
      unit: string;
      civ: string;
      hex: [number, number];
      mission?: string;
      unitType?: UnitType;
      cityId?: string;
    }
  | {
      type: 'unit_move';
      unit: string;
      from: [number, number];
      to: [number, number];
      mission?: string;
    }
  | {
      type: 'unit_work';
      unit: string;
      hex?: [number, number];
      progress: number;
      mission?: string;
      cityId?: string;
    }
  | { type: 'unit_despawn'; unit: string; mission?: string }
  | { type: 'unit_state'; unit: string; state: UnitState }
  | {
      type: 'building_start';
      city: string;
      building: string;
      durationSeconds: number;
      buildingType?: 'building' | 'wonder';
      pid?: number;
      cmd?: string;
      missionId?: string;
    }
  | { type: 'building_progress'; city: string; building: string; progress: number }
  | { type: 'building_complete'; city: string; building: string; missionId?: string }
  | { type: 'building_failed'; city: string; building: string; missionId?: string }
  // Phase 9: Context Fatigue events
  | {
      type: 'rest_area_discovered';
      restArea: {
        id: string;
        roomId: string;
        coord: [number, number];
        recoveryRate: number;
        capacity: number;
        unitsInside: string[];
      };
    }
  | { type: 'rest_area_entered'; unit: string; restAreaId: string }
  | { type: 'rest_area_exited'; unit: string; restAreaId: string }
  | {
      type: 'unit_fatigue_update';
      unit: string;
      fatigue: number;
      maxFatigue?: number;
      atRest?: boolean;
      restAreaId?: string | null;
    }
  | {
      type: 'unit_sent_to_rest';
      unit: string;
      restAreaId: string;
      fatigue: number;
      maxFatigue: number;
      atRest: boolean;
    }
  | { type: 'context_exhausted'; unit: string; hex: [number, number] }
  | { type: 'city_founder'; name: string; hex: [number, number] }
  | { type: 'resource_update'; resource: 'gold' | 'science' | 'production'; delta: number }
  | { type: 'fog_reveal'; hexes: [number, number][] }
  | { type: 'mission_start'; missionId: string; unit: string; questName: string }
  | {
      type: 'mission_complete';
      missionId: string;
      unit: string;
      success: boolean;
      duration: number;
    }
  | {
      type: 'waiting_approval';
      commandId: string;
      commandType: string;
      target: string;
      risk: string;
    }
  | { type: 'chat_chunk'; unit: string; missionId?: string; text: string }
  | { type: 'log'; msg: string; level?: 'info' | 'warn' | 'success' };

// ─── Renderer state ─────────────────────────────────────────────────────────
// ─── View Mode ────────────────────────────────────────────────────────────────
export type ViewMode = 'macro' | 'local';

// ─── Local view types (RimWorld grid) ─────────────────────────────────────────
export type LocalTileType = 'floor' | 'wall' | 'door' | 'workbench' | 'debris' | 'kiosk' | 'path';

export interface LocalTile {
  x: number; // grid column
  y: number; // grid row
  type: LocalTileType;
  roomId: string | null;
  workbench: Workbench | null;
}

export interface Workbench {
  id: string; // unique numeric id
  filePath: string; // absolute path
  fileName: string;
  extension: string; // 'ts', 'py', etc.
  isTest: boolean; // *.test.ts pattern
  repoPath: string; // which repo this belongs to
}

export interface LocalRoom {
  id: string;
  label: string; // display name (same as folderName)
  w: number; // alias for width
  h: number; // alias for height
  folderPath: string; // e.g. "src/ui"
  folderName: string; // e.g. "ui"
  x: number; // top-left grid corner
  y: number;
  width: number; // tiles
  height: number; // tiles
  workbenches: Workbench[];
}

export interface LocalWorld {
  repoId: string;
  grid: LocalTile[][]; // [y][x]
  rooms: LocalRoom[];
  width: number; // in tiles
  height: number;
  workbenches: Workbench[];
}

// ─── Local Unit State (Phase 7a) ───────────────────────────────────────────────
export type AgentTask = 'explore' | 'plan' | 'debug' | 'code' | 'adversarial_review';

export type LocalUnitState =
  | 'idle_in_room'
  | 'walking_to_workbench'
  | 'walking_to_room'
  | 'working_on_file'
  | 'resting';

export interface LocalUnit {
  id: string;
  name: string;
  unitType: Unit['type'];
  color: string;
  // position on local grid
  gridX: number;
  gridY: number;
  targetX: number | null;
  targetY: number | null;
  path: Array<{ x: number; y: number }>;
  pathIndex: number;
  pathProgress: number; // 0-1 tween
  state: LocalUnitState;
  mission: string | null;
  workProgress: number; // 0-100
  // pointer back to macro unit
  macroUnitId: string;
  // currently-assigned workbench in local view
  currentWorkbenchId: string | null;
  // Spatial awareness: which room the unit is currently inside
  currentRoomId?: string | null;
  // ─── Phase 9: XCOM Context Fatigue ───────────────────────────────
  fatigue: number; // 0–100 (100 = fresh, 0 = exhausted)
  maxFatigue: number; // always 100
  isResting: boolean; // true when resting in a rest area room
  restingRoomId?: string;
  effectiveSpeed: number; // local grid movement speed after fatigue penalty
  assignedTask?: AgentTask | null; // player-assigned job focus (frontend-only)
}

export interface LocalMission {
  id: string;
  unitId: string;
  repoId: string;
  filePath: string;
  fileName: string;
  status: 'queued' | 'walking' | 'working' | 'complete' | 'failed';
  assignedAt: number; // timestamp (ms) when queued
  startedAt: number | null;
  completedAt: number | null;
  workbenchId: string;
  workbench: Workbench | null; // resolved at dispatch time
  progress: number; // 0-100 (updated while working)
}

// ─── Renderer state ────────────────────────────────────────────────────────────

export function tileKey(coord: Axial): string {
  return `${coord.q},${coord.r}`;
}

// ─── Map Layers ───────────────────────────────────────────────────────────────
// Visibility toggles for information overlays on the hex map.
// Each layer can be independently shown/hidden to reduce visual noise.

export type MapLayerId =
  | 'base' // terrain, cities, agents — always on
  | 'structure' // folder structure, buildings, wonder sprites
  | 'ops' // tasks, active experiments, approvals, failures
  | 'knowledge' // bibliotheca relations, suggested connections
  | 'labs' // lab warnings, experiment activity indicators
  | 'security' // lab alarms, experiment locks, perimeter alerts
  | 'labels'; // city labels, district labels, folder labels

export interface MapLayerState {
  layers: Record<MapLayerId, boolean>;
}

export const DEFAULT_MAP_LAYERS: MapLayerState = {
  layers: {
    base: true,
    structure: true,
    ops: false,
    knowledge: false,
    labs: false,
    security: false,
    labels: true,
  },
};
