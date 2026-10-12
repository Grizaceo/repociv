// Evidence-only projection of existing event metadata. No persistent parallel store.
export interface ActivityEvent {
  id?: string;
  sourceOffset?: number;
  commandId?: string;
  type: string;
  timestamp: number;
  data?: Record<string, unknown>;
}
export interface ActivityProcess {
  pid: number;
  ppid: number;
  rootPid: number;
  processIdentity?: string | null;
}
let events: ActivityEvent[] = [];
let processes: ActivityProcess[] = [];
let selected = '';
let inventoryWarning = 'Inventario aún no consultado';
export function activityInventoryWarning(): string {
  return inventoryWarning;
}
export function markActivityInventoryUnavailable(): void {
  inventoryWarning = 'Inventario no disponible: procesos anteriores posiblemente desactualizados';
  notify();
}
const listeners = new Set<() => void>();
export function subscribeActivity(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify(): void {
  for (const fn of listeners) fn();
}
export function activitySelection(): string {
  return selected;
}
export function selectActivity(key: string): void {
  selected = key;
  notify();
}
export function setActivityEvents(rows: ActivityEvent[]): void {
  events = rows;
  notify();
}
export function setActivityProcesses(rows: ActivityProcess[]): void {
  inventoryWarning = '';
  processes = rows;
  notify();
}
export function activityEvents(): ActivityEvent[] {
  return events;
}
export function activityColor(key: string): string {
  let hash = 2166136261;
  for (const c of key) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return `hsl(${(hash >>> 0) % 360} 65% 72%)`;
}
export function eventKey(event: ActivityEvent, rows: ActivityEvent[] = events): string {
  if (event.type === 'TaskPhaseRecorded' && typeof event.data?.['taskKey'] === 'string')
    return `task:${event.data['taskKey']}`;
  const command = event.commandId || String(event.data?.['commandId'] ?? '');
  // A task link is accepted only from the dispatcher-owned event, never actor/name.
  const links = rows.filter((e) => e.type === 'TaskRunLinked' && e.data?.['runId'] === command);
  const keys = new Set(links.map((e) => String(e.data?.['taskKey'] ?? '')).filter(Boolean));
  if (keys.size === 1) return `task:${[...keys][0]}`;
  return command ? `run:${command}` : '';
}
export function processKey(
  process: ActivityProcess,
  rows: ActivityEvent[] = events,
  inventory: ActivityProcess[] = processes,
): string {
  if (process.processIdentity && !/^[^:]+:\d+:\d+$/.test(process.processIdentity)) return '';
  const identities: string[] = [];
  let current: ActivityProcess | undefined = process;
  const visited = new Set<number>();
  while (current && !visited.has(current.pid)) {
    visited.add(current.pid);
    if (!current.processIdentity) break;
    identities.push(current.processIdentity);
    const parent: ActivityProcess | undefined = inventory.find((p) => p.pid === current?.ppid);
    if (!parent?.processIdentity || !/^[^:]+:\d+:\d+$/.test(parent.processIdentity)) break;
    const childParts = current.processIdentity.split(':');
    const parentParts = parent.processIdentity.split(':');
    if (childParts[0] !== parentParts[0] || Number(parentParts[2]) > Number(childParts[2])) break;
    current = parent;
  }
  const links = rows.filter(
    (e) =>
      e.type === 'ProcessBound' && identities.includes(String(e.data?.['processIdentity'] ?? '')),
  );
  const commands = new Set(
    links.map((e) => e.commandId || String(e.data?.['commandId'] ?? '')).filter(Boolean),
  );
  if (commands.size !== 1) return '';
  const keys = new Set(links.map((e) => eventKey(e, rows)).filter(Boolean));
  return keys.size === 1 ? ([...keys][0] ?? '') : '';
}

export function processesFor(key: string): ActivityProcess[] {
  return processes.filter((p) => processKey(p) === key);
}
export function confirmedOutcome(event: ActivityEvent): string {
  if (event.type === 'TaskPhaseRecorded') {
    const phase = event.data?.['phase'];
    const labels: Record<string, string> = {
      complete: 'Orquestador declara complete (no equivale a validación independiente)',
      failed: 'Orquestador declara fallo',
      failed_by_validation: 'Orquestador declara fallo de validación',
      cancelled: 'Cancelada en el orquestador (no confirma salida de procesos)',
    };
    return typeof phase === 'string'
      ? (labels[phase] ?? `Fase declarada: ${phase}; no terminal confirmado`)
      : 'Sin fase fiable';
  }
  const states: Record<string, string> = {
    CommandCompleted: 'Comando completado (no valida la tarea)',
    CommandFailed: 'Comando fallido',
    CommandRejected: 'Comando rechazado',
    CommandCancelled: 'Comando cancelado',
  };
  return states[event.type] ?? 'Sin resultado terminal confirmado';
}

// Panel entry points are registered once, avoiding circular module imports.
interface ActivityPanel {
  open: () => void;
  close: () => void;
  refresh: () => Promise<void>;
}
export const activityPanels: Record<'tasks' | 'log', ActivityPanel | null> = {
  tasks: null,
  log: null,
};
export function registerActivityPanel(kind: 'tasks' | 'log', panel: ActivityPanel): void {
  activityPanels[kind] = panel;
}

// Defense in depth if an older running bridge ignores metadata=1.
export function projectActivityMetadata(row: ActivityEvent): ActivityEvent {
  const fields = new Set([
    'repo',
    'taskKey',
    'runId',
    'commandId',
    'agentId',
    'pid',
    'processIdentity',
    'phase',
    'commandType',
    'harness',
    'profileName',
    'agentName',
    'unitId',
    'unitName',
    'provider',
    'model',
  ]);
  return {
    id: row.id,
    sourceOffset: row.sourceOffset,
    commandId: row.commandId,
    type: row.type,
    timestamp: row.timestamp,
    data: Object.fromEntries(
      Object.entries(row.data ?? {}).filter(
        ([key, value]) =>
          fields.has(key) && (typeof value === 'string' || typeof value === 'number'),
      ),
    ),
  };
}

export function mergeActivityPages(
  older: ActivityEvent[],
  newer: ActivityEvent[],
): ActivityEvent[] {
  const merged = new Map<string, ActivityEvent>();
  for (const row of [...older, ...newer]) {
    const key = row.sourceOffset !== undefined ? `offset:${row.sourceOffset}` : JSON.stringify(row);
    merged.set(key, row);
  }
  return [...merged.values()];
}
