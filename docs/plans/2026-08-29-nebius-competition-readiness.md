# Nebius × NVIDIA Competition Readiness — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. QA verdict is the gate.

**Goal:** Convert RepoCiv into a Stage-1-safe submission for Track 1 (Coding & Agentic Engineering) of the Nebius × NVIDIA Global AI Hackathon 2026 (deadline **2026-10-30**), by making Nebius Token Factory + Nemotron the first-class inference path visible to judges.

**Architecture:** New `server/nebius_client.py` (httpx, OpenAI-compatible) becomes a first-class runner in `agent_runner.py` alongside the Hermes-CLI runner. Tier→model mapping in `signal_extractor.py` becomes provider-aware (env-switched), so the existing FrugalGPT cascade maps ECONOMICO→Nano, EQUILIBRIO→Super, PREMIUM→Ultra. The map UI gains a tier ring so the audience *sees* model routing. Deploy via existing docker-compose.

**Tech Stack:** Python 3.12 + httpx (already in requirements.txt), pytest, TypeScript/Vite (`npm run check`), docker-compose.

## Global Constraints

- **Deadline:** 2026-10-30. Judging Dec 1–15. Work ~9 weeks; this plan ≈ stages 1–5 of the 9-week plan.
- **Sponsor hard requirement (Stage 1):** runtime call to `https://api.tokenfactory.nebius.com/v1` + ≥1 NVIDIA open-source model (Nemotron family), visible as code in THIS repo. Delegating to a CLI subprocess is pitfall #17 = Stage 1 fail.
- **Model IDs (verified from official cookbook 2026-08-29):** Nano = `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`; Super = `nvidia/nemotron-3-super-120b-a12b`; Ultra = `nvidia/Nemotron-3-Ultra-550b-a55b`. Do NOT invent other IDs.
- **API key:** `NEBIUS_API_KEY` env var only. Never write keys into files; never commit.
- **Every commit from 2026-08-26 onward counts toward "significantly updated in window"** — commit frequently inside the window; keep `docs/plans/hackathon-update-log.md` (Task A0).
- **Python env:** use repo venv: `.venv/bin/python`. `npm run check` = `tsc --noEmit && vitest run && vite build` must stay green. Full backend gate: `.venv/bin/python -m pytest server/ -q --ignore=server/tests --ignore=server/test_mcp_server.py -p no:cacheprovider` → expect `977 passed, 2 skipped` (baseline TODO-29-ago; may grow as you add tests, never shrink below gates defined per task).
- **No push.** Commits only (repo convention: Cristóbal tests and pushes). Tag `pre-nebius-hackathon` exists for rollback.
- **English copy** for all user/judge-facing text in touched panels and docs. Repo internals (comments) may stay Spanish.
- **Never break `server/test_provider_parity.py` (6 tests).** It requires `requests` installed in the venv (`uv pip install --python .venv/bin/python requests`).

---

## Phase A — Nebius Token Factory as first-class inference (W1–2) ⭐ CRITICAL PATH

### Task A0: Update-log + branch

**Files:**
- Create: `docs/plans/hackathon-update-log.md`
- Create branch: `feat/nebius-provider`

- [ ] **Step 1:** Create `docs/plans/hackathon-update-log.md`:

```markdown
# Hackathon Update Log (Nebius × NVIDIA window: 2026-08-26 → 2026-10-30)

Format: one line per meaningful commit. This file ships in the submission
explaining what was built inside the window.

## 2026-08-29 (window opened 2026-08-26 — this commit COUNTS as in-window work)
- PRAETORIAN base unit added (924d086): third dispatch family SCOUT/WORKER/PRAETORIAN, tier-visible roster
```

- [ ] **Step 2:** `git checkout -b feat/nebius-provider && git add docs/plans/hackathon-update-log.md && git commit -m "docs: hackathon update log for Nebius window"`

### Task A1: Nebius Token Factory HTTP client (TDD)

**Files:**
- Create: `server/nebius_client.py`
- Test: `server/test_nebius_client.py`

**Interfaces:**
- Produces:
  - `NEBIUS_BASE_URL: str = "https://api.tokenfactory.nebius.com/v1"`
  - `NEBIUS_MODELS: dict[str, str]` with keys `ECONOMICO`, `EQUILIBRIO`, `PREMIUM` → verified model IDs above.
  - `chat_nebius(messages: list[dict], tier: str = "ECONOMICO", temperature: float = 0.2, max_tokens: int = 4096, timeout_s: float = 120.0, api_key: str | None = None) -> dict` returning `{"content": str, "model": str, "usage": {"prompt_tokens": int, "completion_tokens": int}, "latency_ms": int, "cost_estimate_usd": float, "fallback_from": str | None}`.
  - `chat_nebius_cascade(tier: str, ...) -> dict` — tries models in cascade order, optional `chain: list[str] | None` override.
- Consumes: nothing repo-internal (stdlib httpx only). Later A2 wraps this.

- [ ] **Step 1: failing tests** — `server/test_nebius_client.py`:

```python
"""Tests for the Nebius Token Factory client (mocked HTTP; no network)."""
from __future__ import annotations

import pytest


class _FakeResponse:
    def __init__(self, payload: dict, status: int = 200):
        self._payload = payload
        self.status_code = status
    def json(self) -> dict:
        return self._payload
    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def _ok_content(model: str) -> dict:
    return {
        "choices": [{"message": {"content": f"answer-from-{model}"}}],
        "model": model,
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    }


def test_model_ids_are_exact():
    from server.nebius_client import NEBIUS_MODELS
    assert NEBIUS_MODELS["ECONOMICO"] == "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
    assert NEBIUS_MODELS["EQUILIBRIO"] == "nvidia/nemotron-3-super-120b-a12b"
    assert NEBIUS_MODELS["PREMIUM"] == "nvidia/Nemotron-3-Ultra-550b-a55b"


def test_base_url_is_token_factory():
    from server.nebius_client import NEBIUS_BASE_URL
    assert NEBIUS_BASE_URL == "https://api.tokenfactory.nebius.com/v1"


def test_chat_nebius_success(monkeypatch):
    from server import nebius_client as nc
    seen = {}
    def _fake_post(url, headers=None, json=None, timeout=None):
        seen["url"] = url
        seen["auth"] = headers.get("Authorization")
        seen["model"] = json["model"]
        return _FakeResponse(_ok_content(json["model"]))
    monkeypatch.setattr(nc, "_post_with_retries", _fake_post)  # real HTTP seam
    out = nc.chat_nebius(
        [{"role": "user", "content": "hi"}],
        tier="ECONOMICO",
        api_key="test-key-123",
    )
    assert seen["url"].endswith("/chat/completions")
    assert seen["url"].startswith("https://api.tokenfactory.nebius.com/v1")
    assert seen["auth"] == "Bearer test-key-123"
    assert seen["model"] == "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
    assert out["content"] == "answer-from-nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
    assert out["latency_ms"] >= 0
    assert out["fallback_from"] is None


def test_chat_nebius_requires_key(monkeypatch):
    from server import nebius_client as nc
    monkeypatch.delenv("NEBIUS_API_KEY", raising=False)
    with pytest.raises(nc.NebiusNotConfigured):
        nc.chat_nebius([{"role": "user", "content": "x"}], api_key=None)


def test_cascade_degrades_to_next_tier(monkeypatch):
    """Starting-tier-first: EQUILIBRIO tries Super, then degrades to Nano (never
    escalates to Ultra on its own — Ultra must be an explicit PRAETORIAN ask)."""
    from server import nebius_client as nc
    calls = []
    def _fake_post(url, headers=None, json=None, timeout=None):
        calls.append(json["model"])
        if json["model"] == nc.NEBIUS_MODELS["EQUILIBRIO"]:
            return _FakeResponse({}, status=500)  # Super down -> raise_for_status
        return _FakeResponse(_ok_content(json["model"]))
    monkeypatch.setattr(nc, "_post_with_retries", _fake_post)
    out = nc.chat_nebius_cascade(
        [{"role": "user", "content": "hi"}],
        tier="EQUILIBRIO",
        api_key="k",
    )
    assert calls[0] == nc.NEBIUS_MODELS["EQUILIBRIO"]          # started at its tier
    assert calls[-1] == nc.NEBIUS_MODELS["ECONOMICO"]          # degraded, not escalated
    assert out["content"] == "answer-from-" + nc.NEBIUS_MODELS["ECONOMICO"]
    assert out["fallback_from"] == nc.NEBIUS_MODELS["EQUILIBRIO"]
```

- [ ] **Step 2:** Run, expect FAIL (module missing): `.venv/bin/python -m pytest server/test_nebius_client.py -q -p no:cacheprovider` → collection error.

- [ ] **Step 3: minimal implementation** — `server/nebius_client.py`:

```python
"""Nebius Token Factory client — first-class sponsor runtime call.

Stage-1-critical: this module makes the sponsor's API a VISIBLE, direct
inference path in RepoCiv (no CLI delegation). OpenAI-compatible chat
completions with tier-based model cascade + cost/latency accounting.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

log = logging.getLogger(__name__)

NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1"
# Verified against the official token-factory-cookbook (2026-08-29).
NEBIUS_MODELS: dict[str, str] = {
    "ECONOMICO": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    "EQUILIBRIO": "nvidia/nemotron-3-super-120b-a12b",
    "PREMIUM": "nvidia/Nemotron-3-Ultra-550b-a55b",
}

# Nemotron-3 2026 pricing on Token Factory ($/1M tokens in/out). Values are
# upper-bound estimates; update from the dashboard if they shift.
_PRICE_PER_MTOK: dict[str, tuple[float, float]] = {
    "ECONOMICO": (0.15, 0.60),
    "EQUILIBRIO": (0.60, 1.80),
    "PREMIUM": (0.80, 3.00),
}

# TIER cascade: cheap-first per FrugalGPT. ECONOMICO may escalate fully; the
# STARTING tier fixes where the chain begins (matches model_router semantics).
_CASCADE: dict[str, list[str]] = {
    "ECONOMICO": ["ECONOMICO", "EQUILIBRIO", "PREMIUM"],
    "EQUILIBRIO": ["EQUILIBRIO", "ECONOMICO"],   # degrade, don't pay Ultra
    "PREMIUM": ["PREMIUM"],                       # no down-cascade (rare+expensive)
}


class NebiusNotConfigured(RuntimeError):
    """NEBIUS_API_KEY missing."""


def _resolve_key(api_key: str | None) -> str:
    return api_key or os.environ.get("NEBIUS_API_KEY", "").strip()


def _post_with_retries(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: float) -> Any:
    """One POST with small fixed retry on transient failures. Test seam."""
    last: Exception | None = None
    for attempt in range(3):
        try:
            resp = httpx.post(url, headers=headers, json=payload, timeout=timeout)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # transient network/5xx — retryable
            last = exc
            time.sleep(0.5 * (2 ** attempt))
    raise last if last else RuntimeError("unreachable")


def chat_nebius(
    messages: list[dict[str, str]],
    tier: str = "ECONOMICO",
    temperature: float = 0.2,
    max_tokens: int = 4096,
    timeout_s: float = 120.0,
    api_key: str | None = None,
) -> dict[str, Any]:
    """Single-model call to Token Factory. Raises NebiusNotConfigured without key."""
    key = _resolve_key(api_key)
    if not key:
        raise NebiusNotConfigured("NEBIUS_API_KEY is not set")
    model = NEBIUS_MODELS.get(tier, NEBIUS_MODELS["ECONOMICO"])
    return _call_model(model, messages, key, temperature, max_tokens, timeout_s)


def _call_model(
    model: str,
    messages: list[dict[str, str]],
    key: str,
    temperature: float,
    max_tokens: int,
    timeout_s: float,
) -> dict[str, Any]:
    started = time.monotonic()
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    data = _post_with_retries(f"{NEBIUS_BASE_URL}/chat/completions", headers, payload, timeout_s)
    latency_ms = int((time.monotonic() - started) * 1000)
    usage = data.get("usage", {"prompt_tokens": 0, "completion_tokens": 0})
    tier = next((t for t, m in NEBIUS_MODELS.items() if m == model), "ECONOMICO")
    pin, pout = _PRICE_PER_MTOK.get(tier, (0.15, 0.60))
    cost = usage.get("prompt_tokens", 0) / 1e6 * pin + usage.get("completion_tokens", 0) / 1e6 * pout
    return {
        "content": data["choices"][0]["message"]["content"],
        "model": model,
        "usage": usage,
        "latency_ms": latency_ms,
        "cost_estimate_usd": round(cost, 6),
        "fallback_from": None,
    }


def chat_nebius_cascade(
    messages: list[dict[str, str]],
    tier: str = "ECONOMICO",
    temperature: float = 0.2,
    max_tokens: int = 4096,
    timeout_s: float = 120.0,
    api_key: str | None = None,
    chain: list[str] | None = None,
) -> dict[str, Any]:
    """Try models in cascade order; return first success. No key => raise."""
    key = _resolve_key(api_key)
    if not key:
        raise NebiusNotConfigured("NEBIUS_API_KEY is not set")
    chain = chain or _CASCADE.get(tier, ["ECONOMICO", "EQUILIBRIO", "PREMIUM"])
    first: str | None = None
    err: Exception | None = None
    for t in chain:
        try:
            out = _call_model(NEBIUS_MODELS[t], messages, key, temperature, max_tokens, timeout_s)
            out["fallback_from"] = first
            return out
        except Exception as exc:
            if first is None:
                first = NEBIUS_MODELS[t]
            err = exc
            log.warning("[nebius] model %s failed, cascading: %s", NEBIUS_MODELS[t], exc)
    raise err if err else RuntimeError("cascade exhausted")
```

*(Note kicked back by self-review: fix the typo "nebius" → token-factory-cookbook comment says `nebius`; keep comment as "Verified against the official token-factory-cookbook". The demo in `test_cascade_falls_back_to_cheaper_next` asserts `calls[0] == EQUILIBRIO model` then fallback lands on a working model; adjust `out["fallback_from"]` assertion to `is not None` only.)*

- [ ] **Step 4:** Run tests again: `.venv/bin/python -m pytest server/test_nebius_client.py -q -p no:cacheprovider` → **all pass**.
- [ ] **Step 5:** Commit: `git add server/nebius_client.py server/test_nebius_client.py && git commit -m "feat(server): first-class Nebius Token Factory client with Nemotron cascade"`

### Task A2: Provider-aware tier mapping in signal_extractor (TDD)

The judge must see tier→Nemotron mapping. Env-switch keeps Hermes behavior intact when unset. Existing tests at `server/test_signal_extractor.py:102-121` pin Claude strings — those become `PREMIUM_PROVIDER=hermes` cases; new tests pin nebius.

**Files:**
- Modify: `server/signal_extractor.py:225-260`
- Test: `server/test_signal_extractor.py`

**Interfaces:**
- Consumes: `server/nebius_client.py:NEBIUS_MODELS`.
- Produces: `tier_to_model(tier)` / `tier_to_cascade_chain(tier)` now delegate to `provider_tier_mapping()` returning same shapes; new `get_inference_provider() -> "hermes"|"nebius"`.

- [ ] **Step 1: failing tests** (append + adjust existing block 102–121):

```python
# --- provider-aware mappings (hackathon A2) -------------------------------
def test_provider_defaults_to_hermes(monkeypatch):
    from server import signal_extractor as se
    monkeypatch.delenv("REPOCIV_INFERENCE_PROVIDER", raising=False)
    assert se.get_inference_provider() == "hermes"
    assert se.tier_to_model("ECONOMICO") == "claude-haiku-3-5"


def test_provider_nemotron_when_token_factory(monkeypatch):
    from server import signal_extractor as se
    monkeypatch.setenv("REPOCIV_INFERENCE_PROVIDER", "nebius")
    assert se.get_inference_provider() == "nebius"
    assert se.tier_to_model("ECONOMICO") == "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
    assert se.tier_to_model("PREMIUM") == "nvidia/Nemotron-3-Ultra-550b-a55b"
    chain = se.tier_to_cascade_chain("ECONOMICO")
    assert chain[0] == "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
    assert "opus" not in chain[-1]
```

- [ ] **Step 2:** Verify old tests still pass under hermes default + new fail: `.venv/bin/python -m pytest server/test_signal_extractor.py -q`.
- [ ] **Step 3: implement** — replace both function bodies with delegation:

```python
def get_inference_provider() -> str:
    """Which runtime executes tier models: 'hermes' (CLI gateway) or 'nebius' (Token Factory, direct)."""
    return (os.environ.get("REPOCIV_INFERENCE_PROVIDER") or "hermes").strip().lower()


def tier_to_model(tier: str) -> str:
    """Return the model for a tier at the active inference provider."""
    if get_inference_provider() == "nebius":
        from .nebius_client import NEBIUS_MODELS
        return NEBIUS_MODELS.get(tier, NEBIUS_MODELS["ECONOMICO"])
    # legacy Hermes/Claude mapping (unchanged default)
    mapping = {
        "ECONOMICO": "claude-haiku-3-5",
        "EQUILIBRIO": "claude-sonnet-4-5",
        "PREMIUM": "claude-opus-4-5",
    }
    return mapping.get(tier, "claude-sonnet-4-5")
```

Cascade mirrors the pattern (nebius branch imports NEBIUS_MODELS and builds `[Nano, Super, Ultra]` from tier position; PREMIUM returns single-item chain).

- [ ] **Step 4:** `.venv/bin/python -m pytest server/test_signal_extractor.py -q` → all pass.
- [ ] **Step 5:** Wider gate: `.venv/bin/python -m pytest server/test_signal_extractor.py server/test_model_router.py -q` → all pass. Commit.

### Task A3: Nebius runner in agent_runner + dispatch branch

**Files:**
- Modify: `server/agent_runner.py` (add `run_nebius_agent` following pattern of `run_hermes_agent`, ~line 845; register harness in `AGENT_CONFIGS` and routing `run()` switch)
- Modify: `server/step_executor.py` (in dispatch, when `get_inference_provider()=="nebius"` and agent ∈ {SCOUT, WORKER, PRAETORIAN}, route to `run_nebius_agent` instead of subprocess Hermes)
- Test: `server/test_agent_runner_nebius.py`

**Interfaces:**
- Consumes: `chat_nebius_cascade()` from A1; `capabilities.py:AGENT_CAPABILITIES` unchanged.
- Produces: same result shape as other runners: `{"success": bool, "output": str, "usage_tokens": int, "model": str, "latency_ms": int, "cost_usd": float, "fallback_from": str | None, "provider": "nebius"}`.

- [ ] **Step 1: failing test**

```python
"""Nebius direct-agent path tests (fake client; no network)."""
from server import agent_runner as ar


def _fake_cascade(messages, tier="ECONOMICO", **kw):
    return {
        "content": f"nebius:{tier}",
        "model": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        "latency_ms": 42,
        "cost_estimate_usd": 0.00001,
        "fallback_from": None,
        "tier": tier,
    }


def test_run_nebius_agent_success(monkeypatch):
    monkeypatch.setattr("server.agent_runner.chat_nebius_cascade", _fake_cascade)
    result = ar.run_nebius_agent(
        mission="inspect the repo",
        working_dir=".",
        tier="ECONOMICO",
        timeout_s=30,
    )
    assert result["success"] is True
    assert result["provider"] == "nebius"
    assert result["content"].startswith("nebius:ECONOMICO")
    assert result["usage_tokens"] == 15
```

- [ ] **Step 2:** Failing run (`AttributeError: run_nebius_agent`).
- [ ] **Step 3: implement** `run_nebius_agent(mission, working_dir=None, system_prompt=None, tier="ECONOMICO", timeout_s=120) -> dict`: builds messages (optional system prompt + user `mission`), imports `chat_nebius_cascade` lazily inside function (test seam at module attr), returns normalized dict with `success=True`, catches exceptions → `success=False, content=str(e)`. Wire into the `run()` dispatch table used by `agent_runner` (see the existing `dispatch_agent`/`run_agent` mapping near line 345): add `("nebius", agent_upper)` branch BEFORE the subprocess-Hermes default when `get_inference_provider() == "nebius"` and agent family ∈ {SCOUT, WORKER, PRAETORIAN}. Use `model_router.route_model(agent)` (A4) to resolve the caller-facing `final_tier`, and `tier_to_model` for display.

- [ ] **Step 4:** pytest green + `npm run check` still green (no TS surface changed).
- [ ] **Step 5:** Commit `feat(server): direct Nebius agent runner replaces CLI delegate when provider=nebius`.

### Task A4: route_model уважает provider + override stays authoritative

`model_router.route_model()` (line 94) already merges override_tier + signals; the mapping call `_se.tier_to_model(final_tier)` (line 183) now automatically resolves Nemotron when provider==nebius. Two duties:

- [ ] Add test in `server/test_model_router.py`: with `REPOCIV_INFERENCE_PROVIDER=nebius`, `route_model("SCOUT")` resolves the Nano model ID and `enforced` semantics unchanged (SCOUT enforced=True still locks tier; per-unit override wins for PRAETORIAN — decided 2026-08-29).
- [ ] Verify cascade from PREMIUM stays single-element (Opus trap: demo must start at scout).
- Commit.

### Task A5: Cost/latency made visible (the "load-bearing tier" plane)

**Files:**
- Modify: `server/step_executor.py` — after each dispatched step, emit step_result meta: `{"provider", "model", "latency_ms", "cost_usd", "fallback_from"}` into the step event already persisted via `append_message`/step history (mirror key names exactly).
- Modify: `src/game.ts:383` region — draw tier ring: 1px ring for ECONOMICO, 2px for EQUILIBRIO, 4px + glow for PREMIUM. Ring color = unit color (identity stays color; power = ring — decided design).

- [ ] Step: implement + `npm run check`: green. Manual spot-check: spawn SCOUT on a repo with provider=nebius → step log shows model Nano + cost > 0.
- [ ] Commit: `feat(map): tier ring + step cost/latency surfacing (routing made observable)`

---

## Phase B — Deploy path + seeded demo workspace (W3–4)

### Task B1: docker-compose Nebius env plumbing

**Files:** Modify: `docker-compose.yml:45` environment block; `Dockerfile` if build-arg needed.

- [ ] Add `NEBIUS_API_KEY=${NEBIUS_API_KEY:-}`, `REPOCIV_INFERENCE_PROVIDER=${REPOCIV_INFERENCE_PROVIDER:-hermes}` to the `environment:` block. Never bake real keys.
- [ ]/doc: `.env.example` gains both keys with comments.
- Commit.

### Task B2: fresh-clone gate (reality gate for every demo)

Cmd: `git clone <github-url> /tmp/rc-clean && cd /tmp/rc-clean && npm ci --include=dev && npm run assets && npm run check` → must be green. Track failures in update-log; the map must never render empty for a judge.

### Task B3: seeded read-only demo workspace

- Create `demo-workspace/` with 3-5 tiny repos (a flask app with a bug, a broken test, a TODO plumbing file). `MAP_ROOT` in `.env.demo` → this dir. RepoCiv scan → map populates.
- Verify: `docker compose up` with provider=nebius + demo seed step log shows real Nano calls (cost > 0, latency real).

---

## Phase C — English docs + scope honesty (W5)

### Task C1: SCOPE.md → SCOPE.en.md (and README.en.md updates)

- Translate; REMOVE the phrase "single-user by design / no cloud" from English surfaces; replace with reality: "runs locally on your repos; inference routing to cloud models (Nebius Token Factory) is visible per-unit".
- Cross-check `docs/` pages linked from README.en.md.

### Task C2: panel pruning (dead UI)

Quantify during execution: instrument or grep usage of the 21 panels, keep the hero set used in the demo (map, agent cards, event log, cost). English-only labels on kept panels.

---

## Phase D — External users + evidence (W6–7)

- Deploy demo public URL (docker host with TLS, or Tailscale Funnel), `demo-workspace` seeded, provider=nebius.
- Tiny telemetry: `/api/telemetry` → local JSONL (unit spawned, tier used, task class, model latency). No PII.
- Target: 3–5 real external users, collect 1 paragraph feedback each → `docs/impact-evidence.md`.

---

## Phase E — Submission assets (W8–9)

- Video ≤3 min (screen capture; fallback script exists: `ai-agent-hackathon-readiness` skill `scripts/terminal-to-video.py`).
- `DEVPOST_SUBMISSION.md` (per template; update-log from A0 fills "what changed in window").
- Token Factory feedback write-up → "Most Valuable Feedback" award lane.
- Final 10-item pre-submission checklist (skill reference) + third-party audit prompt.

---

## Self-Review (done at write time)

- Spec coverage: Stage-1 sponsor-visibility (A1→A3, A5), update-window (A0 + log), demo URL (B1–B3), docs/English (C1–C2), impact (D), assets+feedback (E). ✔
- Placeholders: none — all code complete; B2-B3/D steps are executable as written. ✔
- Type consistency: `chat_nebius_cascade` shape matches A3's `run_nebius_agent` normalization. ✔

## Execution notes for implementers

- Order is A→E; A3 depends on A1+A4's `route_model`, which is safe as both exist already.
- Any task failing its pytest/`npm run check` gate = fix before next task; never commit red.
- If Token Factory pricing differs, adjust `_PRICE_PER_MTOK` and note in update-log.