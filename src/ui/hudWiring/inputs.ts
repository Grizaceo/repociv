// ─── HUD button + input wiring (non-hotkey) ─────────────────────────────────
import { tileKey } from '../../types.ts';
import { trackMessageSent } from '../analytics.ts';
import { agentTooltip } from '../agentGlossary.ts';
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
  toggleKeyboardHelp,
  wireCityPanel,
  getSelectedConfig,
} from '../index.ts';
import { handleSlashCommand } from '../chat/slashCommands.ts';
import { openSubagentSession } from '../subagentSessionPanel.ts';
import { toggleSettingsPanel } from '../settingsPanel.ts';
import { toggleConstructionPanel } from '../constructionPanel.ts';
import { spawnAgent, spawnHarnessTemplate } from './spawn.ts';
import { takeScreenshot } from './screenshot.ts';
import type { CommandDraft, CommandType } from '../../commandSchema.ts';
import { sendCommand } from '../../commandBus.ts';
import { buildExecuteAgentPayload } from './executeAgentPayload.ts';
import { findUnitForChatId, resolveChatDispatchUnitId } from './resolveChatDispatchUnit.ts';
import { switchToChatUnit } from '../chat/agentChip.ts';

export function wireInputs(renderer: Renderer, state: GameState, bridge: BridgeEvents): void {
  const missionInput = document.getElementById('mission-input') as HTMLInputElement;

  // ─── Spawn buttons (Q/W/E/O/C/X) — skip + Nuevo (no data-type) ─────────────
  document.querySelectorAll<HTMLButtonElement>('.spawn-btn[data-type]').forEach((btn) => {
    const type = btn.dataset['type'] as string;
    // Teaching tooltip (plan B3): explain each agent on hover instead of jargon.
    btn.title = agentTooltip(type);
    btn.addEventListener('click', () => {
      const harnessTemplates: Record<string, 'openclaw' | 'claude' | 'codex'> = {
        OPENCLAW: 'openclaw',
        CLAUDE: 'claude',
        CODEX: 'codex',
      };
      const harness = harnessTemplates[type];
      if (harness) {
        void spawnHarnessTemplate(harness, type, state, renderer, bridge);
        return;
      }
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
  const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement | null;

  // Auto-grow the chat textarea so long messages expand upward from the
  // anchored input row (like the Hermes app) instead of overflowing to the
  // right. Resets after send. scrollHeight excludes the border, so with
  // box-sizing:border-box we must add it back or the last line clips.
  const autoResizeChat = () => {
    if (!chatInput) return;
    // Collapse to 0px (not 'auto') so the browser is forced to recompute the
    // layout; scrollHeight then reflects the true content height. Using 'auto'
    // can return a stale/previous height the first time the textarea grows,
    // which clips the top line until the next keystroke.
    chatInput.style.height = '0px';
    const cs = window.getComputedStyle(chatInput);
    const borderY =
      (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const target = chatInput.scrollHeight + borderY;
    chatInput.style.height = `${Math.min(target, 160)}px`;
  };
  chatInput?.addEventListener('input', autoResizeChat);

  // Re-fit after the panel is dragged wider/narrower: wrapping changes and a
  // textarea that fit one line may now need two (and vice versa). Only react
  // to width changes so we don't loop on our own height writes.
  let lastResizeWidth = -1;
  const fitObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    if (Math.abs(entry.contentRect.width - lastResizeWidth) <= 1) return;
    lastResizeWidth = entry.contentRect.width;
    autoResizeChat();
  });
  if (chatInput) fitObserver.observe(chatInput);

  const sendMessage = async (input: HTMLInputElement | HTMLTextAreaElement | null) => {
    if (!input || !input.value.trim()) return;

    // Chat tab / chip is the source of truth — never fall back to board MAIN
    // while the user is viewing SCOUT/WORKER (that was collapsing replies).
    const chatUnitId = resolveChatDispatchUnitId(state);
    if (!chatUnitId) return;

    const matched = findUnitForChatId(state, chatUnitId);
    const unit = matched ?? state.selectedUnit ?? null;
    // Prefer the living unit id when chip said "SCOUT" but board has "SCOUT-1".
    const dispatchUnitId = matched?.id ?? chatUnitId;
    // Force chip + transcript swap BEFORE any append — otherwise SCOUT
    // bubbles paint on top of MAIN's uncleared #chat-messages DOM.
    await switchToChatUnit(dispatchUnitId, { force: true });

    // City under the chatting unit (or any city with a real repoPath).
    let resolvedCity = state.world.cities.find((c) => c.repoPath?.trim());
    if (unit) {
      const lookupCoord = unit.targetCoord ?? unit.coord;
      const tile = state.world.tiles.get(tileKey(lookupCoord));
      const cityFromTile =
        tile?.city ??
        state.world.cities.find((c) =>
          c.territory.some((t) => t.q === lookupCoord.q && t.r === lookupCoord.r),
        );
      if (cityFromTile?.repoPath?.trim()) {
        resolvedCity = cityFromTile;
      } else if (!resolvedCity) {
        resolvedCity = cityFromTile ?? state.world.cities[0];
      }
    }

    const text = input.value.trim();

    // ─── Slash-command interceptor ─────────────────────────────────────────
    if (text.startsWith('/')) {
      if (!isSidePanelOpen()) {
        if (unit && unit.id === dispatchUnitId) await openSidePanel(unit);
        else document.getElementById('side-panel')?.classList.remove('hidden');
      }
      const appendFn = (uid: string, msg: string) => appendSystemMessage(uid, msg);
      const handled = await handleSlashCommand(text, dispatchUnitId, appendFn);
      if (handled) {
        input.value = '';
        return;
      }
      // /retry falls through (handled=false) — re-use last message from history
      const lastUserMsg = (() => {
        try {
          const raw = localStorage.getItem(`repociv:lastMsg:${dispatchUnitId}`);
          return raw ?? '';
        } catch {
          return '';
        }
      })();
      if (text.toLowerCase().startsWith('/retry')) {
        if (lastUserMsg && !lastUserMsg.startsWith('/')) {
          appendSystemMessage(dispatchUnitId, '🔄 Reenviando último mensaje...');
          input.value = lastUserMsg;
          sendMessage(input);
        } else {
          appendSystemMessage(dispatchUnitId, '❌ No hay mensaje anterior para reenviar.');
        }
        input.value = '';
        return;
      }
      input.value = '';
      return;
    }

    // Persist last message for /retry
    try {
      localStorage.setItem(`repociv:lastMsg:${dispatchUnitId}`, text);
    } catch {
      /* ignore */
    }

    if (!isSidePanelOpen()) {
      // Never open the panel bound to a different board unit than dispatch —
      // that re-rendered MAIN over SCOUT and mixed the shared chat DOM.
      if (unit && unit.id === dispatchUnitId) {
        await openSidePanel(unit);
      } else {
        document.getElementById('side-panel')?.classList.remove('hidden');
        await switchToChatUnit(dispatchUnitId, { force: true });
      }
    }
    appendUserMessage(dispatchUnitId, text);
    trackMessageSent(dispatchUnitId);
    const chatCommandType: CommandType = 'execute_agent';
    const targetForCommand = dispatchUnitId;

    // Include 3-layer config from chat UI: harness + provider + model.
    // Hermes HTTP needs provider+model together; CLI harnesses need a city
    // with repoPath (bridge rejects otherwise — surface that to the user).
    const { harness, provider, model } = getSelectedConfig();
    const selectedHarness = harness && harness !== 'auto' ? harness : '';
    const cliHarnesses = new Set([
      'claude',
      'claude-code',
      'cursor',
      'codex',
      'openclaw',
      'hermes-cli',
    ]);
    if (cliHarnesses.has(selectedHarness) && !resolvedCity?.repoPath?.trim()) {
      appendSystemMessage(
        dispatchUnitId,
        `❌ Harness \`${selectedHarness}\` requiere una ciudad con repo seleccionado. Elige hermes/auto o mueve el agente a una ciudad.`,
      );
      input.value = '';
      return;
    }
    const draft: CommandDraft = {
      type: chatCommandType,
      target: targetForCommand,
      payload: buildExecuteAgentPayload(
        resolvedCity ?? null,
        dispatchUnitId,
        text,
        selectedHarness,
        model,
        provider,
        unit?.type ?? '',
      ),
    };

    // Update target indicator to reflect actual dispatch target
    const indicator = document.getElementById('chat-target-indicator');
    if (indicator) {
      const icon = document.querySelector('.chat-agent-chip.active .chip-icon')?.textContent ?? '⬡';
      indicator.textContent = `${icon} ${dispatchUnitId.toUpperCase()}`;
      indicator.title = `Enviando a: ${dispatchUnitId.toUpperCase()}`;
    }

    // eslint-disable-next-line no-console
    console.info('[chat] dispatch', {
      dispatchUnitId,
      city: resolvedCity?.id,
      harness: selectedHarness || 'auto',
      provider,
      model,
      draft,
    });

    void sendCommand(draft)
      .then((res) => {
        if (!res.ok) {
          const detail = res.reason || res.status || `HTTP error (status ${res.status})`;
          // eslint-disable-next-line no-console
          console.warn('[chat] command rejected', { draft, res, detail });
          appendSystemMessage(dispatchUnitId, `❌ Comando rechazado: ${detail}`);
        } else {
          // eslint-disable-next-line no-console
          console.info('[chat] command queued', {
            commandId: res.commandId,
            status: res.status,
            unit: dispatchUnitId,
          });
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[chat] sendCommand threw', err, { draft });
        appendSystemMessage(dispatchUnitId, '❌ No se pudo enviar el mensaje al bridge.');
      });
    if (unit) state.setUnitState(unit.id, 'working');
    input.value = '';
    input.style.height = 'auto';
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
    // Enter sends; Shift+Enter inserts a newline (multi-line drafting).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
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

  // ─── Keyboard help close ─────────────────────────────────────────────────
  document.getElementById('kbh-close')?.addEventListener('click', () => toggleKeyboardHelp(false));
}
