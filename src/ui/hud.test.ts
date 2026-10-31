// ─── RepoCiv — HUD icon registry ────────────────────────────────────────────
//
// `hud.ts` registers only the Lucide icons RepoCiv uses (importing them all
// would add ~700 KB). A `data-lucide="…"` literal in the UI whose icon is not
// registered renders as an empty box, so this test walks the UI sources and
// checks every literal against the registry exposed on `window.lucide.icons`.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const UI_DIR = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function pascalCase(icon: string): string {
  return icon
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function lucideLiteralsInUi(): string[] {
  const icons = new Set<string>();
  for (const file of sourceFiles(UI_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/data-lucide="([a-z0-9-]+)"/g)) {
      icons.add(pascalCase(match[1]!));
    }
  }
  return [...icons];
}

describe('hud lucide icon registry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers every data-lucide icon the UI renders', async () => {
    const icons = lucideLiteralsInUi();
    expect(icons).toContain('Flag');
    expect(icons.length).toBeGreaterThan(0);

    vi.stubGlobal('window', {});
    await import('./hud.ts');
    const registry = (window as unknown as { lucide?: { icons: Record<string, unknown> } }).lucide;
    expect(registry).toBeDefined();

    for (const icon of icons) {
      expect(registry!.icons[icon], `${icon} is missing from hud.ts lucideIcons`).toBeDefined();
    }
  });
});
