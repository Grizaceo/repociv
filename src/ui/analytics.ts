// ─── RepoCiv — Lightweight local analytics ──────────────────────────────────
// No external SaaS. Persists in localStorage per-session.

const KEY = 'repociv:analytics';

interface AnalyticsData {
  sessions: number;
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

export function trackPanelOpen(panelName: string) {
  data.panelsOpened[panelName] = (data.panelsOpened[panelName] ?? 0) + 1;
  save(data);
}

export function trackHotkey(hotkey: string) {
  data.hotkeysUsed[hotkey] = (data.hotkeysUsed[hotkey] ?? 0) + 1;
  save(data);
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

export function getTopAgents(n = 3): [string, number][] {
  return Object.entries(data.messagesSent)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}
