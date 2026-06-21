# Swarm Civ — follow-up plan

Backend + map detachments ship in `321b36e`; user confirms progress bar works but **Orden de batalla** felt stale until subagents complete.

## Implementation status (2026-06)

| Track | Status |
|-------|--------|
| **B1a** Schema + `MissionHarnessContext` | Done — `server/mission_harness.py`, harness on spawn/ledger/events |
| **A** Live Orden + progress pipeline | Done — `register_progress` on spawn/stream, bridge `working`, chips/spinner |
| **B1b** Claude `stream-json` parser | Done — `process_claude_stream_line` when `REPOCIV_SWARM_TRACK` ≠ 0 |
| **B1c** Hermes CLI spike | Done — `process_hermes_stream_line` best-effort + limited badge |
| **B2** `subagent_dispatch` | Stub — command type + `request_dispatch` returns `not_implemented` |

Original plan detail below (historical spec).

---

## A. Visual fixes (Orden de batalla live state)

### Observed behavior

- `subagent_spawn` / ephemeral units update the map promptly.
- Parent mission progress (`unit.workProgress`, hero bar via `state.subscribe` → `refreshHero` in `src/main.ts`) updates during the parent stream.
- Orden rows show `s.status` (first 4 chars) and optional `subagentProgress` peek, but **mid-run updates are thin**:
  - `register_progress()` in `server/subagent_tracker.py` exists but is **never called** from `process_cursor_ndjson_line` or `agent_runner` loops — only a final `subagent_progress` is sent inside `register_complete()`.
  - `bridge.ts` `subagent_progress` calls `appendSubagentProgress` only; it does **not** `updateSubagent({ status: 'running' })` or sync ephemeral `unit.state`.
  - Row badge uses raw `status` (`proposed` / `running`); no `working` label or spinner CSS (`.orden-status--*` only referenced in `ordenDeBatalla.ts`, no rules in `panels.css` beyond base row styles).

### Target UX

| Concern | Target |
|--------|--------|
| Row state while subagent runs | Show **working** (or animated **running**) with spinner; not frozen on `prop`/`runn` until `subagent_complete`. |
| Progress text | Stream `subagent_progress` → peek line updates live (assistant deltas, phase labels). |
| Panel refresh | Re-render Orden when `subagents` or `subagentProgress` changes (subscribe already fires `notify()` — ensure selected-unit path always re-renders). |
| Harness hint | Show harness label on row when `SubagentRun.harness` is set (see §B). |
| Ephemeral unit | Optional: `unit_state` `working` on ephemeral id while subagent `status === 'running'`. |

### Implementation steps

1. **Backend — emit progress during Task lifetime** (`server/subagent_tracker.py`, `server/agent_runner.py`)
   - On `tool_use` Task spawn (after `register_spawn`): `register_progress(sid, phase='spawned', text=label[:80])`.
   - In `process_cursor_ndjson_line`, on intermediate NDJSON (e.g. `assistant` chunks, subagent heartbeat if present): map to `register_progress` throttled (~1 Hz).
   - On `tool_result` for Task: keep `register_complete`; add progress `phase='complete'` before `subagent_complete`.
   - Pass `parentHarness` on spawn event (§B) for UI.

2. **Bridge handler** (`src/bridge.ts`)
   - `subagent_progress`: besides `appendSubagentProgress`, if subagent exists and status is `proposed`, `updateSubagent(id, { status: 'running' })`.
   - If `evt.ephemeralUnitId` or lookup via run: `setUnitState(ephemeral, 'working')` (mirror parent mission semantics).
   - `subagent_complete`: set ephemeral to `idle` or despawn (already removes unit).

3. **GameState** (`src/game.ts`)
   - Optional: `touchSubagent(id)` that bumps a `lastProgressAt` field for sort/peek freshness.
   - Ensure `appendSubagentProgress` + `updateSubagent` both call `notify()` (already do).

4. **Orden panel** (`src/ui/ordenDeBatalla.ts`, `src/styles/panels.css`)
   - Map display status: `proposed` → pending; `running` → **working** + `.orden-status--working` spinner (`@keyframes` or CSS animation).
   - Subscribe hook: export `bindOrdenDeBatalla(state)` that registers `state.subscribe(() => { if (selectedUnit) renderOrdenDeBatalla(...) })` — today render only runs from `showUnitPanel` / `refreshHero` when selection unchanged; verify progress-only notifies re-render (should via `refreshHero`; add explicit subagent-only callback if profiling shows gaps).
   - Row meta: `${kind} · ${risk} · ${harness ?? 'cursor'}`.
   - Use `subagentProgress` last line as primary subtitle when non-empty; status chip secondary.

5. **Panel wiring** (`src/ui/panel.ts`, `src/main.ts`)
   - Call `bindOrdenDeBatalla(state)` once at bootstrap alongside hero subscribe.
   - On unit deselect, `hideOrdenDeBatalla()` (existing).

6. **Tests**
   - `src/bridge.test.ts`: `subagent_progress` promotes `proposed` → `running` and sets ephemeral `working`.
   - `src/game.test.ts` or small DOM-less test: progress append triggers notify subscriber count.
   - `server/test_subagent_tracker.py`: spawn emits at least one progress before complete.

### Files

| File | Change |
|------|--------|
| `server/subagent_tracker.py` | Call `register_progress` on spawn + stream hooks |
| `server/agent_runner.py` | Wire harness into tracker context |
| `src/bridge.ts` | Progress → status + unit_state |
| `src/game.ts` | Optional `lastProgressAt` / helpers |
| `src/ui/ordenDeBatalla.ts` | Labels, harness, spinner, bind subscribe |
| `src/ui/panel.ts` | Bind helper |
| `src/main.ts` | Bootstrap bind |
| `src/styles/panels.css` | `.orden-status--working`, spinner |
| `src/types.ts` | `SubagentRun.harness?`, progress phase on event type if needed |

---

## B. Multi-harness subagent parity

### Today

- Tracking is **passive parse-only** on **cursor-agent** NDJSON: `process_cursor_ndjson_line` in `subagent_tracker.py`, hooked only in `_run_cursor_agent_streaming` (`agent_runner.py` ~773).
- Non-cursor harness logs a warn: Task subagents not tracked (`_execute_streaming` ~305).
- `SubagentRun` has no `harness` / `parentHarness` field (`src/types.ts`).
- Hermes / Claude / OpenClaw / Codex runners read **plain text lines** (no Task tool_use detection).

### Principle

**Default subagent harness = parent mission harness** (the harness RepoCiv used for `_execute_streaming`). User override per subtask is out of scope.

### Harness inventory (`server/agent_runner.py`)

| Harness | Entry | Stream shape | Subagent hook today |
|---------|--------|--------------|---------------------|
| `cursor` | `_run_cursor_agent_streaming` | NDJSON `stream-json`; `tool_use` / `tool_result` | **Yes** — `process_cursor_ndjson_line` |
| `claude-code` | `_run_claude_code_streaming` | Plain stdout lines | No |
| `hermes` | `_run_hermes_streaming` | HTTP/SSE (adapter) | No |
| `hermes` (CLI) | `_run_hermes_cli_streaming` | Plain stdout | No — Hermes may spawn internal subagents opaquely |
| `openclaw` | `_run_openclaw_streaming` | Adapter-specific | No |
| `codex` | `_run_codex_streaming` | Plain stdout | No |
| `container` | `_run_container_streaming` | Container logs | No |

### Architecture

```
_execute_streaming(..., harness)
    │
    ├─► set mission context: { missionId, unitId, cityId, parentHarness }
    │
    └─► per-runner line loop
            ├─ cursor NDJSON  → subagent_tracker.process_cursor_ndjson_line(...)
            ├─ claude stream-json (future) → process_claude_stream_line(...)
            ├─ hermes CLI JSON/events (future) → process_hermes_stream_line(...)
            └─ openclaw/codex (TBD after format audit)
```

**`subagent_tracker` extensions**

- `configure(parent_harness: str | None)` or per-call `parent_harness` on spawn APIs.
- `register_spawn(..., harness: str)` → persist on run, emit on `subagent_spawn` / DuckDB `subagent_runs.harness`.
- `parentHarness` on in-memory run dict for Orden + mission log (`src/ui/missionLogPanel.ts`).

**Detection (Phase 1 — passive)**

| Harness | Detection approach |
|---------|-------------------|
| Cursor | Existing Task `tool_use` + `tool_result` |
| Claude | Add `--output-format stream-json` to claude loop (mirror cursor); parse `tool_use` name `Task` or Agent SDK subagent events — **validate** against installed CLI |
| Hermes CLI | Inspect stdout for structured lines (JSON) or log markers if Hermes exposes subagent start/end; else document **opaque** until Hermes emits hooks |
| Hermes HTTP | Parse SSE event types if/when upstream adds subagent telemetry |
| OpenClaw / Codex | Spike: one captured mission log; define minimal regex/JSON parser or defer |

**Dispatch (Phase 2 — explicit, optional)**

- Bridge command `subagent_dispatch` (new) that runs a child mission with **same** `harness` + `model` as parent, instead of relying on parent agent's Task tool.
- `agent_runner` spawns child subprocess with shared `working_dir` / `city_id`.
- Risk/approval via existing `subagent_risk.py` + `subagent_spawn` approval path.

### Phased rollout

| Phase | Scope | Deliverable |
|-------|--------|-------------|
| **1a** | Schema + events | `harness` on `SubagentRun`, bridge schema, ledger column, Orden/meta display |
| **1b** | Claude passive | `process_claude_stream_line` in tracker + hook in `_run_claude_code_streaming` |
| **1c** | Hermes passive | Best-effort parser + doc limitation if no structured subagent events |
| **2** | Explicit dispatch | Bridge command + runner child process; same harness default |
| **3** | User picks harness per subtask | Out of scope |

### Risks

- **Hermes subagents opaque** — parent may delegate inside CLI without RepoCiv-visible Task events; may need Hermes upstream event contract.
- **API drift** — cursor/claude NDJSON shapes marked TODO in `_parse_cursor_ndjson_chunk`; need fixture tests per CLI version.
- **Double counting** — passive parse + explicit dispatch could duplicate runs; use `tool_use_id` / mission child id dedup in tracker.
- **Approval race** — high-risk Task on non-cursor harness must still hit `subagent_spawn` approval (`bridge.py` `_dispatch_command`).

### Files (parity)

| File | Role |
|------|------|
| `server/subagent_tracker.py` | `parentHarness`, per-harness processors, `register_progress` |
| `server/agent_runner.py` | Hook all streaming loops; remove cursor-only warn |
| `server/bridge.py` | Pass harness in events; Phase 2 dispatch handler |
| `server/research_ledger.py` | `subagent_runs.harness` column + migration |
| `server/event_store.py` | Optional harness on JSONL subagent events |
| `src/types.ts`, `src/bridgeSchema.ts` | Event + run types |
| `src/bridge.ts` | Register harness on spawn |
| `src/ui/ordenDeBatalla.ts`, `src/ui/missionLogPanel.ts` | Display harness |
| `docs/MCP.md`, `docs/DATA_SOURCES.md` | Document multi-harness |

---

## References (current)

- Tracker: `server/subagent_tracker.py` — `process_cursor_ndjson_line`, `on_task_spawn`, `register_progress` (unused mid-flight)
- UI: `src/ui/ordenDeBatalla.ts` — `renderOrdenDeBatalla`, diagnostic checklist
- Subscribe: `src/main.ts` `state.subscribe(refreshHero)` → `showUnitPanel` → Orden render
- Bridge events: `src/bridge.ts` cases `subagent_spawn` | `subagent_progress` | `subagent_complete`
- Tests: `server/test_subagent_tracker.py`, `src/bridge.test.ts`, `src/game.test.ts`
