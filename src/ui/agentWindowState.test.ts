import { describe, expect, it } from 'vitest';
import { countUserText, statusLabel } from './agentWindowState.ts';
import type { ExternalChatMessage } from '../externalAgents.ts';

describe('agent window state', () => {
  it('counts whitespace-normalized user messages without counting assistant replies', () => {
    const messages = [
      { role: 'user', text: 'hola \n mundo' },
      { role: 'assistant', text: 'hola mundo' },
      { role: 'user', text: ' hola  mundo ' },
      { role: 'user', text: 'other' },
    ] as ExternalChatMessage[];
    expect(countUserText(messages, 'hola mundo')).toBe(2);
  });

  it('labels actual herdr states', () => {
    expect(statusLabel('idle')).toBe('listo');
    expect(statusLabel('working')).toBe('trabajando');
    expect(statusLabel('blocked')).toBe('esperando tu respuesta');
    expect(statusLabel('done')).toBe('terminó');
  });
});
