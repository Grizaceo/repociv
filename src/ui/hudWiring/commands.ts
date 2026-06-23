// ─── Command palette registration ──────────────────────────────────────────
// Builds the default command set for the Ctrl/Cmd-K palette, reusing the same
// spawn/toggle functions the toolbar and hotkeys use (single source of truth).
// Kept separate from commandPalette.ts so the palette stays pure UI/registry.

import { type GameState } from '../../game.ts';
import { type Renderer } from '../../renderer.ts';
import { type BridgeEvents } from '../../bridge.ts';
import { spawnAgent } from './spawn.ts';
import { registerCommands, registerCommandProvider } from '../commandPalette.ts';
import { toggleHudMode } from '../hudMode.ts';
import {
  toggleApprovalPanel,
  toggleObservabilityPanel,
  toggleReplayPanel,
  toggleTimelinePanel,
  toggleTaskPanel,
  togglePendingPanel,
  toggleLogPanel,
  toggleHarnessPanel,
  toggleLedger,
  toggleTaskAssignPanel,
} from '../index.ts';
import { toggleSettingsPanel } from '../settingsPanel.ts';
import { toggleLayerPanel } from '../layerPanel.ts';
import { toggleConstructionPanel } from '../constructionPanel.ts';
import { takeScreenshot } from './screenshot.ts';

// Agent spawn types and their toolbar hotkeys — MUST mirror the bindings in
// hudWiring/hotkeys.ts (q/w/e/o/c/x/r). The hint badges are shown to the user,
// so a wrong key actively misinforms.
const AGENTS: ReadonlyArray<readonly [string, string]> = [
  ['MAIN', 'Q'],
  ['WORKER', 'W'],
  ['SCOUT', 'E'],
  ['OPENCLAW', 'O'],
  ['CLAUDE', 'C'],
  ['CODEX', 'X'],
  ['CURSOR', 'R'],
];

export function registerHudCommands(
  state: GameState,
  renderer: Renderer,
  bridge: BridgeEvents,
  toggleView: () => void,
): void {
  registerCommands([
    ...AGENTS.map(([type, key]) => ({
      id: `spawn-${type}`,
      group: 'Agente',
      label: `Desplegar ${type}`,
      hint: key,
      run: () => spawnAgent(type, state, renderer, bridge),
    })),
    {
      id: 'view-toggle',
      group: 'Vista',
      label: 'Alternar mapa 2D / 3D',
      hint: '3',
      run: () => toggleView(),
    },
    {
      id: 'hud-mode',
      group: 'Vista',
      label: 'Modo Quick / Advanced (HUD)',
      run: () => toggleHudMode(),
    },
    {
      id: 'p-approvals',
      group: 'Panel',
      label: 'Aprobaciones',
      hint: 'A',
      run: () => toggleApprovalPanel(),
    },
    {
      id: 'p-tasks',
      group: 'Panel',
      label: 'Tareas activas',
      hint: 'F9',
      run: () => toggleTaskPanel(),
    },
    {
      id: 'p-timeline',
      group: 'Panel',
      label: 'Crónica de eventos',
      hint: 'F10',
      run: () => toggleTimelinePanel(),
    },
    {
      id: 'p-observability',
      group: 'Panel',
      label: 'Observabilidad',
      hint: 'F8',
      run: () => toggleObservabilityPanel(),
    },
    {
      id: 'p-replay',
      group: 'Panel',
      label: 'Replay de directivas',
      hint: 'F7',
      run: () => toggleReplayPanel(),
    },
    {
      id: 'p-pending',
      group: 'Panel',
      label: 'Pendientes del tracker',
      run: () => togglePendingPanel(),
    },
    { id: 'p-log', group: 'Panel', label: 'Log en vivo', run: () => toggleLogPanel() },
    { id: 'p-harness', group: 'Panel', label: 'Harness', run: () => toggleHarnessPanel() },
    {
      id: 'p-ledger',
      group: 'Panel',
      label: 'Gran Libro',
      hint: 'F6',
      run: () => toggleLedger(state),
    },
    {
      id: 'p-task-assign',
      group: 'Panel',
      label: 'Asignar tareas',
      hint: 'J',
      run: () =>
        toggleTaskAssignPanel(
          () => state.getLocalUnits(),
          (unitId, task) => state.setLocalUnitTask(unitId, task),
        ),
    },
    {
      id: 'p-layers',
      group: 'Panel',
      label: 'Capas del mapa',
      hint: 'H',
      run: () => toggleLayerPanel(),
    },
    {
      id: 'p-settings',
      group: 'Panel',
      label: 'Configuración',
      hint: 'F11',
      run: () => toggleSettingsPanel(),
    },
    {
      id: 'p-construction',
      group: 'Panel',
      label: 'Modo construcción',
      run: () => toggleConstructionPanel(),
    },
    {
      id: 'a-screenshot',
      group: 'Acción',
      label: 'Captura de pantalla',
      hint: 'F12',
      run: () => takeScreenshot(renderer),
    },
  ]);

  // Dynamic: "Ir a <ciudad>" per non-capital city, computed each time the
  // palette opens (cities change as repos are added/removed).
  registerCommandProvider(() =>
    state.world.cities
      .filter((c) => !c.isCapital)
      .slice(0, 50)
      .map((c) => ({
        id: `city-${c.id}`,
        group: 'Ciudad',
        label: `Ir a ${c.name}`,
        run: () => renderer.focusOnCoord(c.coord),
      })),
  );
}
