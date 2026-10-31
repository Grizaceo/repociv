// ─── Agent context — read-only ficha + off-map offer for the side tabs ──────
// With the agent window open, Unidad/Manuscritos/Archivos describe the agent
// and the city of its repo instead of the last selected unit/city. When the
// repo is not on the map both surfaces offer to add it (automatic hex, or the
// map editor's place tool). DOM APIs only — agent data is remote text.

import {
  formatTokens,
  relativeTime,
  sessionLabel,
  shortModel,
  stateBadge,
  type ExternalSessionRow,
  type MapPlace,
} from '../externalAgents.ts';

function basename(path: string): string {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path;
}

function addButton(row: ExternalSessionRow, mode: 'auto' | 'pick'): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'agents-compose-send';
  button.textContent =
    mode === 'auto' ? 'Agregar al mapa · automático' : 'Agregar al mapa · elegir casilla';
  button.addEventListener('click', () => {
    window.dispatchEvent(
      new CustomEvent('repociv:add-repo-to-map', { detail: { repoId: row.cityId, mode } }),
    );
  });
  return button;
}

function addButtons(row: ExternalSessionRow): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'agent-add-repo-row';
  wrap.append(addButton(row, 'auto'), addButton(row, 'pick'));
  return wrap;
}

function line(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'agent-card-line';
  const key = document.createElement('span');
  key.className = 'agent-card-key';
  key.textContent = label;
  const val = document.createElement('span');
  val.textContent = value;
  row.append(key, val);
  return row;
}

/** The Unidad tab while an external agent window is open: read-only ficha. */
export function renderAgentUnitCard(
  el: HTMLElement,
  row: ExternalSessionRow | null,
  place: MapPlace | null,
  actions: { locate(): void; cli: (() => void) | null },
): void {
  el.replaceChildren();
  if (!row) {
    const empty = document.createElement('p');
    empty.className = 'agent-card-empty';
    empty.textContent = 'La ficha aparece cuando el agente registre su sesión.';
    el.append(empty);
    return;
  }

  const title = document.createElement('div');
  title.className = 'agent-card-title';
  title.textContent = sessionLabel(row);

  const meta = document.createElement('div');
  meta.className = 'agent-card-meta';
  const bits = [row.agent, row.model ? shortModel(row.model) : '', stateBadge(row.state)?.text ?? ''];
  meta.textContent = bits.filter(Boolean).join(' · ');
  const badge = stateBadge(row.state);
  if (badge?.title) meta.title = badge.title;

  const where =
    place?.kind === 'city'
      ? place.city.name
      : place?.kind === 'capital'
        ? 'Capital'
        : `fuera del mapa · ${basename(row.repo)}`;

  el.append(
    title,
    meta,
    line('Ciudad', where),
    line('Última actividad', relativeTime(row.lastActivityAt)),
    line('Comandos', String(row.commandCount)),
  );
  const tokens = formatTokens(row.totalTokens);
  if (tokens) el.append(line('Tokens', tokens));
  if (row.herdrPane?.status) el.append(line('Terminal', row.herdrPane.status));

  const actionsRow = document.createElement('div');
  actionsRow.className = 'agent-card-actions';
  const locate = document.createElement('button');
  locate.type = 'button';
  locate.className = 'agents-compose-send';
  locate.textContent = '📍';
  locate.title = 'Ir al agente en el mapa';
  locate.setAttribute('aria-label', 'Ir al agente en el mapa');
  locate.addEventListener('click', actions.locate);
  actionsRow.append(locate);
  if (actions.cli) {
    const cli = document.createElement('button');
    cli.type = 'button';
    cli.className = 'agents-compose-send';
    cli.textContent = '⌨ Abrir CLI';
    cli.addEventListener('click', actions.cli);
    actionsRow.append(cli);
  }
  el.append(actionsRow);

  if (place?.kind === 'off-map') el.append(addButtons(row));
}

/** Banner over Manuscritos/Archivos when the agent repo is off the map. */
export function renderOffMapOffer(el: HTMLElement, row: ExternalSessionRow): void {
  el.replaceChildren();
  const text = document.createElement('p');
  text.className = 'agent-offmap-text';
  text.textContent = `Este agente trabaja en ${basename(row.repo)}, que no está en el mapa. Se muestra la Capital.`;
  el.append(text, addButtons(row));
}
