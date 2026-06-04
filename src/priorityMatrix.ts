// ─── RepoCiv — Priority Matrix (Phase 7b) ─────────────────────────────────────
// Assigns priority scores to local missions so queue dispatch respects urgency
// and importance rather than just FIFO order.

import type { LocalMission } from './types.ts';
import PRIORITY_WEIGHTS from '../shared/priority-weights.json';

// ─── Priority levels ──────────────────────────────────────────────────────────
export type Priority = 'critical' | 'high' | 'normal' | 'low';

// ─── Mission priority record (extends LocalMission) ──────────────────────────
export interface PrioritizedMission extends LocalMission {
  priority: Priority;
  score: number; // raw numeric score (higher = more urgent)
  assignedAt: number; // timestamp when assigned to a unit
}

// ─── Priority weights — sourced from shared/priority-weights.json ─────────────
// Python scheduler.py loads the same file so both sides stay in sync.
const WEIGHTS = {
  age: PRIORITY_WEIGHTS.age as number,
  test: PRIORITY_WEIGHTS.test as number,
  extension: PRIORITY_WEIGHTS.extension as number,
  debt: PRIORITY_WEIGHTS.debt as number,
  size: PRIORITY_WEIGHTS.size as number,
  idle: PRIORITY_WEIGHTS.idle as number,
};

// ─── Calculate priority score for a mission ─────────────────────────────────
export function priorityScore(mission: LocalMission, now: number): number {
  const age = (now - mission.assignedAt) / 60_000; // minutes waiting

  // Test files get a boost (they guard core correctness)
  const isTest =
    mission.fileName.includes('.test.') ||
    mission.fileName.includes('.spec.') ||
    mission.filePath.includes('/test/') ||
    mission.filePath.includes('/tests/');

  // Tech-debt flag: files with TODO/FIXME/HACK/BUG in comments
  const isDebt =
    mission.filePath.includes('/debt/') ||
    mission.filePath.includes('/legacy/') ||
    mission.filePath.includes('/stale/');

  // Extension priority (TypeScript highest, config lowest)
  const ext = mission.fileName.split('.').pop() ?? '';
  const extScore: Record<string, number> = {
    ts: 3,
    tsx: 3,
    js: 2,
    jsx: 2,
    py: 1,
    rs: 1,
    go: 1,
    json: -1,
    yaml: -1,
    yml: -1,
    md: -1,
    css: -1,
  };
  const extBonus = extScore[ext] ?? 0;

  // File size penalty (rough: longer paths = bigger files = slower)
  const sizePenalty = Math.min(WEIGHTS.size * Math.max(0, mission.filePath.length - 40), 30);

  let score = 0;
  score += WEIGHTS.age * Math.log1p(age);
  if (isTest) score += WEIGHTS.test;
  if (isDebt) score += WEIGHTS.debt;
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
export function prioritizeMission(
  mission: LocalMission,
  now: number = Date.now(),
): PrioritizedMission {
  const score = priorityScore(mission, now);
  return {
    ...mission,
    priority: scoreToPriority(score),
    score,
    assignedAt: mission.assignedAt ?? now,
  };
}

// ─── Sort a queue by priority (highest score first) ─────────────────────────
export function sortByPriority(
  missions: LocalMission[],
  now: number = Date.now(),
): PrioritizedMission[] {
  return missions.map((m) => prioritizeMission(m, now)).sort((a, b) => b.score - a.score);
}

// ─── Pick the next mission from the queue using priority ────────────────────
export function peekNextMission(
  missions: LocalMission[],
  now: number = Date.now(),
): PrioritizedMission | null {
  if (missions.length === 0) return null;
  const sorted = sortByPriority(missions, now);
  return sorted[0] ?? null;
}

// ─── Priority panel state ────────────────────────────────────────────────────

import type { SubagentRun } from './types.ts';

const RISK_ORDER: Record<string, number> = {
  destructive: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Sort subagents for Orden de batalla: risk desc, then age (newest first). */
export function sortSubagentsForDisplay(runs: SubagentRun[]): SubagentRun[] {
  return [...runs].sort((a, b) => {
    const rd = (RISK_ORDER[b.risk] ?? 0) - (RISK_ORDER[a.risk] ?? 0);
    if (rd !== 0) return rd;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });
}
