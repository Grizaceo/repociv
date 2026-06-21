// ─── Agent glossary (plan B3) ─────────────────────────────────────────────────
// Tooltips that TEACH, not jargon. Single source of truth for "what is this
// agent?" — reused by the spawn-button titles (and any future hover surface) so
// a newcomer learns the roster by hovering instead of guessing.

const GLOSSARY: Record<string, string> = {
  MAIN: 'Agente principal — mantiene contexto entre misiones. Tu orquestador para trabajo continuo. [Q]',
  WORKER:
    'Worker — sin memoria (stateless): ejecuta una tarea puntual y arranca limpio cada vez. Ideal para encargos one-shot. [W]',
  SCOUT:
    'Scout — sin memoria (stateless): explora repos y archivos y devuelve un resumen. No conserva contexto. [E]',
  OPENCLAW:
    'OpenClaw — agente de transporte propio (sin fallback a Hermes). Mantiene estado entre misiones. [O]',
  CLAUDE: 'Claude — agente vía CLI de Claude Code. Elegí modelo en su chat. [C]',
  CODEX: 'Codex — agente vía CLI de Codex. Elegí modelo en su chat. [X]',
  CURSOR: 'Cursor — agente vía cursor-agent; habilita tracking de subagentes (Swarm).',
};

/** Teaching one-liner for an agent/unit type. Falls back to a neutral label for
 *  unknown types (e.g. legacy 'lexo' units) instead of leaking jargon. */
export function agentTooltip(type: string): string {
  const key = (type ?? '').toUpperCase();
  return GLOSSARY[key] ?? `Agente ${key || 'desconocido'}`;
}
