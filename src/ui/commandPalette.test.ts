import { describe, expect, it } from 'vitest';
import { commandMatchesQuery, type PaletteCommand } from './commandPalette.ts';

const cmd = (over: Partial<PaletteCommand> = {}): PaletteCommand => ({
  id: 'x',
  group: 'Panel',
  label: 'Aprobaciones',
  hint: 'A',
  run: () => {},
  ...over,
});

describe('commandMatchesQuery', () => {
  it('empty query matches everything', () => {
    expect(commandMatchesQuery(cmd(), '')).toBe(true);
    expect(commandMatchesQuery(cmd(), '   ')).toBe(true);
  });

  it('matches a case-insensitive substring of the label', () => {
    expect(commandMatchesQuery(cmd({ label: 'Desplegar WORKER' }), 'work')).toBe(true);
    expect(commandMatchesQuery(cmd({ label: 'Desplegar WORKER' }), 'WORK')).toBe(true);
    expect(commandMatchesQuery(cmd({ label: 'Desplegar WORKER' }), 'scout')).toBe(false);
  });

  it('also matches against group and hint', () => {
    expect(commandMatchesQuery(cmd({ group: 'Agente', label: 'Desplegar SCOUT' }), 'agente')).toBe(true);
    expect(commandMatchesQuery(cmd({ hint: 'F8', label: 'Observabilidad' }), 'f8')).toBe(true);
  });

  it('requires ALL whitespace-separated terms (order-independent AND)', () => {
    const c = cmd({ group: 'Agente', label: 'Desplegar WORKER', hint: 'W' });
    expect(commandMatchesQuery(c, 'desplegar worker')).toBe(true);
    expect(commandMatchesQuery(c, 'worker desplegar')).toBe(true); // order-independent
    expect(commandMatchesQuery(c, 'desplegar scout')).toBe(false); // one term missing
  });

  it('tolerates a missing hint', () => {
    expect(commandMatchesQuery(cmd({ hint: undefined, label: 'Pendientes' }), 'pend')).toBe(true);
  });
});
