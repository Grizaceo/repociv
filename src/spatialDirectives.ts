// ─── RepoCiv — Spatial Directives (Fase 5) ────────────────────────────────────
// Translates spatial gestures on the hex map into structured CommandDrafts.
// Every gesture produces a SpatialDirective with a preview; nothing executes
// until the user confirms. This is the "gesture → intent → policy → queue" layer.

import type { Unit, Tile, City } from './types.ts';
import type { Axial } from './hex.ts';
import { draftCommand, type CommandDraft, type CommandType } from './commandSchema.ts';
import { canExecute } from './agentCapabilities.ts';

// ─── Core types ───────────────────────────────────────────────────────────────

export type GestureType =
  | 'drag_unit_to_city'
  | 'drag_unit_to_unit'
  | 'drag_city_to_city'
  | 'area_select'
  | 'right_click'
  | 'drag_unit_to_file'
  | 'drop_card_on_unit';

export interface SpatialDirective {
  gesture: GestureType;
  sourceCoord: Axial;
  targetCoord?: Axial;
  sourceUnitId?: string;
  sourceCityId?: string;
  targetCityId?: string;
  targetUnitId?: string;
  selectedCityIds?: string[];
  shiftHeld: boolean;
  draft: CommandDraft;
  label: string; // human-readable: "DAVI → repociv: inspect_repo"
  confidence: number; // 0–1: how confident is the interpretation
  userConfirmed: boolean;
}

// ─── Context menu item ────────────────────────────────────────────────────────
export interface ContextMenuItem {
  label: string;
  icon: string;
  draft?: CommandDraft;
  action?: () => void;
  risk: 'low' | 'medium' | 'high' | 'destructive';
  hotkey?: string;
}

// ─── Drag unit → city ─────────────────────────────────────────────────────────
export function interpretUnitDrag(params: {
  unit: Unit;
  fromCoord: Axial;
  toTile: Tile;
  shiftHeld: boolean;
}): SpatialDirective | null {
  const { unit, fromCoord, toTile, shiftHeld } = params;
  const city: City | undefined = toTile.city;

  if (!city) {
    // Drag to empty tile → move order (not a command directive)
    return null;
  }

  // Shift+drag → run tests if they exist, otherwise inspect
  const cmdType: CommandType = shiftHeld ? 'run_tests' : 'inspect_repo';
  const missionText = shiftHeld
    ? `Ejecutar tests en ${city.name}`
    : `Inspeccionar repo ${city.name}`;

  const draft = draftCommand(cmdType, city.id, {
    unit: unit.id,
    city: city.id,
    mission: missionText,
    agentType: unit.type,
  });

  return {
    gesture: 'drag_unit_to_city',
    sourceCoord: fromCoord,
    targetCoord: toTile.coord,
    sourceUnitId: unit.id,
    targetCityId: city.id,
    shiftHeld,
    draft,
    label: `${unit.id} → ${city.name}: ${cmdType}`,
    confidence: 0.9,
    userConfirmed: false,
  };
}

// ─── Drag city → city (Shift+drag) ────────────────────────────────────────────
export function interpretCityToCityDrag(params: {
  fromCity: City;
  toCity: City;
  fromCoord: Axial;
  toCoord: Axial;
  selectedUnit: Unit | null;
}): SpatialDirective | null {
  const { fromCity, toCity, fromCoord, toCoord, selectedUnit } = params;
  const unit = selectedUnit?.id ?? 'MAIN';
  const draft = draftCommand('execute_agent', `${fromCity.id}→${toCity.id}`, {
    unit,
    city: fromCity.id,
    targetCity: toCity.id,
    mission: `Trade route workflow: ${fromCity.name} → ${toCity.name}`,
    agentType: selectedUnit?.type ?? 'hero',
  });

  return {
    gesture: 'drag_city_to_city',
    sourceCoord: fromCoord,
    targetCoord: toCoord,
    sourceCityId: fromCity.id,
    targetCityId: toCity.id,
    shiftHeld: true,
    draft,
    label: `${fromCity.name} → ${toCity.name}: workflow multi-repo`,
    confidence: 0.75,
    userConfirmed: false,
  };
}

// ─── Area select (Shift + rubber-band) ────────────────────────────────────────
export function interpretAreaSelect(params: {
  tiles: Tile[];
  selectedUnit: Unit | null;
}): SpatialDirective | null {
  const { tiles, selectedUnit } = params;
  const cities = tiles.filter((t) => t.city).map((t) => t.city!);
  if (cities.length === 0) return null;

  const unit = selectedUnit?.id ?? 'SCOUT';
  const cityIds = cities.map((c) => c.id);
  const draft = draftCommand('inspect_repo', cityIds.join(','), {
    unit,
    cities: cityIds,
    mission: `Auditoría batch: ${cities.map((c) => c.name).join(', ')}`,
    agentType: selectedUnit?.type ?? 'scout',
    batch: true,
  });

  return {
    gesture: 'area_select',
    sourceCoord: tiles[0]!.coord,
    selectedCityIds: cityIds,
    shiftHeld: true,
    draft,
    label: `Batch audit: ${cities.length} ciudad${cities.length > 1 ? 'es' : ''}`,
    confidence: 0.85,
    userConfirmed: false,
  };
}

// ─── Context menu items for right-click on city ──────────────────────────────
// Items are filtered by the selected unit's capabilities and repo restrictions.
export function contextMenuForCity(city: City, selectedUnit: Unit | null): ContextMenuItem[] {
  const unit = selectedUnit?.id ?? 'MAIN';
  const aType = selectedUnit?.type ?? 'hero';

  // Helper: only include if unit can execute this type on this city
  const allowed = (type: CommandType) => canExecute(unit, type, city.id);

  const candidates: ContextMenuItem[] = [];

  // "Send unit here" — appears first when a unit is selected
  if (selectedUnit && allowed('execute_agent')) {
    candidates.push({
      label: `Enviar ${selectedUnit.id} aquí`,
      icon: '▶',
      risk: 'medium',
      draft: draftCommand('execute_agent', city.id, {
        unit: selectedUnit.id,
        city: city.id,
        mission: `Misión en ${city.name}`,
        agentType: selectedUnit.type,
      }),
    });
  }

  if (allowed('inspect_repo')) {
    candidates.push({
      label: `Inspeccionar ${city.name}`,
      icon: '🔍',
      risk: 'low',
      hotkey: 'I',
      draft: draftCommand('inspect_repo', city.id, {
        unit,
        city: city.id,
        mission: `Inspeccionar repo ${city.name}`,
        agentType: aType,
      }),
    });
  }

  if (allowed('run_tests')) {
    candidates.push({
      label: 'Ejecutar tests',
      icon: '🧪',
      risk: 'low',
      hotkey: 'T',
      draft: draftCommand('run_tests', city.id, {
        unit,
        city: city.id,
        mission: `Ejecutar tests en ${city.name}`,
        agentType: aType,
      }),
    });
  }

  if (allowed('run_build')) {
    candidates.push({
      label: 'Build proyecto',
      icon: '⚙',
      risk: 'low',
      hotkey: 'B',
      draft: draftCommand('run_build', city.id, {
        unit,
        city: city.id,
        mission: `Build ${city.name}`,
        agentType: aType,
      }),
    });
  }

  if (allowed('execute_agent')) {
    candidates.push({
      label: 'Nueva misión…',
      icon: '✏',
      risk: 'medium',
      draft: draftCommand('execute_agent', city.id, {
        unit,
        city: city.id,
        mission: '',
        agentType: aType,
        promptUser: true,
      }),
    });
  }

  // Always offer inspect as fallback (read-only is safe for all agents)
  if (candidates.length === 0) {
    candidates.push({
      label: `Inspeccionar ${city.name}`,
      icon: '🔍',
      risk: 'low',
      hotkey: 'I',
      draft: draftCommand('inspect_repo', city.id, {
        unit,
        city: city.id,
        mission: `Inspeccionar repo ${city.name}`,
        agentType: aType,
      }),
    });
  }

  return candidates;
}

// ─── Context menu items for right-click on unit ──────────────────────────────
export function contextMenuForUnit(
  unit: Unit,
  actions: { onMove: () => void; onBuild: () => void; onSleep: () => void; onInfo: () => void },
): ContextMenuItem[] {
  return [
    {
      label: `Mover ${unit.id}`,
      icon: '↗',
      risk: 'low',
      hotkey: 'M',
      action: actions.onMove,
    },
    {
      label: `Construir con ${unit.id}`,
      icon: '🔨',
      risk: 'low',
      hotkey: 'B',
      action: actions.onBuild,
    },
    {
      label: `Dormir ${unit.id}`,
      icon: '💤',
      risk: 'low',
      hotkey: 'S',
      action: actions.onSleep,
    },
    {
      label: `Info ${unit.id}`,
      icon: 'ℹ',
      risk: 'low',
      hotkey: 'I',
      action: actions.onInfo,
    },
  ];
}

// ─── Drag unit → file (workbench assignment) ──────────────────────────────────
// Gesture: drag a macro Unit onto a tile and specify a file path.
// Produces an edit_file or read_file command delegated to that unit.
export function interpretUnitToFileDrag(params: {
  unit: Unit;
  fromCoord: Axial;
  toTile: Tile;
  filePath: string;
  shiftHeld: boolean;
}): SpatialDirective | null {
  const { unit, fromCoord, toTile, filePath, shiftHeld } = params;

  // Require a city/repo context on the target tile
  const city = toTile.city;
  if (!city) return null;

  // Normalize filePath: strip trailing slash, extract filename
  const cleanPath = filePath.replace(/\/$/, '');
  const fileName = cleanPath.split('/').pop() ?? cleanPath;

  // Shift+drag = edit_file (medium risk), regular drag = read_file (low risk)
  const isTest =
    fileName.endsWith('.test.ts') ||
    fileName.endsWith('_test.py') ||
    fileName.startsWith('test_') ||
    fileName.includes('.spec.');
  const cmdType: CommandType = shiftHeld ? (isTest ? 'run_tests' : 'edit_file') : 'read_file';

  const missionText = shiftHeld
    ? isTest
      ? `Ejecutar tests: ${fileName}`
      : `Editar ${fileName} en ${city.name}`
    : `Leer ${fileName} en ${city.name}`;

  const draft = draftCommand(cmdType, city.id, {
    unit: unit.id,
    city: city.id,
    filePath: cleanPath,
    fileName,
    mission: missionText,
    agentType: unit.type,
  });

  return {
    gesture: 'drag_unit_to_file',
    sourceCoord: fromCoord,
    targetCoord: toTile.coord,
    sourceUnitId: unit.id,
    targetCityId: city.id,
    shiftHeld,
    draft,
    label: `${unit.id} → ${fileName} @ ${city.name}: ${cmdType}`,
    confidence: 0.85,
    userConfirmed: false,
  };
}

// ─── Drop command card → unit ─────────────────────────────────────────────────
// Gesture: drag a CommandDraft card from the command palette and drop it
// onto a hex Unit. Delegates that command to the target unit.
export function interpretCardDropOnUnit(params: {
  card: CommandDraft;
  unit: Unit;
  unitCoord: Axial;
}): SpatialDirective | null {
  const { card, unit, unitCoord } = params;

  // Check if this unit can execute the card's command type
  if (!canExecute(unit.id, card.type, card.target)) return null;

  // Merge the card's payload with unit assignment
  const mergedPayload: Record<string, unknown> = {
    ...(card.payload ?? {}),
    unit: unit.id,
    agentType: unit.type,
    delegatedFrom: card.created_by ?? 'user',
  };

  const draft: CommandDraft = {
    ...card,
    payload: mergedPayload,
    created_by: unit.id,
  };

  return {
    gesture: 'drop_card_on_unit',
    sourceCoord: unitCoord,
    targetCoord: unitCoord,
    sourceUnitId: unit.id,
    shiftHeld: false,
    draft,
    label: `Card "${card.type}" → unit ${unit.id}`,
    confidence: 0.8,
    userConfirmed: false,
  };
}
