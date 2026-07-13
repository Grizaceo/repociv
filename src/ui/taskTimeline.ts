export interface LifecycleEvent {
  id: string;
  commandId: string;
  type: string;
  timestamp: number;
  actor: string;
  data: Record<string, unknown>;
}

export function lifecycleSnapshotEqual(left: LifecycleEvent[], right: LifecycleEvent[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((event, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      event.id === other.id &&
      event.type === other.type &&
      event.timestamp === other.timestamp
    );
  });
}

export function latestByCommand(events: LifecycleEvent[]): Map<string, LifecycleEvent> {
  const latest = new Map<string, LifecycleEvent>();
  for (const event of events) {
    const current = latest.get(event.commandId);
    if (!current || event.timestamp >= current.timestamp) latest.set(event.commandId, event);
  }
  return latest;
}

export function canCancelLifecycle(type: string): boolean {
  return type === 'CommandQueued' || type === 'CommandWaitingApproval';
}

export function lifecycleDetail(event: LifecycleEvent): string {
  const data = event.data;
  if (event.type === 'CommandCreated') {
    const commandType = String(data['type'] ?? data['commandType'] ?? 'command');
    const target = String(data['target'] ?? data['repoPath'] ?? '');
    return `${commandType} → ${target.slice(0, 60)}`;
  }
  if (event.type === 'CommandCompleted' || event.type === 'CommandFailed') {
    return String(data['error'] ?? data['result'] ?? data['status'] ?? '').slice(0, 100);
  }
  return String(data['status'] ?? '').slice(0, 60);
}
