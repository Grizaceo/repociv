import { describe, expect, it } from 'vitest';
import { herdrHint } from './herdrHint.ts';

const ready = {
  claude:
    'Este Claude corre en una terminal fuera de herdr: RepoCiv lo lee, pero no puede escribirle. Para hablarle desde aquí, ciérralo y retómalo en un panel de herdr (ya cerrado, ⏎ copia el comando), o lanza uno nuevo con «+ Sesión» → En herdr.',
  devin:
    'Este Devin corre en una terminal fuera de herdr: RepoCiv lo lee, pero no puede escribirle. Para hablarle desde aquí, ábrelo dentro de un panel de herdr, o lanza uno nuevo con «+ Sesión» → En herdr.',
};
const shared = {
  missing:
    'RepoCiv solo puede escribirle a Claude y Devin cuando corren dentro de herdr, y herdr no está instalado. Instálalo (README → «Agentes en herdr») y abre ahí el agente.',
  stopped:
    'herdr no está corriendo. Ábrelo con `herdr` en una terminal y abre este agente en un panel.',
  outdated:
    'RepoCiv necesita herdr 0.9.1 o superior y tienes 0.8.0. Actualízalo con `herdr update` y abre el agente dentro de herdr.',
  incompatible:
    'herdr se actualizó, pero su servidor sigue en la versión anterior. Reinicia herdr cuando no tengas agentes trabajando y RepoCiv se reconectará.',
};
const unknown =
  'Este agente no corre dentro de herdr, así que RepoCiv no puede escribirle. Ábrelo en un panel de herdr para hablarle desde aquí.';

describe('herdrHint', () => {
  for (const family of ['claude', 'devin'] as const) {
    it(`explains ${family} outside a ready herdr`, () => {
      expect(herdrHint(family, { state: 'ready', version: '0.9.1', minVersion: '0.9.1' })).toBe(
        ready[family],
      );
    });
    for (const [state, text] of Object.entries(shared)) {
      it(`explains ${state} for ${family}`, () => {
        const hint = herdrHint(family, { state, version: '0.8.0', minVersion: '0.9.1' });
        expect(hint).toBe(text);
        expect(hint).not.toContain('/');
      });
    }
    it(`uses the unknown hint for ${family} while loading or on failure`, () => {
      expect(herdrHint(family, null)).toBe(unknown);
      expect(herdrHint(family, null)).not.toContain('/');
      expect(ready[family]).not.toContain('/');
    });
  }
});
