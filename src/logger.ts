// ─── RepoCiv — Centralized logger ────────────────────────────────────────────
// Thin wrapper around console so production code doesn't trigger no-console.
// In tests, the underlying console can be spied on normally.
/* eslint-disable no-console */

export const logger = {
  log: (...args: unknown[]): void => console.log(...args),
  warn: (...args: unknown[]): void => console.warn(...args),
  error: (...args: unknown[]): void => console.error(...args),
};
