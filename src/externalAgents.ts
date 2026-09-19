// ─── External agents (Suvadu, Hermes) — rehydration on bridge (re)connect ───
// server/suvadu_tracker.py mirrors the Claude Code / Codex / Cursor sessions
// that Suvadu sees on this machine, and the Hermes sessions in its state.db
// files (server/hermes_sessions.py), as ephemeral `ext-*` units, via plain
// unit_spawn / unit_state / unit_despawn events. Those events are
// fire-and-forget: a browser that connects (or reconnects) after a spawn would
// never see the unit. So on every connect the bridge client fetches the
// tracker snapshot (GET /api/external-agents) and replays the difference
// through the normal, validated event path.

import { parseBridgeEvent } from './bridgeSchema.ts';
import { bridgeHeaders, bridgeUrl } from './bridgeEnv.ts';
import type { BridgeEvent, City } from './types.ts';
import { escapeHtml } from './ui/escapeHtml.ts';

/** Every unit owned by the external-agents tracker has this id prefix. */
export const EXTERNAL_UNIT_PREFIX = 'ext-';

export function isExternalAgentUnit(unitId: string): boolean {
  return unitId.startsWith(EXTERNAL_UNIT_PREFIX);
}

/** One row of GET /api/external-agents `agents` (metadata only). */
export interface ExternalAgentRow {
  unit: string;
  unitType: string;
  cityId: string;
  state: string;
  mission?: string;
}

/**
 * Pure: the bridge events that bring the map's `ext-*` units in line with the
 * tracker snapshot — spawn missing ones, re-assert their state, despawn the
 * ones the tracker dropped while this client was not listening. Rows that do
 * not validate as bridge events are skipped.
 */
export function externalAgentEvents(
  currentUnitIds: Iterable<string>,
  rows: readonly ExternalAgentRow[],
): BridgeEvent[] {
  const onMap = new Set([...currentUnitIds].filter(isExternalAgentUnit));
  const wanted = new Set<string>();
  const raw: unknown[] = [];
  for (const row of rows) {
    if (typeof row?.unit !== 'string' || !isExternalAgentUnit(row.unit)) continue;
    wanted.add(row.unit);
    if (!onMap.has(row.unit)) {
      raw.push({
        type: 'unit_spawn',
        unit: row.unit,
        civ: 'capital',
        hex: [0, 0],
        unitType: row.unitType,
        mission: row.mission,
        cityId: row.cityId,
        ephemeral: true,
      });
    }
    raw.push({ type: 'unit_state', unit: row.unit, state: row.state });
  }
  for (const id of onMap) {
    if (!wanted.has(id)) raw.push({ type: 'unit_despawn', unit: id });
  }
  return raw.map(parseBridgeEvent).filter((e): e is BridgeEvent => e !== null);
}

/** Tracker snapshot rows, or null when the bridge is unreachable/older. */
export async function fetchExternalAgents(): Promise<ExternalAgentRow[] | null> {
  try {
    const res = await fetch(bridgeUrl('/api/external-agents'), { headers: bridgeHeaders() });
    if (!res.ok) return null;
    const body = (await res.json()) as { agents?: unknown };
    return Array.isArray(body.agents) ? (body.agents as ExternalAgentRow[]) : null;
  } catch {
    return null;
  }
}

// ─── Agents panel: every recent session + its chat ──────────────────────────
// GET /api/external-agents/sessions lists sessions active in the last ~24 h,
// on the map or not. Chat text comes on demand from
// GET /api/external-agents/<session>/chat (never broadcast over SSE/WS).

/**
 * Where a session is listed. `''` — on the map while active (Activos / Últimas
 * 24 h); `cron` / `gateway` — Hermes cron jobs and gateway chats (Telegram…),
 * listed in their own panel sections and never put on the map.
 */
export type SessionSection = '' | 'cron' | 'gateway';

/** One row of GET /api/external-agents/sessions (metadata only). */
export interface ExternalSessionRow {
  sessionId: string;
  /** `suvadu` or `hermes`; older bridges omit it (→ suvadu). */
  source?: string;
  agent: string;
  /** Hermes profile (`default`, `cobalt`, `lexo-alpha`…). */
  profile?: string;
  /** How a Hermes session started: cli, desktop, tui, cron, telegram… */
  origin?: string;
  section?: SessionSection;
  model: string;
  repo: string;
  cityId: string;
  active: boolean;
  /**
   * `working` — fresh tool activity; `thinking` — the activity clock went
   * quiet but a process still holds the session (reasoning, or waiting for its
   * own user: the bridge cannot tell, and neither is safe to interrupt);
   * `idle` — quiet and nothing holding it; `inactive` — out of the window.
   * Older bridges only ever send working / idle / inactive.
   */
  state: 'working' | 'thinking' | 'idle' | 'inactive';
  unit: string | null;
  unitType: string;
  firstActivityAt: number;
  lastActivityAt: number;
  commandCount: number;
  eventCount: number;
  totalTokens: number | null;
  subagent: boolean;
  imported: boolean;
}

export interface ExternalChatMessage {
  /** `tool` — a run of tool calls, reduced to the tool names (Hermes). */
  role: 'user' | 'assistant' | 'tool';
  text: string;
  tools?: string[];
  at: number | null;
  truncated: boolean;
  turn: string | null;
}

export interface ExternalChat {
  session: ExternalSessionRow;
  messages: ExternalChatMessage[];
  hasMore: boolean;
  available: boolean;
  error?: string;
  refresh?: string;
  /** Session title (Hermes) — content-derived, so only sent with the chat. */
  title?: string | null;
}

export async function fetchExternalSessions(): Promise<ExternalSessionRow[] | null> {
  try {
    const res = await fetch(bridgeUrl('/api/external-agents/sessions'), {
      headers: bridgeHeaders(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { sessions?: unknown };
    return Array.isArray(body.sessions) ? (body.sessions as ExternalSessionRow[]) : null;
  } catch {
    return null;
  }
}

export async function fetchExternalChat(
  sessionId: string,
  opts: { refresh?: boolean; limit?: number } = {},
): Promise<ExternalChat | null> {
  const qs = new URLSearchParams({ limit: String(opts.limit ?? 80) });
  if (opts.refresh) qs.set('refresh', '1');
  try {
    const res = await fetch(
      bridgeUrl(`/api/external-agents/${encodeURIComponent(sessionId)}/chat?${qs.toString()}`),
      { headers: bridgeHeaders() },
    );
    if (!res.ok) return null;
    return (await res.json()) as ExternalChat;
  } catch {
    return null;
  }
}

/**
 * How to pick a session back up in a terminal (server/session_resume.py).
 * `resume` carries the command; `attached` and `unavailable` carry only a note.
 */
export interface ExternalResume {
  mode: 'resume' | 'attached' | 'unavailable';
  command: string;
  agent: string;
  live: boolean | null;
  note: string;
  sessionId?: string;
  error?: string;
}

export async function fetchExternalResume(sessionId: string): Promise<ExternalResume | null> {
  try {
    const res = await fetch(
      bridgeUrl(`/api/external-agents/${encodeURIComponent(sessionId)}/resume`),
      { headers: bridgeHeaders() },
    );
    if (!res.ok) return null;
    return (await res.json()) as ExternalResume;
  } catch {
    return null;
  }
}

/** `repo:<base64url(abs path)>` → abs path (vite-plugins/repoRootsState.ts encodeRepoId). */
export function decodeRepoCityId(id: string): string | null {
  if (!id.startsWith('repo:')) return null;
  try {
    const b64 = id.slice('repo:'.length).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

const _trimSlash = (p: string | undefined): string => (p ?? '').replace(/\/+$/, '');

/**
 * City for a bridge city ref, exact matches only. Cities built at world
 * generation use `id = repo name`, cities added later use `id = repo:<b64>`;
 * both carry the absolute `repoPath`, which is what `repo:` refs decode to.
 */
export function findCityByRef(cities: readonly City[], ref: string): City | undefined {
  const path = decodeRepoCityId(ref);
  return cities.find(
    (c) =>
      c.id === ref ||
      (!!c.repoPath && _trimSlash(c.repoPath) === _trimSlash(ref)) ||
      (path !== null && (_trimSlash(c.repoPath) === _trimSlash(path) || c.id === path)),
  );
}

/** Where a session's repo is on this browser's map. */
export type MapPlace =
  | { kind: 'city'; city: City }
  | { kind: 'capital'; city: City | undefined }
  | { kind: 'off-map'; city: City | undefined };

/**
 * `city` — its repo is a city here; `capital` — RepoCiv itself (or no repo);
 * `off-map` — a repo this map does not show (its unit waits at the capital).
 * The bridge resolves cityId from the session cwd; only the browser knows
 * which cities its own selection put on the map.
 */
export function placeOnMap(
  row: Pick<ExternalSessionRow, 'cityId'>,
  cities: readonly City[],
): MapPlace {
  const capital = cities.find((c) => c.isCapital);
  if (row.cityId === 'capital') return { kind: 'capital', city: capital };
  const city = findCityByRef(cities, row.cityId);
  if (city && !city.isCapital) return { kind: 'city', city };
  return { kind: 'off-map', city: capital };
}

/** Map sessions split into active / recent; cron and gateway ones apart. */
export function partitionSessions(rows: readonly ExternalSessionRow[]): {
  active: ExternalSessionRow[];
  recent: ExternalSessionRow[];
  cron: ExternalSessionRow[];
  gateway: ExternalSessionRow[];
} {
  const byRecency = [...rows].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const onMap = byRecency.filter((r) => !r.section);
  return {
    active: onMap.filter((r) => r.active),
    recent: onMap.filter((r) => !r.active),
    cron: byRecency.filter((r) => r.section === 'cron'),
    gateway: byRecency.filter((r) => r.section === 'gateway'),
  };
}

const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  pi: 'pi.dev',
  antigravity: 'Antigravity',
  hermes: 'Hermes',
};

export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent.toLowerCase()] ?? agent;
}

/**
 * The badge for a session state, or null when there is nothing to warn about.
 * Both live states get one: the point is answering "¿puedo escribirle?" before
 * the user goes looking for that agent's terminal.
 */
export function stateBadge(state: string): { text: string; title: string } | null {
  if (state === 'working') {
    return {
      text: 'trabajando',
      title: 'Usó una herramienta hace poco. Está en plena tarea: no lo interrumpas.',
    };
  }
  if (state === 'thinking') {
    return {
      text: 'pensando…',
      title:
        'Su proceso sigue vivo, pero hace rato que no registra herramientas: puede estar razonando o esperando una respuesta en su terminal. Tampoco conviene interrumpirlo a ciegas.',
    };
  }
  return null;
}

/** Card title: the agent, plus the profile for Hermes ("Hermes · cobalt"). */
export function sessionLabel(row: Pick<ExternalSessionRow, 'agent' | 'profile'>): string {
  const label = agentLabel(row.agent);
  return row.profile ? `${label} · ${row.profile}` : label;
}

/** "claude-opus-5" → "opus-5"; "meituan/longcat-2.0:free" → "longcat-2.0:free"; "gpt-5-codex" stays. */
export function shortModel(model: string): string {
  return model
    .replace(/^.*\//, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
}

/** Tool names in call order → "terminal ×3 · read_file". */
export function summarizeTools(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(' · ');
}

export function relativeTime(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k tok`;
  return `${n} tok`;
}

function clock(at: number | null): string {
  if (at === null) return '';
  return new Date(at).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

/** Chat messages → escaped HTML (agent text is untrusted). */
export function chatMessagesHtml(messages: readonly ExternalChatMessage[], agent: string): string {
  return messages
    .map((m) => {
      if (m.role === 'tool') {
        const tools = summarizeTools(m.tools ?? []);
        return `<div class="agents-msg agents-msg--tool" title="Solo el nombre de cada tool; su salida no se muestra">🔧 ${escapeHtml(tools)}</div>`;
      }
      const who = m.role === 'user' ? 'Prompt' : agentLabel(agent);
      const cut = m.truncated
        ? '<span class="agents-msg-cut" title="Se guardan hasta ~4000 caracteres por mensaje">…recortado</span>'
        : '';
      return `<div class="agents-msg agents-msg--${m.role}">
        <div class="agents-msg-meta">${escapeHtml(who)} · ${escapeHtml(clock(m.at))}</div>
        <div class="agents-msg-text">${escapeHtml(m.text)}</div>${cut}
      </div>`;
    })
    .join('');
}
