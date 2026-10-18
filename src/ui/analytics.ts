// ─── RepoCiv — Lightweight local analytics ──────────────────────────────────
// Synced with the bridge (~/.repociv/ui_telemetry.json) so alpha exit metrics
// are auditable outside the browser.
import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';

const KEY = 'repociv:analytics';

interface AnalyticsData {
  sessions: number;
  daysWithUsage: number;
  chatsSent: number;
  panelsOpened: Record<string, number>;
  hotkeysUsed: Record<string, number>;
  messagesSent: Record<string, number>;
  commandsIssued: number;
  approvalsGiven: number;
  citiesVisited: number;
  missionsCompleted: number;
  lastSession: string;
}

function load(): AnalyticsData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AnalyticsData>;
      return {
        sessions: parsed.sessions ?? 0,
        daysWithUsage: parsed.daysWithUsage ?? 0,
        chatsSent: parsed.chatsSent ?? 0,
        panelsOpened: parsed.panelsOpened ?? {},
        hotkeysUsed: parsed.hotkeysUsed ?? {},
        messagesSent: parsed.messagesSent ?? {},
        commandsIssued: parsed.commandsIssued ?? 0,
        approvalsGiven: parsed.approvalsGiven ?? 0,
        citiesVisited: parsed.citiesVisited ?? 0,
        missionsCompleted: parsed.missionsCompleted ?? 0,
        lastSession: parsed.lastSession ?? new Date().toISOString(),
      };
    }
  } catch {
    /* noop */
  }
  return {
    sessions: 0,
    daysWithUsage: 0,
    chatsSent: 0,
    panelsOpened: {},
    hotkeysUsed: {},
    messagesSent: {},
    commandsIssued: 0,
    approvalsGiven: 0,
    citiesVisited: 0,
    missionsCompleted: 0,
    lastSession: new Date().toISOString(),
  };
}

function save(d: AnalyticsData) {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* storage full */
  }
}

const data = load();
data.sessions += 1;
data.lastSession = new Date().toISOString();
save(data);

function _postUiEvent(kind: 'panel' | 'hotkey', name: string): void {
  try {
    if (typeof fetch !== 'function') return;
    void fetch(bridgeUrl('/api/telemetry/ui'), {
      method: 'POST',
      headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ kind, name, count: 1 }),
    }).catch(() => {});
  } catch {
    /* fail-open in tests / offline */
  }
}

export async function refreshBridgeAnalytics(): Promise<Readonly<AnalyticsData>> {
  try {
    if (typeof fetch !== 'function') return getAnalytics();
    const resp = await fetch(bridgeUrl('/api/telemetry/usage'), {
      headers: bridgeHeaders(),
    });
    if (resp.ok) {
      const body = (await resp.json()) as {
        daysWithUsage?: number;
        commandsIssued?: number;
        chatsSent?: number;
        approvalsResolved?: number;
        panelsOpened?: Record<string, number>;
        hotkeysUsed?: Record<string, number>;
      };
      if (typeof body.daysWithUsage === 'number') data.daysWithUsage = body.daysWithUsage;
      if (typeof body.commandsIssued === 'number') {
        data.commandsIssued = Math.max(data.commandsIssued, body.commandsIssued);
      }
      if (typeof body.chatsSent === 'number') data.chatsSent = body.chatsSent;
      if (typeof body.approvalsResolved === 'number') {
        data.approvalsGiven = Math.max(data.approvalsGiven, body.approvalsResolved);
      }
      if (body.panelsOpened && typeof body.panelsOpened === 'object') {
        for (const [k, v] of Object.entries(body.panelsOpened)) {
          if (typeof v === 'number') data.panelsOpened[k] = Math.max(data.panelsOpened[k] ?? 0, v);
        }
      }
      if (body.hotkeysUsed && typeof body.hotkeysUsed === 'object') {
        for (const [k, v] of Object.entries(body.hotkeysUsed)) {
          if (typeof v === 'number') data.hotkeysUsed[k] = Math.max(data.hotkeysUsed[k] ?? 0, v);
        }
      }
      save(data);
    }
  } catch {
    /* ignore */
  }
  return getAnalytics();
}

export function trackPanelOpen(panelName: string) {
  data.panelsOpened[panelName] = (data.panelsOpened[panelName] ?? 0) + 1;
  save(data);
  _postUiEvent('panel', panelName);
}

export function trackHotkey(hotkey: string) {
  data.hotkeysUsed[hotkey] = (data.hotkeysUsed[hotkey] ?? 0) + 1;
  save(data);
  _postUiEvent('hotkey', hotkey);
}

export function trackMessageSent(agentId: string) {
  data.messagesSent[agentId] = (data.messagesSent[agentId] ?? 0) + 1;
  save(data);
}

export function trackCommand() {
  data.commandsIssued += 1;
  save(data);
}

export function trackApproval() {
  data.approvalsGiven += 1;
  save(data);
}

export function trackCityVisit() {
  data.citiesVisited += 1;
  save(data);
}

export function trackMissionComplete() {
  data.missionsCompleted += 1;
  save(data);
}

export function getAnalytics(): Readonly<AnalyticsData> {
  return Object.freeze({ ...data });
}

// ─── Poda (panel pruning) support ─────────────────────────────────────────────
// Canonical list of poda-relevant panels — keep in sync with the toolbar/hotkey
// wiring. A panel here with 0 opens after weeks of real use is a deletion
// candidate per docs/SCOPE.md "Roadmap de poda". side-panel (chat) and terminal
// are core surfaces, intentionally excluded.
export const KNOWN_PANELS = [
  'approvals',
  'harness',
  'recovery',
  'tasks',
  'task-assign',
  'pending',
  'log',
  'priority',
  'settings',
  'construction',
  'kanban',
] as const;

export interface PanelUsage {
  panel: string;
  opens: number;
}

/** Per-panel open counts over every KNOWN_PANEL, least-used first — the poda
 *  view. A 0 here = the panel was never opened this/last sessions. */
export function getPanelUsageReport(): PanelUsage[] {
  return KNOWN_PANELS.map((panel) => ({ panel, opens: data.panelsOpened[panel] ?? 0 })).sort(
    (a, b) => a.opens - b.opens || a.panel.localeCompare(b.panel),
  );
}
