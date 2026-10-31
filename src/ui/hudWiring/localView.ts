import type { BridgeEvents } from '../../bridge.ts';
import { sendCommand } from '../../commandBus.ts';
import { openFileCommand } from '../../commandDrafts.ts';
import { bridgeHeaders, bridgeUrl } from '../../bridgeEnv.ts';
import type { GameState } from '../../game.ts';
import type { Renderer } from '../../renderer.ts';
import type { City, LocalNpc, LocalRoom, Unit } from '../../types.ts';
import { clearAllBubbles, updateBubble } from '../actionBubbles.ts';
import { mountLocalChat, type LocalChatHandle } from '../localChat/feed.ts';
import {
  showLocalUnitTooltip,
  hideLocalUnitTooltip,
  showLocalWorkbenchTooltip,
  hideLocalWorkbenchTooltip,
  showLocalContextMenu,
  showLocalMissionPreview,
  showGitForFile,
  showWhiteboardPanel,
} from '../localSpatialPreview.ts';

interface LocalViewDeps {
  renderer: Renderer;
  state: GameState;
  bridge: BridgeEvents;
  enterLocalViewForCity: (city: City) => void;
  getFirstUserUnit: (state: GameState) => Unit | undefined;
  showToast: (message: string) => void;
}

export function wireLocalView({
  renderer,
  state,
  enterLocalViewForCity,
  getFirstUserUnit,
  showToast,
}: LocalViewDeps): void {
  // ─── Phase 6: Double-click city → enter RimWorld local view ─────────────────
  renderer.onEnterLocal = (repoId, _rootPath) => {
    const city = state.world.cities.find((c) => c.id === repoId);
    if (!city) return;
    enterLocalViewForCity(city);
  };

  // ─── Local view callbacks (wired to renderer; applied lazily when localR is created) ──
  renderer.localUnitHoverCb = (unit, mx, my) => {
    if (unit) showLocalUnitTooltip(unit, { x: mx, y: my });
    else hideLocalUnitTooltip();
  };
  renderer.localWorkbenchClickCb = (tile, sx, sy) => {
    const wb = tile.workbench;
    if (!wb) return;
    const availableAgents = state
      .getAllUnits()
      .map((u) => ({ id: u.id, name: u.name, type: u.type, state: u.state }));
    const localWorld = state.localWorld;
    const repoId = localWorld?.repoId ?? wb.repoPath;
    showLocalContextMenu(wb, availableAgents, { x: sx, y: sy }, async (action) => {
      if (action === 'git') {
        void showGitForFile(repoId, wb.filePath, { x: sx, y: sy });
        return;
      }
      if (action === 'code') {
        void sendCommand(openFileCommand(wb.filePath));
        return;
      }
      if (action === 'info') {
        showLocalWorkbenchTooltip(wb, { x: sx, y: sy });
        setTimeout(() => hideLocalWorkbenchTooltip(), 3000);
        return;
      }
      if (!(await Promise.resolve(true))) return;
      // Resolve which agent will receive the mission: prefer idle, fallback to busy ones
      const agentUnit =
        action === 'WORKER'
          ? (state.getAllUnits().find((u) => u.type === 'worker' && u.state === 'idle') ??
            state.getAllUnits().find((u) => u.type === 'worker'))
          : getFirstUserUnit(state);
      const agentId = agentUnit?.id ?? action;
      // Resolve the actual repo filesystem path for bridge context
      const city = state.world.cities.find((c) => c.id === repoId);
      const repoPath = city?.repoPath ?? wb.repoPath ?? repoId;
      showLocalMissionPreview(
        action,
        wb.fileName,
        { x: sx, y: sy },
        () => {
          // 1. Animate the unit walking to the workbench locally
          state.queueLocalMission(repoId, wb.filePath, wb.fileName, agentId);
          // 2. Dispatch the real agent command to the bridge with full repo context
          void sendCommand({
            type: 'execute_agent',
            target: agentId,
            payload: {
              unit: agentId,
              city: repoId,
              repoPath,
              filePath: wb.filePath,
              fileName: wb.fileName,
              mission: `Trabajar en ${wb.fileName}`,
              cwd: repoPath,
            },
            created_by: 'local_view',
          });
        },
        () => {},
      );
    });
  };
  renderer.localUnitClickCb = (unit, _sx, _sy) => {
    // Highlight selected local unit (future: show detail panel)
    showLocalUnitTooltip(unit, { x: _sx, y: _sy });
  };
  // P4: Drag-to-assign — reuse queueLocalMission for the drag flow
  renderer.localDragAssignCb = (unitId, tile) => {
    const wb = tile.workbench;
    if (!wb) return;
    const localWorld = state.localWorld;
    const repoId = localWorld?.repoId ?? wb.repoPath;
    state.queueLocalMission(repoId, wb.filePath, wb.fileName, unitId);
  };
  // Pan the local-view camera to the room matching `folderName`, or toast if it has no room of its own.
  const navigateToFolder = (folderName: string) => {
    const lw = state.getLocalWorld();
    const target = lw?.rooms.find(
      (r: LocalRoom) => r.folderName === folderName || r.label === folderName,
    );
    if (target) {
      renderer.animateCameraToGrid(target.x + target.width / 2, target.y + target.height / 2, 500);
    } else {
      showToast(`📁 ${folderName} no tiene sala propia`);
    }
  };
  renderer.localNpcClickCb = (npc: LocalNpc, sx, sy) => {
    const localWorld = state.getLocalWorld();
    const room = localWorld?.rooms.find((r: LocalRoom) => r.id === npc.roomId);
    if (room) {
      showWhiteboardPanel(
        room,
        { x: sx, y: sy },
        (folderPath) => {
          void sendCommand(openFileCommand(folderPath));
        },
        navigateToFolder,
      );
    }
  };
  // ─── Kiosk click → discover rest area with 1.25x bonus ───────────────────
  renderer.localTileClickCb = (x, y, tile, sx, sy) => {
    if (tile?.type === 'kiosk') {
      // discover_rest_area has no command executor — it is handled by the
      // legacy root POST in bridge.py (fatigue state, not a validated
      // Command). Post it there directly; the old BridgeEvents.send() routed
      // it over WS where it was rejected for lack of `target`.
      void fetch(bridgeUrl(''), {
        method: 'POST',
        headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          type: 'discover_rest_area',
          restAreaId: `kiosk-${x}-${y}`,
          roomId: 'kiosk',
          coord: [x, y],
        }),
      }).catch(() => {});
      return;
    }
    if (tile?.type === 'whiteboard') {
      const localWorld = state.getLocalWorld();
      const room = localWorld?.rooms.find((r: LocalRoom) => r.id === tile.roomId);
      if (room) {
        showWhiteboardPanel(
          room,
          { x: sx, y: sy },
          (folderPath) => {
            void sendCommand(openFileCommand(folderPath));
          },
          navigateToFolder,
        );
      }
      return;
    }
  };

  // ─── Phase 9: Action Bubbles ─────────────────────────────────────────────
  renderer.localUnitRenderedCb = (unit, sx, sy) => updateBubble(unit, sx, sy);

  // ─── Local view chat ──────────────────────────────────────────────────────
  // The same transcript the side panel shows, in its own phone-style feed. It
  // reads the shared chatHistory and the shared chunk stream, so both views
  // stay live from one source of truth.
  let localChat: LocalChatHandle | null = null;
  renderer.onEnterLocalView = () => {
    localChat?.destroy();
    localChat = mountLocalChat(() => state.getLocalUnits());
  };
  renderer.onExitLocalView = () => {
    clearAllBubbles();
    localChat?.destroy();
    localChat = null;
  };

  // Zone painting: wire to LocalWorldManager
  renderer.onZonePaintedCb = (type, tiles) => {
    const lw = state.getLocalWorld();
    if (!lw) return;
    if (!lw.zones) lw.zones = [];
    const zoneId = `zone-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    lw.zones.push({
      id: zoneId,
      type,
      tiles,
      filters: [],
      priority: 1,
    });
    // Also update tile types visually
    for (const t of tiles) {
      const tile = lw.grid[t.y]?.[t.x];
      if (tile) tile.type = 'stockpile';
    }
    state.notifyUpdate();
  };
}
