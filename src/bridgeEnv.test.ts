import { afterEach, describe, expect, it, vi } from 'vitest';

describe('bridge transport auth environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps the configured token for WebSocket auth when a direct bridge URL is set', async () => {
    vi.stubEnv('VITE_BRIDGE_URL', 'http://127.0.0.1:5274');
    vi.stubEnv('VITE_BRIDGE_TOKEN', 'direct-bridge-token-32-characters');
    vi.resetModules();

    const env = await import('./bridgeEnv.ts');

    expect(env.BRIDGE_URL).toBe('http://127.0.0.1:5274');
    expect(env.bridgeWebSocketToken()).toBe('direct-bridge-token-32-characters');
    expect(env.bridgeHeaders()).toEqual({
      'X-RepoCiv-Token': 'direct-bridge-token-32-characters',
    });
  });
});
