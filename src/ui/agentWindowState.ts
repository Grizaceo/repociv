import type { ExternalChatMessage } from '../externalAgents.ts';

export function normalizeMessage(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function countUserText(messages: readonly ExternalChatMessage[], text: string): number {
  const normalized = normalizeMessage(text);
  return messages.filter(
    (message) => message.role === 'user' && normalizeMessage(message.text) === normalized,
  ).length;
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    idle: 'listo',
    working: 'trabajando',
    blocked: 'esperando tu respuesta',
    done: 'terminó',
  };
  return labels[status] ?? 'desconocido';
}
