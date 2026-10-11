import type { GameState } from '../game.ts';
import { isExternalAgentUnit, sessionLabel, type ExternalSessionRow } from '../externalAgents.ts';
import { AgentAttention, ATTENTION_LABELS, type AttentionInput } from './agentAttention.ts';
import { focusOwnChat, openExternalAgentChat, openAgentsPanel } from './agentsPanel.ts';
import { openApprovalPanel, subscribeApprovals } from './approvalPanel.ts';
import { subscribeExternalSessionDirectory } from './externalSessionDirectory.ts';

/** One low-profile row. The map stays the workspace; F8 owns the full directory. */
export function bindAgentAttentionStrip(state: GameState): () => void {
  const tracker = new AgentAttention();
  let sessions: ExternalSessionRow[] | null = null;
  let blocked = new Set<string>();
  let approvalCount = 0;
  let key = '';
  const strip = document.createElement('nav');
  strip.id = 'agent-attention-strip';
  strip.setAttribute('aria-label', 'Atención de agentes');
  document.body.appendChild(strip);
  // Announce attention changes, not every game tick or the entire button list.
  const announcement = document.createElement('div');
  announcement.className = 'attention-announcement';
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  announcement.setAttribute('aria-atomic', 'true');
  document.body.appendChild(announcement);
  let announcementKey = '';

  const render = () => {
    const inputs: AttentionInput[] = state
      .getAllUnits()
      .filter((unit) => !unit.ephemeral && !isExternalAgentUnit(unit.id))
      .map((unit) => ({
        id: `own:${unit.id}`,
        ref: unit.id,
        kind: 'own',
        label: unit.name,
        context: state.world.cities.find((city) => city.id === unit.cityId)?.name ?? '',
        state:
          unit.state === 'working' || unit.state === 'building'
            ? 'working'
            : unit.state === 'moving'
              ? 'thinking'
              : 'idle',
        active: unit.state !== 'sleeping',
        blocked: blocked.has(unit.id),
      }));
    for (const row of sessions ?? []) {
      if (row.section || row.subagent) continue;
      inputs.push({
        id: `external:${row.sessionId}`,
        ref: row.sessionId,
        kind: 'external',
        label: sessionLabel(row),
        context: row.repo.split(/[\\/]/).filter(Boolean).at(-1) ?? '',
        state: row.state === 'inactive' ? 'idle' : row.state,
        active: row.active,
      });
    }
    const entries = tracker.update(inputs);
    const unreviewed = entries.filter((entry) => entry.status === 'unreviewed').length;
    const attentionKey = `${approvalCount}:${unreviewed}`;
    if (announcementKey !== attentionKey) {
      if (announcementKey !== '' || approvalCount > 0 || unreviewed > 0) {
        announcement.textContent = `${approvalCount} aprobaciones pendientes. ${unreviewed} agentes con actividad sin revisar.`;
      }
      announcementKey = attentionKey;
    }
    const visible = entries.slice(0, 5);
    const nextKey = JSON.stringify([visible, entries.length, sessions === null, approvalCount]);
    if (key === nextKey) return; // preserve focus and avoid DOM churn on game ticks
    key = nextKey;
    const focusedId = strip.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset['attentionId']
      : undefined;
    strip.replaceChildren();
    if (approvalCount > 0) {
      const approval = document.createElement('button');
      approval.className = 'attention-chip attention-blocked';
      approval.textContent = `! ${approvalCount}`;
      approval.title = `${approvalCount} aprobaciones pendientes · abrir revisión (Ctrl+A)`;
      approval.setAttribute('aria-label', approval.title);
      approval.dataset['attentionId'] = 'approvals';
      approval.addEventListener('click', openApprovalPanel);
      strip.appendChild(approval);
    }
    for (const entry of visible) {
      const button = document.createElement('button');
      button.className = `attention-chip attention-${entry.status}`;
      button.dataset['attentionId'] = entry.id;
      button.dataset['status'] = entry.status;
      const statusLabel =
        entry.kind === 'own' && entry.status === 'thinking'
          ? 'Unidad en movimiento · no indica razonamiento ni bloqueo'
          : ATTENTION_LABELS[entry.status];
      button.title = [entry.label, entry.context, statusLabel].filter(Boolean).join(' · ');
      button.setAttribute('aria-label', button.title);
      const dot = document.createElement('span');
      dot.className = 'attention-dot';
      dot.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'attention-name';
      name.textContent = entry.label;
      button.append(dot, name);
      button.addEventListener('click', () => {
        tracker.markSeen(entry.id);
        if (entry.kind === 'external') openExternalAgentChat(entry.ref);
        else focusOwnChat(entry.ref);
        render();
      });
      strip.appendChild(button);
    }
    const more = document.createElement('button');
    more.className = 'attention-more';
    more.textContent =
      entries.length > visible.length ? `+${entries.length - visible.length} · F8` : 'F8';
    more.title =
      sessions === null
        ? 'Todos los agentes · sesiones externas no disponibles'
        : 'Todos los agentes y perfiles';
    more.setAttribute('aria-label', more.title);
    more.dataset['attentionId'] = 'directory';
    more.addEventListener('click', openAgentsPanel);
    strip.appendChild(more);
    // Restore keyboard focus only when the user was already in the strip.
    if (focusedId) {
      const target = Array.from(strip.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.dataset['attentionId'] === focusedId,
      );
      (target ?? more).focus({ preventScroll: true });
    }
  };
  const stopState = state.subscribe(render);
  const stopDirectory = subscribeExternalSessionDirectory((rows) => {
    sessions = rows;
    render();
  });
  const stopApprovals = subscribeApprovals((items) => {
    approvalCount = items.length;
    blocked = new Set(
      items.flatMap((item) =>
        typeof item.payload['unit'] === 'string' ? [item.payload['unit']] : [],
      ),
    );
    render();
  });
  render();
  return () => {
    stopState();
    stopDirectory();
    stopApprovals();
    strip.remove();
    announcement.remove();
  };
}
