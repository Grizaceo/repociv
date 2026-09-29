import { describe, expect, it } from 'vitest';
import { loadConfigFromFile } from 'vite';

// Guard the actual resolved Vite configuration, not a copy of its host string.
describe('local development server security', () => {
  it('binds only to loopback and enforces Vite host validation by default', async () => {
    const result = await loadConfigFromFile(
      { command: 'serve', mode: 'development' },
      'vite.config.ts',
      process.cwd(),
    );
    expect(result).not.toBeNull();
    expect(result?.config.server?.host).toBe('127.0.0.1');
    expect(result?.config.server?.allowedHosts).toBe(false);
  });
});
