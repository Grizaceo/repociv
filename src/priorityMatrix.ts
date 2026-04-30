// ─── RepoCiv — Priority Matrix (Phase 7b) ─────────────────────────────────────
// Assigns priority scores to local missions so queue dispatch respects urgency
// and importance rather than just FIFO order.

import type { LocalMission } from './types.ts';

// ─── Priority levels ──────────────────────────────────────────────────────────
export type Priority = 'critical' | 'high' | 'normal' | 'low';

// ─── Mission priority record (extends LocalMission) ──────────────────────────
export interface PrioritizedMission extends LocalMission {
  priority: Priority;
  score: number;        // raw numeric score (higher = more urgent)
  assignedAt: number;   // timestamp when assigned to a unit
}

// ─── Priority weights (all tuneable) ─────────────────────────────────────────
// Nota: scheduler.py tiene sus propios pesos. Pendiente unificar en shared/priority-weights.json
const WEIGHTS = {
  age:          20,  // how long the mission has been waiting (0→∞)
  test:         15,  // is a test file?
  extension:     5,  // tech-debt vs feature extension
  debt:         25,  // tech-debt flag (highest weight)
  size:         -3,  // larger files get lower priority (they take long)
  idle:          8,  // unit has been idle recently?
} as const;

// ─── Calculate priority score for a mission ─────────────────────────────────
export function priorityScore(mission: LocalMission, now: number): number {
  const age = (now - mission.assignedAt) / 60_000; // minutes waiting

  // Test files get a boost (they guard core correctness)
  const isTest = mission.fileName.includes('.test.') ||
                 mission.fileName.includes('.spec.') ||
                 mission.filePath.includes('/test/') ||
                 mission.filePath.includes('/tests/');

  // Tech-debt flag: files with TODO/FIXME/HACK/BUG in comments
  const isDebt = mission.filePath.includes('/debt/') ||
                  mission.filePath.includes('/legacy/') ||
                  mission.filePath.includes('/stale/');

  // Extension priority (TypeScript highest, config lowest)
  const ext = mission.fileName.split('.').pop() ?? '';
  const extScore: Record<string, number> = {
    ts: 3, tsx: 3, js: 2, jsx: 2, py: 1, rs: 1, go: 1,
    json: -1, yaml: -1, yml: -1, md: -1, css: -1,
  };
  const extBonus = extScore[ext] ?? 0;

  // File size penalty (rough: longer paths = bigger files = slower)
  const sizePenalty = Math.min(WEIGHTS.size * Math.max(0, mission.filePath.length - 40), 30);

  let score = 0;
  score += WEIGHTS.age * Math.log1p(age);
  if (isTest)  score += WEIGHTS.test;
  if (isDebt)  score += WEIGHTS.debt;
  score += WEIGHTS.extension * extBonus;
  score += sizePenalty;

  return Math.round(score * 100) / 100; // 2 decimal places
}

// ─── Classify a numeric score into a Priority label ─────────────────────────
export function scoreToPriority(score: number): Priority {
  if (score >= 60) return 'critical';
  if (score >= 35) return 'high';
  if (score >= 15) return 'normal';
  return 'low';
}

// ─── Enrich a LocalMission with priority metadata ─────────────────────────────
export function prioritizeMission(mission: LocalMission, now: number = Date.now()): PrioritizedMission {
  const score = priorityScore(mission, now);
  return {
    ...mission,
    priority: scoreToPriority(score),
    score,
    assignedAt: mission.assignedAt ?? now,
  };
}

// ─── Sort a queue by priority (highest score first) ─────────────────────────
export function sortByPriority(missions: LocalMission[], now: number = Date.now()): PrioritizedMission[] {
  return missions
    .map(m => prioritizeMission(m, now))
    .sort((a, b) => b.score - a.score);
}

// ─── Pick the next mission from the queue using priority ────────────────────
export function peekNextMission(missions: LocalMission[], now: number = Date.now()): PrioritizedMission | null {
  if (missions.length === 0) return null;
  const sorted = sortByPriority(missions, now);
  return sorted[0] ?? null;
}

// ─── Priority panel state ────────────────────────────────────────────────────
let _panelOpen = false;
export function isPriorityPanelOpen(): boolean { return _panelOpen; }
export function togglePriorityPanel(): boolean {
  _panelOpen = !_panelOpen;
  return _panelOpen;
}
