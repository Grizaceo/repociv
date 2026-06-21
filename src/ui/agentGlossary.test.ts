import { describe, it, expect } from 'vitest';
import { agentTooltip } from './agentGlossary.ts';

describe('agentTooltip', () => {
  it('teaches the stateless nature of WORKER/SCOUT', () => {
    expect(agentTooltip('WORKER')).toMatch(/stateless|sin memoria/i);
    expect(agentTooltip('SCOUT')).toMatch(/stateless|sin memoria/i);
  });

  it('describes MAIN as the context-keeping principal agent', () => {
    expect(agentTooltip('MAIN')).toMatch(/principal/i);
    expect(agentTooltip('MAIN')).toMatch(/contexto/i);
  });

  it('is case-insensitive', () => {
    expect(agentTooltip('worker')).toBe(agentTooltip('WORKER'));
  });

  it('falls back to a neutral label for unknown/legacy types (no jargon leak)', () => {
    expect(agentTooltip('lexo')).toBe('Agente LEXO');
    expect(agentTooltip('')).toBe('Agente desconocido');
  });
});
