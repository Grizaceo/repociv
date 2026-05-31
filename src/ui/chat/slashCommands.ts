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
import { getSelectedConfig } from './modelSelector.ts';
import { resetChatHistory } from './history.ts';

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
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;

  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1).join(' ');

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
  description: 'Sin args: muestra modelo activo. Con args `<provider> <model>`: lo cambia.',
  run: async (args, unitId, append) => {
    if (!args.trim()) {
      // show current
      const { harness, provider, model } = getSelectedConfig();
      append(
        unitId,
        `**Modelo activo:** \`${provider || 'auto'}/${model || 'default'}\` (harness: ${harness || 'auto'})`,
        'system',
      );
      return true;
    }

    const parts = args.trim().split(/\s+/);
    if (parts.length < 2) {
      append(
        unitId,
        '❌ Uso: `/model <provider> <modelo>` — ej. `/model ollama-cloud deepseek-v4-pro`',
        'system',
      );
      return true;
    }
    const [provider, ...modelParts] = parts;
    const model = modelParts.join(' ');

    try {
      const res = await fetch(bridgeUrl('/model/override'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
        body: JSON.stringify({ unit: unitId, provider, model }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => `HTTP ${res.status}`);
        append(unitId, `❌ Error al cambiar modelo: ${err}`, 'system');
        return true;
      }
      append(unitId, `✅ Modelo cambiado → \`${provider}/${model}\``, 'system');
    } catch (e) {
      append(unitId, `❌ No se pudo conectar con el bridge: ${String(e)}`, 'system');
    }
    return true;
  },
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
