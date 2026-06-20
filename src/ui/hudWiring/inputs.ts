// ─── HUD button + input wiring (non-hotkey) ─────────────────────────────────
import { tileKey, type Unit } from '../../types.ts';
import { trackMessageSent } from '../analytics.ts';
import { type Renderer } from '../../renderer.ts';
import { type GameState } from '../../game.ts';
import { type BridgeEvents } from '../../bridge.ts';
import {
  openSidePanel,
  closeSidePanel,
  isSidePanelOpen,
  appendUserMessage,
  appendSystemMessage,
  wireSideTabs,
  loadGitInfo,
  loadFilesInfo,
  closeQuestBoard,
  wireQuestBoardTabs,
  toggleKeyboardHelp,
  wireCityPanel,
  getSelectedConfig,
} from '../index.ts';
import { handleSlashCommand } from '../chat/slashCommands.ts';
import { openSubagentSession } from '../subagentSessionPanel.ts';
import { toggleSettingsPanel } from '../settingsPanel.ts';
import { toggleConstructionPanel } from '../constructionPanel.ts';
import { spawnAgent } from './spawn.ts';
import { takeScreenshot } from './screenshot.ts';
import type { CommandDraft, CommandType } from '../../commandSchema.ts';
import { sendCommand } from '../../commandBus.ts';

export function wireInputs(renderer: Renderer, state: GameState, bridge: BridgeEvents): void {
  const missionInput = document.getElementById('mission-input') as HTMLInputElement;

  // ─── Spawn buttons (Q/W/E/L) ────────────────────────────────────────────
  document.querySelectorAll<HTMLButtonElement>('.spawn-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset['type'] as string;
      spawnAgent(type, state, renderer, bridge);
    });
  });

  // ─── Top-bar buttons ────────────────────────────────────────────────────
  document
    .getElementById('btn-screenshot')
    ?.addEventListener('click', () => takeScreenshot(renderer));
  document
    .getElementById('btn-construction')
    ?.addEventListener('click', () => toggleConstructionPanel());
  document.getElementById('btn-settings')?.addEventListener('click', () => toggleSettingsPanel());

  // ─── Minimap ────────────────────────────────────────────────────────────
  const minimap = document.getElementById('minimap-canvas') as HTMLCanvasElement;
  minimap?.addEventListener('click', (e) => {
    const rect = minimap.getBoundingClientRect();
    renderer.minimapClick(e.clientX - rect.left, e.clientY - rect.top);
  });

  // ─── Mission / Chat input (shared logic) ────────────────────────────────
  const chatInput = document.getElementById('chat-input') as HTMLInputElement | null;

  const sendMessage = async (input: HTMLInputElement | null) => {
    // 1) Resolve target unit: honor the user's explicit agent choice.
    // Priority:
    //   a) Active chip when the side panel is open (visible to the user).
    //   b) Last chip persisted to localStorage when the panel is closed —
    //      otherwise we'd dispatch to state.selectedUnit while openSidePanel()
    //      below restores the saved chip, splitting dispatch from the UI and
    //      making a second parallel message silently land on the wrong agent.
    const chipActive = document.querySelector<HTMLElement>('.chat-agent-chip.active');
    let selectorUnitId: string | undefined = isSidePanelOpen()
      ? chipActive?.dataset['unit']
      : undefined;
    if (!selectorUnitId && !isSidePanelOpen()) {
      const saved = (() => {
        try {
          return localStorage.getItem('repociv:lastChatUnit');
        } catch {
          return null;
        }
      })();
      if (saved && state.getUnit(saved)) selectorUnitId = saved;
    }
    const prefersSelector = !!selectorUnitId && selectorUnitId !== state.selectedUnit?.id;

    let targetUnit: Unit | null = null;
    if (prefersSelector && selectorUnitId) {
      targetUnit = state.getUnit(selectorUnitId) ?? null;
    }
    const unit = targetUnit ?? state.selectedUnit;
    if (!unit || !input || !input.value.trim()) return;

    // 2) Resolve city: if the target unit is on the map, use its position;
    //    otherwise default to "main" (virtual agent not yet spawned)
    let resolvedCity = state.world.cities[0];
    if (!prefersSelector || targetUnit) {
      const lookupCoord = unit.targetCoord ?? unit.coord;
      const tile = state.world.tiles.get(tileKey(lookupCoord));
      resolvedCity =
        tile?.city ??
        state.world.cities.find((c) =>
          c.territory.some((t) => t.q === lookupCoord.q && t.r === lookupCoord.r),
        ) ??
        state.world.cities[0];
    }

    const text = input.value.trim();

    // ─── Slash-command interceptor ─────────────────────────────────────────
    if (text.startsWith('/')) {
      if (!isSidePanelOpen()) openSidePanel(unit);
      const appendFn = (uid: string, msg: string) => appendSystemMessage(uid, msg);
      const handled = await handleSlashCommand(text, unit.id, appendFn);
      if (handled) {
        input.value = '';
        return;
      }
      // /retry falls through (handled=false) — re-use last message from history
      const lastUserMsg = (() => {
        try {
          const raw = localStorage.getItem(`repociv:lastMsg:${unit.id}`);
          return raw ?? '';
        } catch {
          return '';
        }
      })();
      if (text.toLowerCase().startsWith('/retry')) {
        if (lastUserMsg && !lastUserMsg.startsWith('/')) {
          appendSystemMessage(unit.id, '🔄 Reenviando último mensaje...');
          input.value = lastUserMsg;
          sendMessage(input);
        } else {
          appendSystemMessage(unit.id, '❌ No hay mensaje anterior para reenviar.');
        }
        input.value = '';
        return;
      }
      input.value = '';
      return;
    }

    // Persist last message for /retry
    try {
      localStorage.setItem(`repociv:lastMsg:${unit.id}`, text);
    } catch {
      /* ignore */
    }

    if (!isSidePanelOpen()) openSidePanel(unit);
    appendUserMessage(unit.id, text);
    trackMessageSent(unit.id);

    // CHAT PATH: chat del usuario al agente seleccionado. Usamos execute_agent para
    // distinguir el flujo conversacional del legacy unit_command, reduciendo ambigüedad
    // en type-policy, logs y aprobaciones.
    const chatCommandType: CommandType = 'execute_agent';
    const targetForCommand = unit.id;

    const draft: CommandDraft = {
      type: chatCommandType,
      target: targetForCommand,
      payload: {
        unit: unit.id,
        city: resolvedCity?.id ?? 'main',
        mission: text,
        agentType: unit.type,
      },
    };

    // Include 3-layer config from chat UI: harness + provider + model
    const { harness, provider, model } = getSelectedConfig();
    if (harness && harness !== 'auto') draft.payload!.harness = harness;
    if (provider && provider !== 'auto') draft.payload!.provider = provider;
    if (model) draft.payload!.model = model;

    // Update target indicator to reflect actual dispatch target
    const indicator = document.getElementById('chat-target-indicator');
    if (indicator) {
      const icon = document.querySelector('.chat-agent-chip.active .chip-icon')?.textContent ?? '⬡';
      indicator.textContent = `${icon} ${unit.id.toUpperCase()}`;
      indicator.title = `Enviando a: ${unit.id.toUpperCase()}`;
    }

    void sendCommand(draft)
      .then((res) => {
        if (!res.ok) {
          appendSystemMessage(unit.id, `❌ Comando rechazado: ${res.reason || res.status}`);
        }
      })
      .catch(() => {
        appendSystemMessage(unit.id, '❌ No se pudo enviar el mensaje al bridge.');
      });
    state.setUnitState(unit.id, 'working');
    input.value = '';
  };

  document
    .getElementById('btn-send-mission')
    ?.addEventListener('click', () => sendMessage(missionInput));
  missionInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.stopPropagation();
      sendMessage(missionInput);
    }
  });

  document.getElementById('btn-chat-send')?.addEventListener('click', () => sendMessage(chatInput));
  const tryOpenSubagentSession = (e: KeyboardEvent) => {
    if (!e.altKey || e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const chipActive = document.querySelector<HTMLElement>('.chat-agent-chip.active');
    const unitId = chipActive?.dataset['unit'] ?? state.selectedUnit?.id;
    if (!unitId) return;
    const sid = state.resolveSubagentId(state.highlightedSubagentId, unitId);
    if (sid) openSubagentSession(sid);
    else
      appendSystemMessage(
        unitId,
        '❌ Sin subagente para abrir. Selecciona fila en Orden de batalla.',
      );
  };

  chatInput?.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowUp') {
      tryOpenSubagentSession(e);
      return;
    }
    if (e.key === 'Enter') {
      e.stopPropagation();
      sendMessage(chatInput);
    }
  });

  missionInput?.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowUp') {
      tryOpenSubagentSession(e);
    }
  });

  // ─── Side panel close ────────────────────────────────────────────────────
  document.getElementById('side-panel-close')?.addEventListener('click', () => closeSidePanel());

  // ─── Side panel tabs ─────────────────────────────────────────────────────
  wireSideTabs((tab) => {
    const unit = state.selectedUnit;
    if (!unit) return;
    const cityHere = state.world.cities.find((c) =>
      c.territory.some((t) => t.q === unit.coord.q && t.r === unit.coord.r),
    );
    if (tab === 'git' && cityHere) loadGitInfo(cityHere.id);
    if (tab === 'files' && cityHere) loadFilesInfo(cityHere.id);
  });

  // ─── City panel ──────────────────────────────────────────────────────────
  wireCityPanel();

  // ─── Quest board ─────────────────────────────────────────────────────────
  document.getElementById('quest-board-close')?.addEventListener('click', closeQuestBoard);
  wireQuestBoardTabs(state);

  // ─── Keyboard help close ─────────────────────────────────────────────────
  document.getElementById('kbh-close')?.addEventListener('click', () => toggleKeyboardHelp(false));
}
