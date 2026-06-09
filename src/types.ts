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
  | 'codex'
  | 'cursor';

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
  // ─── Swarm Civ: subagent detachments ─────────────────────────────
  parentUnitId?: string;
  ephemeral?: boolean;
  subagentRunId?: string;
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
  cursor: '#a0d6c8',
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

export type SubagentStatus = 'proposed' | 'running' | 'complete' | 'failed' | 'cancelled';
export type SubagentRisk = 'low' | 'medium' | 'high' | 'destructive';

export interface SubagentRun {
  id: string;
  parentMissionId: string;
  parentUnitId: string;
  kind: string;
  label: string;
  status: SubagentStatus;
  risk: SubagentRisk;
  targetCityId?: string;
  targetRepo?: string;
  ephemeralUnitId?: string;
  startedAt: number;
  completedAt?: number | null;
  summary?: string;
  unitType?: UnitType;
  /** Harness of the parent mission when spawn was detected. */
  parentHarness?: string;
  /** Effective harness for this subagent (defaults to parentHarness). */
  harness?: string;
  /** Last progress event timestamp for live Orden sorting. */
  lastProgressAt?: number;
  /** Background Task output_file when reported by harness. */
  outputFilePath?: string;
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

// ─── Local Rest Area (RimWorld-style bedroom/barracks) ────────────────────────
export interface LocalRestArea {
  id: string;
  roomId: string; // maps to LocalRoom.id
  tiles: Array<{ x: number; y: number }>; // bed tiles
  recoveryRate: number; // fatigue restored per second (default 10)
  capacity: number; // max units at once = bed count
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
      parentUnit?: string;
      ephemeral?: boolean;
      subagentRunId?: string;
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
  | { type: 'fog_reveal'; hexes: [number, number][]; sourceSubagentId?: string; cityId?: string }
  | {
      type: 'subagent_spawn';
      subagentId: string;
      parentMissionId: string;
      parentUnit: string;
      kind: string;
      label: string;
      hex: [number, number];
      unitType?: UnitType;
      risk: string;
      ephemeralUnitId: string;
      targetCityId?: string;
      status?: 'proposed' | 'running';
      parentHarness?: string;
      harness?: string;
    }
  | {
      type: 'subagent_progress';
      subagentId: string;
      phase?: string;
      text?: string;
    }
  | {
      type: 'subagent_complete';
      subagentId: string;
      success: boolean;
      summary: string;
      duration: number;
      ephemeralUnitId?: string;
      outputFilePath?: string;
    }
  | {
      type: 'subagent_proposed';
      subagentId: string;
      parentMissionId: string;
      parentUnit: string;
      kind: string;
      label: string;
      risk: string;
      approvalRequired: boolean;
      commandId: string;
    }
  | {
      type: 'subagent_cancel';
      subagentId: string;
      reason?: string;
    }
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
export type LocalTileType =
  | 'floor'
  | 'wall'
  | 'door'
  | 'workbench'
  | 'debris'
  | 'kiosk'
  | 'path'
  // Power System
  | 'conduit'
  | 'power_source'
  | 'power_consumer'
  // Temperature / HVAC
  | 'heater'
  | 'cooler'
  | 'vent'
  // Zoning / Stockpiles
  | 'stockpile'
  | 'joy_object'
  | 'bed'
  // Research
  | 'research_bench'
  // ─── Office Redesign (Phase 1) ────────────────────────────────────────
  | 'meeting_room' // glass-walled collab space (central table)
  | 'phone_booth' // 1-person focus pod
  | 'break_area' // kitchen/lounge/coffee counter
  | 'standing_desk' // elevated workstation
  | 'whiteboard' // collaboration wall
  | 'server_rack' // infra hub
  | 'planter' // biophilic element
  | 'reception' // entry lobby desk
  | 'stairs' // vertical circulation (decorative)
  | 'window' // natural light zone (perimeter glass)
  | 'sofa' // informal seating
  | 'watercooler' // social node
  // ─── Office cubicle layout ─────────────────────────────────────────────
  | 'cubicle_partition' // low cubicle divider (impassable)
  | 'aisle' // interior corridor (preferred routing)
  | 'chair'; // desk chair tile

export type CubicleFacing = 'n' | 's' | 'e' | 'w';

export interface CubiclePlan {
  template: 'open_rows' | 'focus_pod' | 'reception';
  aisleWidth: number;
  deskCount: number;
}

export interface LocalTile {
  x: number; // grid column
  y: number; // grid row
  type: LocalTileType;
  roomId: string | null;
  workbench: Workbench | null;
  facing?: CubicleFacing;
  decor?: 'focus_lamp' | 'coffee_machine' | 'desk_bundle';
}

export interface Workbench {
  id: string; // unique numeric id
  filePath: string; // absolute path
  fileName: string;
  extension: string; // 'ts', 'py', etc.
  isTest: boolean; // *.test.ts pattern
  repoPath: string; // which repo this belongs to
}

// ─── Office Zone Classification (Phase 2) ────────────────────────────────────
export type OfficeZoneType =
  | 'team_cluster'
  | 'meeting'
  | 'focus'
  | 'break'
  | 'infra'
  | 'reception'
  | 'biophilic';

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
  // ─── Office Redesign (Phase 2) ────────────────────────────────────────
  zoneType?: OfficeZoneType; // semantic office zone
  zoneLabel?: string; // display label for zone (e.g. "Engineering")
  subFolderNames?: string[]; // child directory names for whiteboard panel
  layoutPlan?: CubiclePlan; // cubicle module metadata from officeLayout
}

export interface LocalWorld {
  repoId: string;
  grid: LocalTile[][]; // [y][x]
  rooms: LocalRoom[];
  width: number; // in tiles
  height: number;
  workbenches: Workbench[];
  // Power System (RimWorld-style)
  powerGrid?: PowerGrid;
  powerSources?: PowerSource[];
  powerConsumers?: PowerConsumer[];
  // Zoning System
  zones?: Zone[];
  // Rest Areas (bedrooms/barracks)
  restAreas?: LocalRestArea[];
  // Temperature System
  roomClimates?: Map<string, RoomClimate>;
  // Stationary NPCs (managers, receptionists)
  npcs?: LocalNpc[];
  // Desk assignments: maps "x,y" desk position → unit ID (Phase B)
  deskAssignments: Map<string, string>;
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
  ephemeral?: boolean; // subagent detachment in local view
  assignedDesk?: { x: number; y: number } | null; // stable desk assignment in their room
}

export interface LocalNpc {
  id: string;
  name: string;
  color: string;
  gridX: number;
  gridY: number;
  roomId: string;
  type: 'manager'; // future: receptionist, security
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

// ─── Power System (RimWorld-style) ─────────────────────────────────────────────
export type PowerTileType = 'conduit' | 'generator' | 'battery' | 'solar' | 'wind' | 'consumer';

export interface PowerGrid {
  conduits: Set<string>; // "x,y" keys
  sources: PowerSource[];
  consumers: PowerConsumer[];
  storedWatts: number;
  generatedWatts: number;
  consumedWatts: number;
}

export interface PowerSource {
  id: string;
  tileX: number;
  tileY: number;
  type: 'generator' | 'battery' | 'solar' | 'wind';
  outputWatts: number;
  fuel?: number; // 0-100 for generator
}

export interface PowerConsumer {
  id: string;
  tileX: number;
  tileY: number;
  watts: number;
  required: boolean; // workbench = true, light = false
  roomId: string | null;
}

// ─── Temperature / HVAC System ─────────────────────────────────────────────────
export interface RoomClimate {
  roomId: string;
  temperature: number; // Celsius
  targetTemperature: number;
  heaters: ClimateDevice[];
  coolers: ClimateDevice[];
  vents: Vent[];
}

export interface ClimateDevice {
  id: string;
  tileX: number;
  tileY: number;
  type: 'heater' | 'cooler';
  powerWatts: number;
  powerConsumerId: string;
}

export interface Vent {
  id: string;
  tileX: number;
  tileY: number;
  connectedRoomId: string;
  open: boolean;
}

// ─── Stockpile / Zoning System ─────────────────────────────────────────────────
export type ZoneType = 'stockpile' | 'growing' | 'recreation' | 'bedroom' | 'dining' | 'hospital';

export interface Zone {
  id: string;
  type: ZoneType;
  tiles: Array<{ x: number; y: number }>;
  filters: StockpileFilter[];
  priority: number; // 1-4
}

export interface StockpileFilter {
  category: 'code' | 'test' | 'config' | 'doc' | 'asset' | 'binary';
  extensions: string[];
  allowed: boolean;
}

// ─── Joy / Needs / Mood ────────────────────────────────────────────────────────
export interface UnitNeeds {
  rest: number;       // 0-100 (100 = rested)
  food: number;       // 0-100
  joy: number;        // 0-100
  comfort: number;    // 0-100 (room impressiveness)
}

export interface Thought {
  text: string;
  moodImpact: number; // -50 a +50
  timestamp: number;
  source: 'environment' | 'social' | 'work' | 'health';
}

// ─── Research ──────────────────────────────────────────────────────────────────
export interface ResearchProject {
  id: string;
  name: string;
  description: string;
  cost: number; // science points
  progress: number;
  unlocked: string[]; // feature flags
  requiredTech: string[];
}

// ─── Incidents ─────────────────────────────────────────────────────────────────
export type IncidentType =
  | 'code_review_raid'
  | 'dependency_rot'
  | 'burnout'
  | 'inspiration'
  | 'power_outage'
  | 'thermal_shock';

export interface Incident {
  id: string;
  type: IncidentType;
  severity: 'minor' | 'major' | 'critical';
  message: string;
  affectedRooms: string[];
  affectedUnits: string[];
  startedAt: number;
  expiresAt: number | null;
  resolved: boolean;
}

// ─── Extended LocalWorld with RimWorld systems ─────────────────────────────────
export interface LocalWorldRimWorld extends LocalWorld {
  powerGrid?: PowerGrid;
  roomClimates?: Map<string, RoomClimate>;
  zones?: Zone[];
  researchProjects?: ResearchProject[];
  incidents?: Incident[];
  storytellerState?: 'randy_random' | 'cassandra_classic' | 'phoebe_chill';
}

// ─── LocalTileType extended ────────────────────────────────────────────────────
// Adding power/climate/zone tile types
export type LocalTileTypeExtended = LocalTileType
  | 'conduit'
  | 'power_source'
  | 'power_consumer'
  | 'heater'
  | 'cooler'
  | 'vent'
  | 'stockpile'
  | 'joy_object'
  | 'bed'
  | 'research_bench';

// ─── Renderer state ────────────────────────────────────────────────────────────

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
