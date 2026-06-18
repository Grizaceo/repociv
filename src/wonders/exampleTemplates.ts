// ─── RepoCiv — Wonder Example Templates ──────────────────────────────────────
// Bibliotheca and LabHub are no longer hardcoded built-ins. They ship as
// CONNECTABLE EXAMPLES: a fresh RepoCiv shows the onboarding guide + these
// cards instead of pre-installed wonders. "Conectar" writes the manifest to
// ~/.repociv/wonders/<id>.json (POST /api/wonders/connect), after which the
// wonder flows through the exact same path as any user-defined iframe service
// (registry + launcher + auto-start).
//
// The `launch` recipe for these two lives server-side in
// server/wonder_launcher.py::WONDER_LAUNCH_SPECS (battle-tested venv/lockfile/
// WSL2 handling), so the connected manifest itself stays launch-less and the
// built-in recipe drives auto-start. Generic services connected via the F6
// form carry their own `launch` field instead.

import {
  LGB_BACKEND_URL,
  WONDER_BIBLIOTHECA_URL,
  WONDER_INSTITUTUM_API_URL,
  WONDER_INSTITUTUM_URL,
} from '../wonderEnv.ts';
import type { WonderManifest } from './types.ts';

export interface WonderExample {
  /** The manifest written to ~/.repociv/wonders/<id>.json on connect. */
  manifest: WonderManifest;
  /** Public GitHub repo of the companion app (shown on the card). */
  repoUrl: string;
  /** One-line description of what the wonder does. */
  description: string;
  /** Default repo dir suggested for auto-start; server-side recipe uses
   *  REPOCIV_WONDER_<ID>_DIR (overrideable). Shown for transparency. */
  defaultRepoDir: string;
  /** Human-readable boot summary (ports/processes), shown on the card. */
  bootSummary: string;
}

const BIBLIOTHECA: WonderExample = {
  repoUrl: 'https://github.com/Grizaceo/la-gran-biblioteca',
  description:
    'Grafo de conocimiento sobre tus repos: navega archivos como una biblioteca, ' +
    'descubre relaciones entre proyectos y consulta documentación indexada.',
  defaultRepoDir: '~/.hermes/workspace/repos/la-gran-biblioteca',
  bootSummary: 'API :3001 (python -m backend.library_bridge) · UI :5173 (npm run dev)',
  manifest: {
    id: 'bibliotheca',
    title: 'Bibliotheca Alexandrina',
    kind: 'iframe',
    category: 'knowledge',
    version: '0.1.0',
    defaultEnabled: true,
    automationLevel: 'passive',
    passiveMode: true,
    agenticMode: false,
    canSuggest: true,
    canAct: false,
    requiresConfirmation: true,
    ui: {
      url: WONDER_BIBLIOTHECA_URL,
      preferredWidth: '70vw',
      preferredHeight: '75vh',
      sandbox: ['allow-scripts', 'allow-same-origin', 'allow-forms'],
    },
    health: {
      url: `${LGB_BACKEND_URL}/api/health`,
      timeoutMs: 4000,
      degradedAllowed: true,
    },
    permissions: {
      readRepos: true,
      writeRepos: false,
      network: 'loopback-only',
      requiresApprovalForMutations: true,
    },
    optionalFeatures: [
      {
        id: 'graphSuggestions',
        label: 'Sugerencias de relaciones',
        description: 'El agente Astrónomo sugiere conexiones entre nodos',
        defaultEnabled: false,
        requiresUserOptIn: true,
      },
      {
        id: 'aiRelationDiscovery',
        label: 'Descubrimiento AI de relaciones',
        description: 'Usa grafo offline para encontrar vínculos no obvios entre repos',
        defaultEnabled: false,
        requiresUserOptIn: true,
      },
    ],
    events: {
      emits: ['wonder.ready', 'wonder.selection', 'wonder.report.created'],
      accepts: ['repociv.focus', 'repociv.open_local_view', 'repociv.graph_suggestions'],
    },
    actions: [
      { id: 'open', label: 'Entrar', risk: 'safe', requiresUserOptIn: false },
      { id: 'ask_agent', label: 'Preguntar a agente', risk: 'safe', requiresUserOptIn: true },
    ],
    mcp: { enabled: false, server: null },
  },
};

const INSTITUTUM: WonderExample = {
  repoUrl: 'https://github.com/Grizaceo/labhub',
  description:
    'LabHub — laboratorio de experimentos: lanza, monitorea y compara corridas ' +
    'sobre tus repos, con bloqueos opcionales sobre ciudades en trabajo crítico.',
  defaultRepoDir: '~/.hermes/workspace/repos/labhub',
  bootSummary: 'API :5281 · UI :5280 (npm start → dev-start.sh)',
  manifest: {
    id: 'institutum',
    title: 'Institutum Laboratorium / LabHub',
    kind: 'iframe',
    category: 'lab',
    version: '0.1.0',
    defaultEnabled: true,
    automationLevel: 'assist',
    passiveMode: true,
    agenticMode: true,
    canSuggest: true,
    canAct: false,
    requiresConfirmation: true,
    ui: {
      url: WONDER_INSTITUTUM_URL,
      preferredWidth: '70vw',
      preferredHeight: '75vh',
      sandbox: ['allow-scripts', 'allow-same-origin', 'allow-forms'],
    },
    health: {
      url: `${WONDER_INSTITUTUM_API_URL}/health`,
      timeoutMs: 4000,
      degradedAllowed: true,
    },
    permissions: {
      readRepos: false,
      writeRepos: false,
      network: 'loopback-only',
      requiresApprovalForMutations: true,
    },
    optionalFeatures: [
      {
        id: 'hardLocks',
        label: 'Bloqueos duros',
        description: 'Impide completamente la edición de ciudades con experimentos críticos',
        defaultEnabled: false,
        requiresUserOptIn: true,
      },
    ],
    events: {
      emits: ['wonder.ready', 'labhub.experiment.started', 'labhub.experiment.finished'],
      accepts: ['repociv.focus_city'],
    },
    actions: [
      { id: 'open', label: 'Abrir Institutum', risk: 'safe', requiresUserOptIn: false },
      {
        id: 'kill_experiment',
        label: 'Detener experimento',
        risk: 'manual',
        requiresUserOptIn: true,
      },
    ],
    mcp: { enabled: false, server: null },
  },
};

/** Connectable example wonders, shown in the onboarding guide. */
export const WONDER_EXAMPLES: readonly WonderExample[] = [BIBLIOTHECA, INSTITUTUM];

export function getWonderExample(id: string): WonderExample | undefined {
  return WONDER_EXAMPLES.find((e) => e.manifest.id === id);
}
