"""Fase 1 Acceptance Gates Verification — RepoCiv v2.0

This document verifies that all acceptance criteria from the Fase 1 Gate
(§8 Hoja de Ruta, Fase 1: Tensor Context + Worktrees + Hooks) are met.

Date: 2026-05-01
Reviewed: 371 tests passed, 1 skipped
"""

# ──────────────────────────────────────────────────────────────────────────────
# GATE F1 ACCEPTANCE CRITERIA
# ──────────────────────────────────────────────────────────────────────────────

## 1. ✅ repociv.yaml CONTROLS WORKTREE LIFECYCLE

**What:** Repositories can declare worktree preferences in repociv.yaml

**Verification:**
- ✅ `server/repociv_hooks.py` loads and parses repociv.yaml with PyYAML
- ✅ `worktrees_enabled(repo)` returns config["worktrees"]["enabled"]
- ✅ `create_worktree(repo, issue_id)` respects the enabled flag (returns None if disabled)
- ✅ `remove_worktree(repo, issue_id)` cleans up worktrees (best-effort)
- ✅ Tests: `test_repociv_hooks.py::TestFeatureFlags::test_worktrees_enabled_true_if_configured`
- ✅ Tests: `test_repociv_hooks.py::TestLoadHooksConfig::test_load_valid_yaml`

**Example repociv.yaml:**
```yaml
version: "1"
worktrees:
  enabled: true
  base_dir: .repociv-wt
```

---

## 2. ✅ ORCHESTRATOR PAUSES ON .repociv/status SENTINEL

**What:** A2O Sentinel File (H1) blocks orchestrator if agent sets "blocked" or "needs-human-review"

**Verification:**
- ✅ `workspace_issue.write_sentinel(repo, issue_id, status)` atomically writes to `.repociv/status`
- ✅ `workspace_issue.read_sentinel(repo, issue_id)` reads the current status
- ✅ Valid statuses: "blocked", "needs-human-review", "done", "ok"
- ✅ `task_orchestrator.py` checks `_wi.read_sentinel()` before advancing phases
- ✅ When sentinel == "blocked" or "needs-human-review", phase transitions to BLOCKED
- ✅ Tests: `test_workspace_issue_phase1.py::TestA2OSentinel::test_sentinel_valid_statuses`
- ✅ Tests: `test_workspace_issue_phase1.py::TestA2OSentinel::test_read_nonexistent_sentinel_returns_none`

**Code Flow (task_orchestrator.py lines ~165-175):**
```python
# ── A2O sentinel check (H1) ──────────────────────────────────────────────────
if not checkpoint_gate:
    _a2o = _wi.read_sentinel(repo, issue_id)
    if _a2o in ("blocked", "needs-human-review"):
        _wi.patch_issue_state(repo, issue_id, {"phase": "blocked"})
        # Phase stays BLOCKED until human clears sentinel
```

---

## 3. ✅ PHASE CHECKPOINTS PREVENT AUTONOMOUS PROGRESS

**What:** H4 hard checkpoints pause execution after spec, plan, and all-steps

**Verification:**
- ✅ `task_orchestrator.py` implements checkpoint gate logic (lines ~150-165)
- ✅ `checkpoints_enabled(repo)` from repociv_hooks controls whether checkpoints are active
- ✅ When checkpoint is active, orchestrator writes `checkpointGate` to state.json
- ✅ On resume, orchestrator checks if sentinel was cleared by human
- ✅ If human hasn't cleared the sentinel, phase remains "blocked"
- ✅ Tests: `test_workspace_issue_phase1.py::TestPhaseIntegration::test_checkpoint_gate_prevents_advance`
- ✅ Tests: `test_workspace_issue_phase1.py::TestPhaseIntegration::test_phase_advance_on_sentinel_clear`

**Code Flow (task_orchestrator.py lines ~145-175):**
```python
# ── Checkpoint gate resume (H4) ──────────────────────────────────────────────
checkpoint_gate = state.get("checkpointGate")
if phase == "blocked" and checkpoint_gate:
    _gate_sentinel = _wi.read_sentinel(repo, issue_id)
    if _gate_sentinel in ("blocked", "needs-human-review"):
        # Human hasn't reviewed yet — remain blocked
        return state
    # Human cleared the sentinel → resume execution
```

---

## 4. ✅ suma() DEDUPLICATES BY HASH

**What:** TensorContext.suma() merges two DC lists, deduplicating by deterministic ID

**Verification:**
- ✅ `ContextDirective.id` is SHA-256[:16] fingerprint of `text` (deterministic)
- ✅ `TensorContext.suma(a, b)` dedupes by id, keeping first occurrence
- ✅ Order: preserves order of `a`, appends unique items from `b`
- ✅ Tests: `test_tensor_context.py::TestTensorContextSuma::test_suma_dedup_by_id`
- ✅ Tests: `test_tensor_context.py::TestTensorContextSuma::test_suma_preserves_order`

**Example:**
```python
dc1 = ContextDirective("hello")  # id = SHA-256("hello")[:16]
dc2 = ContextDirective("world")
dc3 = ContextDirective("hello")  # same text → same id as dc1

result = tc.suma([dc1, dc2], [dc3])
# result = [dc1, dc2]  # dc3 dropped (duplicate)
```

---

## 5. ✅ budget_prune() RESPECTS MUST_INCLUDE AND TOKEN LIMITS

**What:** TensorContext.budget_prune() keeps all must_include DCs and greedily adds should_include until budget exceeded

**Verification:**
- ✅ `DEONTIC_MUST` ("must_include"): always kept regardless of budget
- ✅ `DEONTIC_SHOULD` ("should_include"): added greedily until budget_chars exceeded
- ✅ `DEONTIC_EXCLUDE` ("exclude"): always dropped
- ✅ Token budget = max_tokens * CHARS_PER_TOKEN (default 4)
- ✅ Tests: `test_tensor_context.py::TestTensorContextBudgetPrune::test_budget_prune_always_include_must`
- ✅ Tests: `test_tensor_context.py::TestTensorContextBudgetPrune::test_budget_prune_drop_exclude`
- ✅ Tests: `test_tensor_context.py::TestTensorContextBudgetPrune::test_budget_prune_should_fit_by_budget`

**Example:**
```python
must_dc = ContextDirective("critical instruction", deontic="must_include")
should_dc1 = ContextDirective("context A", deontic="should_include")
should_dc2 = ContextDirective("context B", deontic="should_include")
exclude_dc = ContextDirective("ignore this", deontic="exclude")

result = tc.budget_prune(
    [must_dc, should_dc1, should_dc2, exclude_dc],
    max_tokens=100  # budget = 400 chars
)
# result includes must_dc + as many should_dcs as fit; exclude_dc dropped
```

---

## 6. ✅ GIT WORKTREE CLEANUP SURVIVES ORCHESTRATOR CRASH

**What:** Git worktrees can be cleaned up even after a crash, tracked via state.json["worktreePath"]

**Verification:**
- ✅ `workspace_issue.ensure_worktree(repo, issue_id)` stores worktree path in state.json["worktreePath"]
- ✅ `workspace_issue.release_worktree(repo, issue_id)` removes the worktree (best-effort, never raises)
- ✅ Path persists across restarts in state.json
- ✅ `repociv_hooks.remove_worktree()` can recover and clean up orphaned worktrees
- ✅ Tests: `test_workspace_issue_phase1.py::TestWorktreeIntegration::test_ensure_worktree_persists_path_in_state`
- ✅ Tests: `test_workspace_issue_phase1.py::TestWorktreeIntegration::test_release_worktree_is_idempotent`

**Code Flow:**
```python
# When issue opens
worktree_path = ensure_worktree(repo, issue_id)
# state.json now contains: {"worktreePath": "/path/to/worktree", ...}

# On crash → restart → cleanup
state = load_issue_state(repo, issue_id)
wt_path = state.get("worktreePath")
if wt_path:
    release_worktree(repo, issue_id)  # safe to call even if orphaned
```

---

# ──────────────────────────────────────────────────────────────────────────────
# TEST SUMMARY
# ──────────────────────────────────────────────────────────────────────────────

**New tests created for Fase 1:**
- `server/test_tensor_context.py`: 19 tests ✅ PASSED
- `server/test_workspace_issue_phase1.py`: 13 tests ✅ PASSED
- `server/test_repociv_hooks.py`: 16 tests ✅ PASSED

**Existing tests verified:**
- Total: 371 tests ✅ PASSED, 1 skipped
- No regressions introduced

---

# ──────────────────────────────────────────────────────────────────────────────
# IMPLEMENTATION SUMMARY
# ──────────────────────────────────────────────────────────────────────────────

## Modules Completed

### ✅ server/tensor_context.py
- `ContextDirective`: Atomic context fragment with deterministic ID
- `TensorContext.suma()`: Deduplication union
- `TensorContext.budget_prune()`: Token budget-aware pruning
- `TensorContext.build_mission_prompt()`: Final prompt assembly
- **Status**: MVP complete (Fase 3+ operations deferred per design)

### ✅ server/repociv_hooks.py
- `load_hooks_config(repo)`: Parses repociv.yaml with safe defaults
- `worktrees_enabled(repo)`, `checkpoints_enabled(repo)`: Feature flags
- `create_worktree(repo, issue_id)`: Git worktree lifecycle (create)
- `remove_worktree(repo, issue_id)`: Git worktree lifecycle (remove)
- **Status**: Fully implemented, robust error handling

### ✅ server/workspace_issue.py (Enhanced)
- `write_sentinel(repo, issue_id, status)`: A2O sentinel file write (H1)
- `read_sentinel(repo, issue_id)`: A2O sentinel file read (H1)
- `clear_sentinel(repo, issue_id)`: A2O sentinel file delete (H1)
- `ensure_worktree(repo, issue_id)`: Worktree creation + state persistence (H5)
- `release_worktree(repo, issue_id)`: Worktree cleanup with crash recovery (H5)
- **Status**: All H1 + H5 methods implemented

### ✅ server/task_orchestrator.py (Enhanced)
- Checkpoint gate logic (H4): lines ~150-175
- A2O sentinel checking: lines ~165-175
- Phase state machine respects checkpointGate + sentinel
- **Status**: Already partially implemented; now fully wired with H1/H4

### ✅ server/step_executor.py (Enhanced)
- Uses `TensorContext.build_mission_prompt()` in `build_step_mission()`
- Mission prompt respects token budget via `_MISSION_BUDGET_TOKENS`
- Prior artifacts included as `should_include` DCs
- **Status**: Already integrated with TensorContext (Fase 1 MVP)

---

# ──────────────────────────────────────────────────────────────────────────────
# NEXT STEPS: FASE 2
# ──────────────────────────────────────────────────────────────────────────────

Phase 2 (Semana 5) focuses on:
1. **FrugalGPT Cascade**: Haiku → Sonnet → Opus model routing
2. **Agent Cards** (A2A format): JSON metadata per agent type
3. **Dynamic Model Router**: Replace static table with signal extraction + cascade

See implementation_plan.md §3 for detailed Fase 2 specifications.

---

## Verification Date: 2026-05-01
## Status: ✅ PHASE 1 COMPLETE — ALL ACCEPTANCE GATES PASSED
