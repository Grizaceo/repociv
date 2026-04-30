// ─── RepoCiv — Directive Learner client (Fase 9) ──────────────────────────────
// Communicates with the backend learning layer.
// No auto-execution: every suggestion still goes through policy + preview.

const BRIDGE_URL   = import.meta.env.VITE_BRIDGE_URL   ?? 'http://localhost:5274';
const BRIDGE_TOKEN = import.meta.env.VITE_BRIDGE_TOKEN ?? '';

export interface Suggestion {
  cmdType:     string;
  target?:     string;
  successRate: number;   // 0–1
  count:       number;
  score:       number;
}

export interface Template {
  gesture:     string;
  agentId:     string;
  cmdType:     string;
  target?:     string;
  successRate: number;
  count:       number;
}

export interface ReplayEntry {
  command_id:  string;
  gesture:     string;
  agent_id:    string;
  cmd_type:    string;
  target:      string;
  outcome:     string;
  duration_s:  number;
  ts:          number;
}

export interface DirectiveStats {
  totalRecorded:      number;
  totalResolved:      number;
  overallSuccessRate: number;
  successRates:       Record<string, Record<string, { rate: number; count: number; success: number }>>;
  templates:          Template[];
  recentSuccesses:    ReplayEntry[];
}

function _headers(): Record<string, string> {
  return BRIDGE_TOKEN ? { 'X-RepoCiv-Token': BRIDGE_TOKEN } : {};
}

// ─── Record a gesture → commandId link ───────────────────────────────────────
export async function recordGesture(params: {
  commandId: string;
  gesture:   string;
  agentId:   string;
  cmdType:   string;
  target:    string;
  repoType?: string;
  testStatus?: string;
  lastCmdType?: string;
  gameTick?: number;
}): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      commandId: params.commandId,
      gesture:   params.gesture,
      agentId:   params.agentId,
      cmdType:   params.cmdType,
      target:    params.target,
    };
    if (params.repoType)    body.repoType    = params.repoType;
    if (params.testStatus)  body.testStatus  = params.testStatus;
    if (params.lastCmdType) body.lastCmdType = params.lastCmdType;
    if (params.gameTick !== undefined) body.gameTick = params.gameTick;
    await fetch(`${BRIDGE_URL}/directives/record`, {
      method:  'POST',
      headers: { ..._headers(), 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch {
    // bridge offline — silently drop, learning is best-effort
  }
}

// ─── Fetch suggestions for a gesture context ──────────────────────────────────
export async function fetchSuggestions(
  gesture: string,
  agentId: string,
  ctx?: { repoType?: string; testStatus?: string; lastCmdType?: string },
): Promise<Suggestion[]> {
  try {
    const params = new URLSearchParams({ gesture, agent: agentId });
    if (ctx?.repoType)    params.set('repoType', ctx.repoType);
    if (ctx?.testStatus)  params.set('testStatus', ctx.testStatus);
    if (ctx?.lastCmdType) params.set('lastCmdType', ctx.lastCmdType);
    const res = await fetch(
      `${BRIDGE_URL}/directives/suggest?${params.toString()}`,
      { headers: _headers() },
    );
    if (!res.ok) return [];
    return await res.json() as Suggestion[];
  } catch {
    return [];
  }
}

// ─── Full stats (for replay panel and observability) ─────────────────────────
export async function fetchStats(): Promise<DirectiveStats | null> {
  try {
    const res = await fetch(`${BRIDGE_URL}/directives/stats`, { headers: _headers() });
    if (!res.ok) return null;
    return await res.json() as DirectiveStats;
  } catch {
    return null;
  }
}

// ─── Persisted templates ──────────────────────────────────────────────────────
export async function fetchTemplates(): Promise<Template[]> {
  try {
    const res = await fetch(`${BRIDGE_URL}/directives/stats`, { headers: _headers() });
    if (!res.ok) return [];
    const stats = await res.json() as DirectiveStats;
    return stats.templates ?? [];
  } catch {
    return [];
  }
}

// ─── Label helpers ────────────────────────────────────────────────────────────
export function cmdTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    inspect_repo:  'Inspeccionar',
    read_file:     'Leer archivo',
    run_tests:     'Ejecutar tests',
    run_build:     'Build',
    edit_file:     'Editar',
    create_branch: 'Nueva rama',
    git_commit:    'Commit',
    execute_agent: 'Ejecutar agente',
    send_message:  'Enviar mensaje',
    unit_command:  'Comando unidad',
    quest_add:     'Nueva misión',
    delete_file:   'Eliminar archivo',
  };
  return labels[type] ?? type;
}

export function successRateColor(rate: number): string {
  if (rate >= 0.8) return '#5b9b5b';
  if (rate >= 0.5) return '#e8a040';
  return '#d44b4b';
}
