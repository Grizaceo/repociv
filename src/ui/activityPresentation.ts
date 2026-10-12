// Human presentation is separate from correlation. Never infer identity from family/PID.
import {
  activityEvents,
  eventKey,
  processKey,
  confirmedOutcome,
  type ActivityEvent,
  type ActivityProcess,
} from './activityCorrelation.ts';

export interface PresentedProcess extends ActivityProcess {
  name: string;
  family: string;
  state: string;
  role: string;
}
export interface PresentedActivity {
  id: string;
  key: string;
  commandId: string;
  title: string;
  harness: string;
  profile: string;
  agent: string;
  unit: string;
  unitName: string;
  task: string;
  status: string;
  identityWarning: string;
  events: ActivityEvent[];
  processes: PresentedProcess[];
  registered: boolean;
}
const commandNames: Record<string, string> = {
  execute_agent: 'Ejecución de agente',
  run_command: 'Comando independiente',
  git_pull: 'Actualizar repositorio',
  git_commit: 'Commit local',
};
const harnessNames: Record<string, string> = {
  hermes: 'Hermes',
  'hermes-cli': 'Hermes CLI',
  'docker-agent': 'Agente en contenedor',
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  openclaw: 'OpenClaw',
  aider: 'Aider',
};
function commandOf(e: ActivityEvent): string {
  return e.commandId || String(e.data?.['commandId'] ?? e.data?.['runId'] ?? '');
}
function field(rows: ActivityEvent[], name: string): string {
  const values = new Set(
    rows.map((e) => e.data?.[name]).filter((v): v is string => typeof v === 'string' && !!v),
  );
  return values.size === 1 ? [...values][0]! : '';
}
function validParent(child: PresentedProcess, parent: PresentedProcess): boolean {
  if (!child.processIdentity || !parent.processIdentity) return false;
  if (
    !/^[^:]+:\d+:\d+$/.test(child.processIdentity) ||
    !/^[^:]+:\d+:\d+$/.test(parent.processIdentity)
  )
    return false;
  const c = child.processIdentity.split(':'),
    p = parent.processIdentity.split(':');
  return c[0] === p[0] && Number(p[2]) <= Number(c[2]);
}
export function presentActivities(
  inventory: PresentedProcess[] = [],
  rows: ActivityEvent[] = activityEvents(),
): PresentedActivity[] {
  const groups = new Map<string, PresentedActivity>();
  const commands = new Set(rows.map(commandOf).filter(Boolean));
  for (const commandId of commands) {
    const own = rows.filter((e) => commandOf(e) === commandId);
    const identity = own.filter((e) => e.type === 'ExecutionIdentityRecorded');
    // Dispatch fallbacks can change harness without changing the unit.
    const identityFields = ['unitId', 'unitName', 'agentName', 'profileName'];
    const conflict = identityFields.some(
      (name) => new Set(identity.map((e) => e.data?.[name]).filter(Boolean)).size > 1,
    );
    const safe = identity; // Close only the conflicting field, preserve independent evidence.
    const unit = field(safe, 'unitId');
    const unitName = unit ? field(safe, 'unitName') : '';
    const agent = field(safe, 'agentName');
    // A profile recorded for only one fallback attempt does not describe the whole run.
    const profile =
      safe.length && safe.every((e) => !!e.data?.['profileName']) ? field(safe, 'profileName') : '';
    const harnesses = [
      ...new Set(
        identity
          .map((e) => e.data?.['harness'])
          .filter((v): v is string => typeof v === 'string' && !!v),
      ),
    ];
    const harness =
      harnesses.map((h) => harnessNames[h] || h).join(' → ') +
      (harnesses.length > 1 ? ' · intentos registrados' : '');
    const type =
      field(safe, 'commandType') ||
      field(
        own.filter((e) => e.type === 'CommandCreated'),
        'commandType',
      );
    const taskLinks = own.filter((e) => e.type === 'TaskRunLinked');
    const task = field(taskLinks, 'taskKey');
    const key = eventKey({ type: '', commandId, timestamp: 0 }, rows);
    const outcome = [...own]
      .reverse()
      .find((e) => /^Command(Completed|Failed|Cancelled|Rejected)$/.test(e.type));
    groups.set(`run:${commandId}`, {
      id: `run:${commandId}`,
      key,
      commandId,
      title:
        unitName ||
        (/^(?:[A-Z][A-Z_-]*-?\d+)$/.test(unit) ? unit : '') ||
        agent ||
        (profile ? `Profile ${profile}` : commandNames[type] || 'Comando registrado'),
      harness,
      profile,
      agent,
      unit,
      unitName,
      task,
      status: outcome
        ? confirmedOutcome(outcome)
        : own.some((e) => e.type === 'CommandStarted')
          ? 'Inicio registrado · sin resultado confirmado'
          : 'Sin resultado confirmado',
      identityWarning: conflict ? 'Identidad registrada ambigua' : '',
      events: own,
      processes: [],
      registered: identity.length > 0,
    });
  }
  // Ignore task links here so two executions of the same task remain distinct cards.
  const runRows = rows.filter((e) => e.type !== 'TaskRunLinked');
  for (const process of inventory) {
    const run = processKey(process, runRows, inventory);
    if (run && groups.has(run)) {
      groups.get(run)!.processes.push(process);
      continue;
    }
    let root = process;
    const visited = new Set<number>();
    while (!visited.has(root.pid)) {
      visited.add(root.pid);
      const parent = inventory.find((p) => p.pid === root.ppid);
      if (!parent || !validParent(root, parent) || processKey(parent, runRows, inventory)) break;
      root = parent;
    }
    const id = `process:${root.processIdentity || `unknown-${root.pid}`}`;
    if (!groups.has(id))
      groups.set(id, {
        id,
        key: id,
        commandId: '',
        title: `Proceso externo · ${root.name}`,
        harness: '',
        profile: '',
        agent: '',
        unit: '',
        unitName: '',
        task: '',
        status: 'Observado en el SO',
        identityWarning: '',
        events: [],
        processes: [],
        registered: false,
      });
    groups.get(id)!.processes.push(process);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(!!b.processes.length) - Number(!!a.processes.length) ||
      (b.events.at(-1)?.timestamp ?? 0) - (a.events.at(-1)?.timestamp ?? 0),
  );
}
export function activityTitle(key: string): string {
  if (!key) return 'Todas las ejecuciones';
  if (key.startsWith('task:')) return 'Tarea vinculada · ejecuciones correlacionadas';
  return presentActivities().find((a) => a.key === key)?.title || 'Proceso sin ejecución vinculada';
}
export function eventActivityTitle(e: ActivityEvent): string {
  return (
    presentActivities([], activityEvents()).find((a) => a.commandId === commandOf(e))?.title ||
    (eventKey(e).startsWith('task:')
      ? activityTitle(eventKey(e))
      : 'Evento sin ejecución vinculada')
  );
}
