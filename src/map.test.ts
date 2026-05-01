import { afterEach, describe, expect, it, vi } from 'vitest';
import { showMapLoadError } from './map.ts';

describe('showMapLoadError', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders a visible alert instead of failing silently', () => {
    const appended: Array<{ id?: string; textContent?: string; role?: string }> = [];
    const element = {
      id: '',
      textContent: '',
      style: {} as Record<string, string>,
      setAttribute(name: string, value: string) {
        if (name === 'role') this.role = value;
      },
      role: '',
    };
    vi.stubGlobal('document', {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => element),
      body: { appendChild: (el: typeof element) => appended.push(el) },
    });

    showMapLoadError('No pude cargar repos reales: boom');

    expect(appended).toHaveLength(1);
    expect(appended[0]!.id).toBe('map-load-error');
    expect(appended[0]!.textContent).toContain('boom');
    expect(appended[0]!.role).toBe('alert');
  });
});
