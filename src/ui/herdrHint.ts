export interface HerdrRuntime {
  state: string;
  version: string;
  minVersion: string;
}

const UNKNOWN = 'Este agente no corre dentro de herdr, así que RepoCiv no puede escribirle. Ábrelo en un panel de herdr para hablarle desde aquí.';
const READY = {
  claude: 'Este Claude corre en una terminal fuera de herdr: RepoCiv lo lee, pero no puede escribirle. Para hablarle desde aquí, ciérralo y retómalo en un panel de herdr (ya cerrado, ⏎ copia el comando), o lanza uno nuevo con «+ Sesión» → En herdr.',
  devin: 'Este Devin corre en una terminal fuera de herdr: RepoCiv lo lee, pero no puede escribirle. Para hablarle desde aquí, ábrelo dentro de un panel de herdr, o lanza uno nuevo con «+ Sesión» → En herdr.',
};
const RUNTIME_HINTS: Record<string, string> = {
  missing: 'RepoCiv solo puede escribirle a Claude y Devin cuando corren dentro de herdr, y herdr no está instalado. Instálalo (README → «Agentes en herdr») y abre ahí el agente.',
  stopped: 'herdr no está corriendo. Ábrelo con `herdr` en una terminal y abre este agente en un panel.',
  incompatible: 'herdr se actualizó, pero su servidor sigue en la versión anterior. Reinicia herdr cuando no tengas agentes trabajando y RepoCiv se reconectará.',
};

export function herdrHint(family: 'claude' | 'devin', runtime: HerdrRuntime | null): string {
  if (!runtime) return UNKNOWN;
  if (runtime.state === 'ready') return READY[family];
  if (runtime.state === 'outdated') {
    return `RepoCiv necesita herdr ${runtime.minVersion} o superior y tienes ${runtime.version}. Actualízalo con \`herdr update\` y abre el agente dentro de herdr.`;
  }
  return RUNTIME_HINTS[runtime.state] ?? UNKNOWN;
}

export function plainHerdrHint(text: string): string {
  return text.replaceAll('`', '');
}
