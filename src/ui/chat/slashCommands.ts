// ─── Slash-command interceptor for the RepoCiv chat input ──────────────────
// Intercepts lines starting with "/" before they reach the bridge.
// Commands that need a bridge round-trip (e.g. /new) return a Promise so the
// caller can await and then clear the input field.
//
// Usage in inputs.ts:
//   if (text.startsWith('/')) {
//     const handled = await handleSlashCommand(text, unitId, appendFn);
//     if (handled) { input.value = ''; return; }
//   }

import { bridgeHeaders, bridgeUrl } from '../../bridgeEnv.ts';
import {
  getSelectedConfig,
  getHarnessList,
  getProviderList,
  applyHarnessSelection,
  applyProviderSelection,
  applyModelSelection,
} from './modelSelector.ts';
import { parseSlash, classifyModelArgs } from './pickerLogic.ts';
import { openModelPicker, openHarnessPicker, openProviderPicker } from './slashPicker.ts';
import { resetChatHistory } from './history.ts';
import type { GameState } from '../../game.ts';
import { openSubagentSession } from '../subagentSessionPanel.ts';

let _gameState: GameState | null = null;

export function bindSlashCommandState(state: GameState): void {
  _gameState = state;
}

type AppendFn = (unitId: string, text: string, role?: 'system') => void;

// ─── Registry ────────────────────────────────────────────────────────────────

interface SlashHandler {
  description: string;
  run: (args: string, unitId: string, append: AppendFn) => Promise<boolean>;
}

const _commands: Record<string, SlashHandler> = {};

function _register(name: string, handler: SlashHandler): void {
  _commands[name] = handler;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Returns true if the text was a recognised slash command (caller should
 *  clear the input and skip bridge dispatch). */
export async function handleSlashCommand(
  text: string,
  unitId: string,
  append: AppendFn,
): Promise<boolean> {
  const parsed = parseSlash(text);
  if (!parsed) return false;
  const { cmd, args } = parsed;

  const handler = _commands[cmd];
  if (handler) {
    return handler.run(args, unitId, append);
  }

  append(
    unitId,
    `❌ Comando desconocido: /${cmd}. Escribe /help para ver los disponibles.`,
    'system',
  );
  return true;
}

// ─── /help ───────────────────────────────────────────────────────────────────

_register('help', {
  description: 'Lista todos los comandos disponibles.',
  run: async (_args, unitId, append) => {
    const lines = ['**Comandos disponibles:**', ''];
    for (const [name, h] of Object.entries(_commands)) {
      lines.push(`• \`/${name}\` — ${h.description}`);
    }
    append(unitId, lines.join('\n'), 'system');
    return true;
  },
});

// ─── /status ─────────────────────────────────────────────────────────────────

_register('status', {
  description: 'Muestra harness / provider / modelo activo.',
  run: async (_args, unitId, append) => {
    const { harness, provider, model } = getSelectedConfig();
    const lines = [
      '**Estado actual:**',
      `• Harness: \`${harness || 'auto'}\``,
      `• Provider: \`${provider || 'auto'}\``,
      `• Modelo: \`${model || '(default)'}\``,
      '',
      'Cambia con `/model`, `/harness` o `/provider` — abren un picker (↑↓ · Enter · 1-9 · Esc).',
    ];
    append(unitId, lines.join('\n'), 'system');
    return true;
  },
});

// ─── /new ────────────────────────────────────────────────────────────────────

_register('new', {
  description: 'Reinicia el contexto de sesión del agente (nueva conversación).',
  run: async (_args, unitId, append) => {
    try {
      const res = await fetch(bridgeUrl('/session/reset'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
        body: JSON.stringify({ unit: unitId }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => `HTTP ${res.status}`);
        append(unitId, `❌ Error al reiniciar sesión: ${err}`, 'system');
        return true;
      }
      const data = (await res.json()) as { newSessionId?: string };
      resetChatHistory(unitId);
      append(
        unitId,
        `✅ Sesión reiniciada — nuevo contexto: \`${data.newSessionId ?? '(ok)'}\``,
        'system',
      );
    } catch (e) {
      append(unitId, `❌ No se pudo conectar con el bridge: ${String(e)}`, 'system');
    }
    return true;
  },
});

// ─── /model ──────────────────────────────────────────────────────────────────

_register('model', {
  description:
    'Abre el picker de modelos (`/model <texto>` para filtrar). Atajo: `/model <provider> <modelo>`.',
  run: async (args, unitId, append) => {
    // Power-user shortcut: `/model <provider> <modelo>` with an exact provider
    // id applies immediately (and still pings /model/override for the Hermes
    // harness path). Anything else is treated as a filter and opens the picker
    // — so `/model gpt` or a typo never errors out, it just narrows the list.
    const decision = classifyModelArgs(args, isKnownProvider);
    if (decision.kind === 'apply') {
      const { provider, model } = decision;
      // Keep local selection (dropdowns + getSelectedConfig + persistence) in
      // sync — the per-request `model` field on the next draft does the actual
      // routing; the override POST is best-effort for the Hermes harness.
      // Set provider first, then force the exact model: a power user may name a
      // model that isn't in the fetched list (custom/unlisted id), in which case
      // applyModelChoice alone would fall back to the provider default and drop
      // their intent. applyModelSelection pins getSelectedConfig().model verbatim.
      applyProviderSelection(provider, unitId);
      applyModelSelection(model, unitId);
      try {
        const res = await fetch(bridgeUrl('/model/override'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
          body: JSON.stringify({ unit: unitId, provider, model }),
        });
        if (!res.ok) {
          const err = await res.text().catch(() => `HTTP ${res.status}`);
          append(
            unitId,
            `⚠️ Modelo aplicado localmente → \`${provider}/${model}\` (override: ${err})`,
            'system',
          );
          return true;
        }
      } catch (e) {
        append(
          unitId,
          `⚠️ Modelo aplicado localmente → \`${provider}/${model}\` (bridge: ${String(e)})`,
          'system',
        );
        return true;
      }
      append(unitId, `✅ Modelo cambiado → \`${provider}/${model}\``, 'system');
      return true;
    }

    // No exact provider pair → interactive picker, seeded with any filter text.
    openModelPicker(unitId, append, decision.filter);
    return true;
  },
});

// ─── /harness ──────────────────────────────────────────────────────────────

_register('harness', {
  description: 'Abre el picker de harness/ejecutor (`/harness <texto>` para filtrar).',
  run: async (args, unitId, append) => {
    const a = args.trim();
    // Exact id (or auto) applies instantly; otherwise open the picker seeded.
    if (a && (a === 'auto' || getHarnessList().some((h) => h.id === a && h.available))) {
      applyHarnessSelection(a, unitId);
      append(unitId, `✅ Harness → \`${a}\``, 'system');
      return true;
    }
    openHarnessPicker(unitId, append, a);
    return true;
  },
});

// ─── /provider ───────────────────────────────────────────────────────────────

_register('provider', {
  description: 'Abre el picker de proveedores (`/provider <texto>` para filtrar).',
  run: async (args, unitId, append) => {
    const a = args.trim();
    if (a && (a === 'auto' || isKnownProvider(a))) {
      applyProviderSelection(a, unitId);
      append(unitId, `✅ Proveedor → \`${a}\``, 'system');
      return true;
    }
    openProviderPicker(unitId, append, a);
    return true;
  },
});

/** True when `id` is a provider currently offered by the bridge. */
function isKnownProvider(id: string): boolean {
  return getProviderList().some((p) => p.id === id);
}

// ─── /subagent — open background subagent session viewer ─────────────────────

_register('subagent', {
  description: 'Abre la sesión del subagente seleccionado (Orden de batalla). Alias: /detach',
  run: async (args, unitId, append) => {
    const state = _gameState;
    if (!state) {
      append(unitId, '❌ Estado del juego no disponible.', 'system');
      return true;
    }
    const id = state.resolveSubagentId(args.trim() || null, unitId);
    if (!id) {
      append(
        unitId,
        '❌ Sin subagente. Selecciona una fila en Orden de batalla o usa `/subagent <sub-id>`.',
        'system',
      );
      return true;
    }
    if (!openSubagentSession(id)) {
      append(unitId, `❌ Subagente no encontrado: \`${id}\``, 'system');
      return true;
    }
    append(unitId, `✓ Sesión subagente: \`${id}\` (panel inferior)`, 'system');
    return true;
  },
});

_register('detach', {
  description: 'Alias de /subagent.',
  run: async (args, unitId, append) => _commands['subagent']!.run(args, unitId, append),
});

// ─── /retry ──────────────────────────────────────────────────────────────────

_register('retry', {
  description: 'Reenvía el último mensaje del usuario al agente.',
  run: async (_args, _unitId, _append) => {
    // Returns false — inputs.ts owns the retry logic and shows feedback
    // only after confirming a previous message exists.
    return false;
  },
});
