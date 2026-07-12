# Agent Assignment Policy

Tasks are assigned to agents based on their declared type and available concurrency slots. The orchestrator first matches the task's required agent type (MAIN, WORKER, SCOUT, CLAUDE, CODEX, OPENCLAW, or CURSOR when configured) to agents of that type. Among matching agents with free slots, the scheduler dispatches by priority score (age, test coverage, debt signals, file extension). If no agent of the required type has capacity, the task is queued until a slot opens or the task type is relaxed by the user.

This policy ensures that tasks are handled by appropriately specialized agents while distributing load through per-type concurrency limits and priority ordering — without a fatigue-based tie-breaker (removed in Fase 1 cleanup, 2026-07).
