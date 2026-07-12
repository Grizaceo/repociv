# RepoCiv — Implementation Plan (Current)

**Status:** live index · **Updated:** 2026-07-12

The executable rehabilitation plan is:

- [`../execplan/REPOCIV_TOTAL_REHABILITATION.md`](../execplan/REPOCIV_TOTAL_REHABILITATION.md)

The original 2026-05 "Agent OS Industrial" plan is historical and has been archived at:

- [`archive/plans/REPOCIV_V2_IMPLEMENTATION_PLAN_2026-05.md`](archive/plans/REPOCIV_V2_IMPLEMENTATION_PLAN_2026-05.md)

## Current product contract

RepoCiv is a local-first single-operator control room for repositories and real agents. Its essential lifecycle is:

1. select a discovered repository;
2. assign a concrete task to an agent;
3. observe progress through one command/event lifecycle;
4. approve, reject, cancel, or inspect failure;
5. retrieve evidence and query the ledger by command ID.

The canonical write path is the Python bridge command bus. Vite filesystem endpoints are temporary local adapters while ownership migrates to that API.

## Retained

- 2D macro map, 3D macro map, and local 2D repository view;
- repo onboarding and selected-root state;
- command bus, policy/approval flow, event store, sessions, run-state, and evidence ledger;
- real harness adapters (Hermes, Claude Code, Codex, Cursor, OpenClaw where available);
- capabilities, profiles, recovery, observability, and task/approval UI when wired to the canonical lifecycle;
- wonders, eras, Gaceta, and construction only as secondary surfaces that do not auto-start or block the essential flow.

## Removed after dogfooding

The following systems were removed from trunk because they duplicated core flow, inflated state, or lacked demonstrated daily value:

- Context Fatigue/XCOM simulation;
- Tensor Context algebra;
- Swarm Engine consensus layer;
- embedded xterm terminal panel;
- DuckDB `subagent_runs` materialization (subagent events remain in JSONL).

Do not reintroduce them without measured evidence and an explicit scope decision.

## Acceptance gates

Every implementation milestone must pass its directed tests and the final branch must pass:

```bash
bash scripts/check.sh
npx playwright test --project=chromium
```

Final verification also requires a fresh isolated clone/worktree, temporary state/token/ports, HTTP/WS/MCP security probes, the essential user lifecycle, and deterministic 2D/3D/local/mobile screenshots. Exact commands and stop conditions are maintained in the ExecPlan.
