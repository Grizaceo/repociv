# Agent Assignment Policy

Tasks are assigned to agents based on their declared type and current fatigue level. The orchestrator first matches the task's required agent type (MAIN, WORKER, SCOUT, CLAUDE, CODEX, OPENCLAW, or CURSOR when configured) to available agents of that type. Among the matching agents, the one with the lowest fatigue score (highest effective speed) is selected. If no agent of the required type is available, the task is queued until an agent of that type becomes available or the task type is relaxed by the user.

This policy ensures that tasks are handled by appropriately specialized agents while distributing load to prevent any single agent from becoming overloaded and fatigued.
