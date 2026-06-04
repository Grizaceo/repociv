"""RepoCiv — Research / Believability Ledger (Fase 0).

DuckDB-backed analytics store for mission outcomes and agent performance.

Design principles:
  - **Derived store only.** This is a materialised view of the JSONL Event Store.
    If DuckDB diverges or is deleted, run ``python -m server.rebuild_ledger`` to
    reconstruct from events.jsonl. Never write here without also writing to the
    Event Store first.
  - **Best-effort dual-write.** ``ingest_event()`` is called by event_store after
    the JSONL append. If DuckDB raises, it logs a warning and does not propagate
    the exception — the JSONL write already succeeded.
  - **Thread-safe.** DuckDB connections are NOT thread-safe; we serialise all
    access through a single ``threading.Lock``.

Tables:
  missions           — one row per completed/failed mission
  agent_predictions  — swarm debate signals (Fase 3); believability scoring
  world_model_predictions — shadow/active context utility predictions (Fase 4)
  world_model_history     — observed DC utility outcomes for calibration
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_STATE_DIR = Path.home() / ".repociv"

try:
    import duckdb  # type: ignore[import-untyped]
    _DUCKDB_AVAILABLE = True
except ImportError:  # pragma: no cover
    _DUCKDB_AVAILABLE = False
    logger.warning(
        "ResearchLedger: duckdb not installed — ledger disabled. "
        "Run `pip install duckdb` to enable analytics."
    )


_DDL_MISSIONS = """
CREATE TABLE IF NOT EXISTS missions (
    id                  TEXT PRIMARY KEY,
    repo                TEXT,
    issue_id            TEXT,
    agent               TEXT,
    model               TEXT,
    step_idx            INTEGER,
    phase               TEXT,
    prompt_tokens       INTEGER DEFAULT 0,
    completion_tokens   INTEGER DEFAULT 0,
    cost_estimate       REAL    DEFAULT 0.0,
    duration_s          REAL,
    outcome             TEXT,
    error_summary       TEXT,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
"""

_DDL_AGENT_PREDICTIONS_SEQ = (
    "CREATE SEQUENCE IF NOT EXISTS agent_predictions_id_seq START 1"
)

_DDL_AGENT_PREDICTIONS = """
CREATE TABLE IF NOT EXISTS agent_predictions (
    id              INTEGER DEFAULT nextval('agent_predictions_id_seq') PRIMARY KEY,
    mission_id      TEXT REFERENCES missions(id),
    agent_name      TEXT,
    predicted_outcome TEXT,
    confidence      REAL,
    actual_outcome  TEXT,
    is_correct      BOOLEAN,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
"""

_DDL_WORLD_MODEL_PREDICTIONS_SEQ = (
    "CREATE SEQUENCE IF NOT EXISTS world_model_predictions_id_seq START 1"
)

_DDL_WORLD_MODEL_PREDICTIONS = """
CREATE TABLE IF NOT EXISTS world_model_predictions (
    id              INTEGER DEFAULT nextval('world_model_predictions_id_seq') PRIMARY KEY,
    mission_id      TEXT,
    dc_id           TEXT,
    mode            TEXT,
    fitness_hat     REAL,
    uncertainty     REAL,
    selected        BOOLEAN,
    predicted_rank  INTEGER,
    actual_utility  REAL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
"""

_DDL_WORLD_MODEL_HISTORY_SEQ = (
    "CREATE SEQUENCE IF NOT EXISTS world_model_history_id_seq START 1"
)

_DDL_WORLD_MODEL_HISTORY = """
CREATE TABLE IF NOT EXISTS world_model_history (
    id              INTEGER DEFAULT nextval('world_model_history_id_seq') PRIMARY KEY,
    mission_id      TEXT,
    dc_id           TEXT,
    actual_utility  REAL,
    tokens          INTEGER,
    selected        BOOLEAN,
    compressed      BOOLEAN,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
"""

_DDL_SUBAGENT_RUNS = """
CREATE TABLE IF NOT EXISTS subagent_runs (
    id                TEXT PRIMARY KEY,
    parent_mission_id TEXT NOT NULL,
    parent_unit_id    TEXT,
    kind              TEXT,
    label             TEXT,
    status            TEXT,
    risk              TEXT,
    target_repo       TEXT,
    target_city_id    TEXT,
    ephemeral_unit_id TEXT,
    outcome           TEXT,
    summary           TEXT,
    duration_s        REAL,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at      TIMESTAMP
)
"""


class ResearchLedger:
    """Analytics ledger for RepoCiv missions and agent believability.

    Usage::

        ledger = ResearchLedger()
        ledger.record_cycle(
            mission_id="abc123",
            repo="myrepo",
            agent="WORKER",
            model="claude-sonnet-4-5",
            outcome="success",
            prompt_tokens=1200,
            completion_tokens=450,
            cost_estimate=0.00185,
            duration_s=12.3,
        )
        scores = ledger.get_agent_believability()
        # → {"WORKER": 0.9, "SCOUT": 1.0}  (1.0 = no history → benefit of doubt)
    """

    def __init__(self, state_dir: Path | str | None = None) -> None:
        self._state_dir = Path(state_dir or os.environ.get(
            "REPOCIV_STATE_DIR", str(_DEFAULT_STATE_DIR)
        ))
        self._db_path = self._state_dir / "ledger.duckdb"
        self._lock = threading.Lock()
        self._conn: Any = None  # duckdb.DuckDBPyConnection | None

        if _DUCKDB_AVAILABLE:
            self._state_dir.mkdir(parents=True, exist_ok=True)
            self._connect()

    # ── Connection & schema ───────────────────────────────────────────────────

    def _connect(self) -> None:
        try:
            self._conn = duckdb.connect(str(self._db_path))
            self._init_schema()
        except Exception as exc:
            logger.error("ResearchLedger: failed to open %s: %s", self._db_path, exc)
            self._conn = None

    def _init_schema(self) -> None:
        assert self._conn is not None
        self._conn.execute(_DDL_MISSIONS)
        self._conn.execute(_DDL_AGENT_PREDICTIONS_SEQ)
        self._conn.execute(_DDL_AGENT_PREDICTIONS)
        self._conn.execute(_DDL_WORLD_MODEL_PREDICTIONS_SEQ)
        self._conn.execute(_DDL_WORLD_MODEL_PREDICTIONS)
        self._conn.execute(_DDL_WORLD_MODEL_HISTORY_SEQ)
        self._conn.execute(_DDL_WORLD_MODEL_HISTORY)
        self._conn.execute(_DDL_SUBAGENT_RUNS)
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_subagent_parent ON subagent_runs(parent_mission_id)"
        )
        try:
            self._conn.execute("ALTER TABLE missions ADD COLUMN IF NOT EXISTS parent_id TEXT")
        except Exception:
            pass

    @property
    def available(self) -> bool:
        """True if DuckDB is installed and the connection is open."""
        return self._conn is not None

    @property
    def state_dir(self) -> Path:
        """Directory backing ledger artifacts and the DuckDB database."""
        return self._state_dir

    # ── Core write API ────────────────────────────────────────────────────────

    def record_cycle(
        self,
        *,
        mission_id: str,
        repo: str = "",
        issue_id: str = "",
        agent: str = "",
        model: str = "",
        step_idx: int = 0,
        phase: str = "",
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        cost_estimate: float = 0.0,
        duration_s: float = 0.0,
        outcome: str = "",
        error_summary: str = "",
    ) -> None:
        """Upsert a mission row in the ``missions`` table.

        Called by ``event_store`` after a CommandCompleted or CommandFailed event
        is appended to the JSONL log. Idempotent: if ``mission_id`` already exists
        the row is replaced.

        Args:
            mission_id:        Unique mission/command identifier.
            repo:              Repository name.
            issue_id:          Associated issue identifier, if any.
            agent:             Agent type (e.g. ``"WORKER"``).
            model:             Model name used.
            step_idx:          Step index within the plan.
            phase:             Phase at completion (see ``server.phases.Phase``).
            prompt_tokens:     Input tokens.
            completion_tokens: Output tokens.
            cost_estimate:     USD cost estimate.
            duration_s:        Wall-clock duration in seconds.
            outcome:           ``"success"`` | ``"failed"`` | ``"rejected"``.
            error_summary:     Short error description (empty on success).
        """
        if not self.available:
            return
        with self._lock:
            try:
                self._conn.execute(
                    """
                    INSERT OR REPLACE INTO missions
                        (id, repo, issue_id, agent, model, step_idx, phase,
                         prompt_tokens, completion_tokens, cost_estimate,
                         duration_s, outcome, error_summary)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        mission_id, repo, issue_id, agent.upper() if agent else "",
                        model, step_idx, phase,
                        max(0, int(prompt_tokens)), max(0, int(completion_tokens)),
                        float(cost_estimate), float(duration_s),
                        outcome, error_summary[:512] if error_summary else "",
                    ),
                )
            except Exception as exc:
                logger.warning("ResearchLedger.record_cycle: %s", exc)

    def ingest_event(self, event: dict[str, Any]) -> None:
        """Ingest a raw event dict from the Event Store.

        Called by ``event_store`` in dual-write mode. Only handles terminal
        events (CommandCompleted, CommandFailed, CommandRejected). Other event
        types are silently ignored.

        This is the **only** code path that should write to DuckDB during normal
        operation. The ``rebuild_ledger`` script also calls this method in batch.
        """
        if not self.available:
            return
        etype = event.get("type", "")
        if etype == "SubagentCompleted":
            data = event.get("data") or {}
            self.record_subagent_run(data)
            return
        if etype not in ("CommandCompleted", "CommandFailed", "CommandRejected"):
            return

        mission_id = event.get("commandId") or event.get("id", "")
        if not mission_id:
            return

        data = event.get("data") or {}
        actor = event.get("actor", "")
        ts = float(event.get("timestamp", 0.0))

        outcome_map = {
            "CommandCompleted": "success",
            "CommandFailed":    "failed",
            "CommandRejected":  "rejected",
        }
        outcome = outcome_map[etype]

        started_at = float(data.get("startedAt", ts))
        finished_at = float(data.get("finishedAt", ts))
        duration_s = max(0.0, finished_at - started_at) if started_at else 0.0

        self.record_cycle(
            mission_id=mission_id,
            agent=actor,
            model=str(data.get("model", "")),
            prompt_tokens=int(data.get("tokensIn") or 0),
            completion_tokens=int(data.get("tokensOut") or 0),
            cost_estimate=float(data.get("costEstimate") or 0.0),
            duration_s=duration_s,
            outcome=outcome,
            error_summary=str(data.get("error", ""))[:512],
        )

    # ── Believability engine ──────────────────────────────────────────────────

    def get_agent_believability(self) -> dict[str, float]:
        """Return accuracy-based believability score per agent type.

        Agents with no prediction history return ``1.0`` (benefit of the doubt).
        Scores are clamped to [0.1, 1.0] so even a consistently wrong agent
        retains a small weight.

        Returns:
            Dict mapping agent name to score in [0.1, 1.0].
        """
        if not self.available:
            return {}
        with self._lock:
            try:
                rows = self._conn.execute(
                    """
                    SELECT agent_name,
                           COUNT(*) AS total,
                           SUM(CASE WHEN is_correct THEN 1 ELSE 0 END) AS correct
                    FROM agent_predictions
                    WHERE is_correct IS NOT NULL
                    GROUP BY agent_name
                    """
                ).fetchall()
            except Exception as exc:
                logger.warning("ResearchLedger.get_agent_believability: %s", exc)
                return {}

        return {
            name: max(0.1, correct / total)
            for name, total, correct in rows
            if total > 0
        }

    def record_prediction(
        self,
        *,
        mission_id: str,
        agent_name: str,
        predicted_outcome: str,
        confidence: float,
        actual_outcome: str | None = None,
        is_correct: bool | None = None,
    ) -> None:
        """Record a swarm agent prediction (used in Fase 3).

        Args:
            mission_id:        Mission this prediction is about.
            agent_name:        Specialist agent making the prediction.
            predicted_outcome: E.g. ``"PROCEED"`` or ``"DISCARD"``.
            confidence:        Confidence in [0.0, 1.0].
            actual_outcome:    Filled in after the mission completes (optional).
            is_correct:        Whether prediction matched actual_outcome.
        """
        if not self.available:
            return
        with self._lock:
            try:
                existing = self._conn.execute(
                    "SELECT COUNT(*) FROM missions WHERE id = ?",
                    (mission_id,),
                ).fetchone()[0]
                if not existing:
                    self._conn.execute(
                        """
                        INSERT INTO missions (id, agent, phase, outcome)
                        VALUES (?, ?, ?, ?)
                        """,
                        (mission_id, "SWARM", "swarm-debate", "prediction"),
                    )
                self._conn.execute(
                    """
                    INSERT INTO agent_predictions
                        (mission_id, agent_name, predicted_outcome, confidence,
                         actual_outcome, is_correct)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (mission_id, agent_name.upper() if agent_name else "",
                     predicted_outcome, float(confidence),
                     actual_outcome, is_correct),
                )
            except Exception as exc:
                logger.warning("ResearchLedger.record_prediction: %s", exc)

    # ── World Model calibration tables ────────────────────────────────────────

    def record_world_model_prediction(
        self,
        *,
        mission_id: str,
        dc_id: str,
        mode: str,
        fitness_hat: float,
        uncertainty: float,
        selected: bool,
        predicted_rank: int | None = None,
        actual_utility: float | None = None,
    ) -> None:
        """Record a World Model prediction for shadow/active calibration."""
        if not self.available:
            return
        with self._lock:
            try:
                self._conn.execute(
                    """
                    INSERT INTO world_model_predictions
                        (mission_id, dc_id, mode, fitness_hat, uncertainty,
                         selected, predicted_rank, actual_utility)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        mission_id, dc_id, mode, float(fitness_hat),
                        float(uncertainty), bool(selected), predicted_rank,
                        actual_utility,
                    ),
                )
            except Exception as exc:
                logger.warning("ResearchLedger.record_world_model_prediction: %s", exc)

    def record_world_model_history(
        self,
        *,
        mission_id: str,
        dc_id: str,
        actual_utility: float,
        tokens: int = 0,
        selected: bool = True,
        compressed: bool = False,
    ) -> None:
        """Record observed DC utility used to calibrate/promo the World Model."""
        if not self.available:
            return
        with self._lock:
            try:
                self._conn.execute(
                    """
                    INSERT INTO world_model_history
                        (mission_id, dc_id, actual_utility, tokens, selected, compressed)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        mission_id, dc_id, float(actual_utility),
                        max(0, int(tokens)), bool(selected), bool(compressed),
                    ),
                )
            except Exception as exc:
                logger.warning("ResearchLedger.record_world_model_history: %s", exc)

    def get_world_model_predictions(self, limit: int = 500) -> list[dict[str, Any]]:
        """Return recent World Model predictions as dictionaries."""
        if not self.available:
            return []
        with self._lock:
            try:
                rows = self._conn.execute(
                    """
                    SELECT mission_id, dc_id, mode, fitness_hat, uncertainty,
                           selected, predicted_rank, actual_utility, created_at
                    FROM world_model_predictions
                    ORDER BY created_at DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
                cols = [
                    "mission_id", "dc_id", "mode", "fitness_hat", "uncertainty",
                    "selected", "predicted_rank", "actual_utility", "created_at",
                ]
                return [dict(zip(cols, row)) for row in rows]
            except Exception as exc:
                logger.warning("ResearchLedger.get_world_model_predictions: %s", exc)
                return []

    def get_world_model_history(self, limit: int = 500) -> list[dict[str, Any]]:
        """Return recent observed World Model utility history."""
        if not self.available:
            return []
        with self._lock:
            try:
                rows = self._conn.execute(
                    """
                    SELECT mission_id, dc_id, actual_utility, tokens, selected,
                           compressed, created_at
                    FROM world_model_history
                    ORDER BY created_at DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
                cols = [
                    "mission_id", "dc_id", "actual_utility", "tokens",
                    "selected", "compressed", "created_at",
                ]
                return [dict(zip(cols, row)) for row in rows]
            except Exception as exc:
                logger.warning("ResearchLedger.get_world_model_history: %s", exc)
                return []

    def get_world_model_calibration_samples(
        self,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Return predictions that have observed utility for calibration."""
        if not self.available:
            return []
        with self._lock:
            try:
                rows = self._conn.execute(
                    """
                    SELECT dc_id, fitness_hat, actual_utility
                    FROM world_model_predictions
                    WHERE actual_utility IS NOT NULL
                    ORDER BY created_at DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
                return [
                    {"dc_id": dc_id, "fitness_hat": fitness_hat, "actual_utility": actual}
                    for dc_id, fitness_hat, actual in rows
                ]
            except Exception as exc:
                logger.warning("ResearchLedger.get_world_model_calibration_samples: %s", exc)
                return []
    # ── Query helpers ─────────────────────────────────────────────────────────

    def record_subagent_run(self, run: dict[str, Any]) -> None:
        """Upsert a subagent_runs row (dual-write from subagent_tracker)."""
        if not self.available:
            return
        sid = str(run.get("id", ""))
        if not sid:
            return
        with self._lock:
            try:
                self._conn.execute(
                    """
                    INSERT INTO subagent_runs (
                        id, parent_mission_id, parent_unit_id, kind, label, status, risk,
                        target_repo, target_city_id, ephemeral_unit_id, outcome, summary,
                        duration_s, completed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (id) DO UPDATE SET
                        status = excluded.status,
                        outcome = excluded.outcome,
                        summary = excluded.summary,
                        duration_s = excluded.duration_s,
                        completed_at = excluded.completed_at
                    """,
                    (
                        sid,
                        str(run.get("parentMissionId") or run.get("parent_mission_id") or ""),
                        str(run.get("parentUnitId") or run.get("parent_unit_id") or ""),
                        str(run.get("kind") or ""),
                        str(run.get("label") or "")[:512],
                        str(run.get("status") or ""),
                        str(run.get("risk") or ""),
                        str(run.get("targetRepo") or run.get("target_repo") or ""),
                        str(run.get("targetCityId") or run.get("target_city_id") or ""),
                        str(run.get("ephemeralUnitId") or run.get("ephemeral_unit_id") or ""),
                        str(run.get("status") if run.get("completedAt") else run.get("outcome") or ""),
                        str(run.get("summary") or "")[:1024],
                        float(run.get("duration") or run.get("duration_s") or 0.0),
                        run.get("completedAt") or run.get("completed_at"),
                    ),
                )
            except Exception as exc:
                logger.warning("ResearchLedger.record_subagent_run: %s", exc)

    def list_subagent_runs(
        self,
        *,
        parent_unit: str = "",
        parent_mission: str = "",
        active_only: bool = False,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        if not self.available:
            return []
        clauses: list[str] = []
        params: list[Any] = []
        if parent_unit:
            clauses.append("parent_unit_id = ?")
            params.append(parent_unit)
        if parent_mission:
            clauses.append("parent_mission_id = ?")
            params.append(parent_mission)
        if active_only:
            clauses.append("status IN ('proposed', 'running')")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(limit)
        with self._lock:
            try:
                rows = self._conn.execute(
                    f"""
                    SELECT id, parent_mission_id, parent_unit_id, kind, label, status, risk,
                           target_repo, target_city_id, ephemeral_unit_id, outcome, summary,
                           duration_s, created_at, completed_at
                    FROM subagent_runs
                    {where}
                    ORDER BY created_at DESC
                    LIMIT ?
                    """,
                    params,
                ).fetchall()
                cols = [
                    "id", "parent_mission_id", "parent_unit_id", "kind", "label", "status",
                    "risk", "target_repo", "target_city_id", "ephemeral_unit_id", "outcome",
                    "summary", "duration_s", "created_at", "completed_at",
                ]
                return [dict(zip(cols, row)) for row in rows]
            except Exception as exc:
                logger.warning("ResearchLedger.list_subagent_runs: %s", exc)
                return []

    def get_mission_tree(self, mission_id: str) -> dict[str, Any]:
        """Return mission + nested subagent runs for mission log UI."""
        subs = self.list_subagent_runs(parent_mission=mission_id, limit=500)
        mission_row: dict[str, Any] = {"id": mission_id}
        if self.available:
            with self._lock:
                try:
                    row = self._conn.execute(
                        "SELECT id, repo, agent, outcome, duration_s, created_at FROM missions WHERE id = ?",
                        (mission_id,),
                    ).fetchone()
                    if row:
                        mission_row = {
                            "id": row[0], "repo": row[1], "agent": row[2],
                            "outcome": row[3], "duration_s": row[4], "created_at": row[5],
                        }
                except Exception:
                    pass
        return {"mission": mission_row, "subagents": subs, "children": subs}

    def get_mission_stats(self, limit: int = 100) -> list[dict[str, Any]]:
        """Return the *limit* most recent missions as dicts."""
        if not self.available:
            return []
        with self._lock:
            try:
                rows = self._conn.execute(
                    """
                    SELECT id, repo, agent, model, phase, outcome,
                           prompt_tokens, completion_tokens, cost_estimate,
                           duration_s, created_at
                    FROM missions
                    ORDER BY created_at DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
                cols = ["id", "repo", "agent", "model", "phase", "outcome",
                        "prompt_tokens", "completion_tokens", "cost_estimate",
                        "duration_s", "created_at"]
                return [dict(zip(cols, row)) for row in rows]
            except Exception as exc:
                logger.warning("ResearchLedger.get_mission_stats: %s", exc)
                return []

    def close(self) -> None:
        """Close the DuckDB connection (call on bridge shutdown)."""
        if self._conn is not None:
            with self._lock:
                try:
                    self._conn.close()
                except Exception:
                    pass
                self._conn = None


# ── Module-level singleton ────────────────────────────────────────────────────

_singleton: ResearchLedger | None = None
_singleton_lock = threading.Lock()


def get_ledger() -> ResearchLedger:
    """Return the module-level singleton ResearchLedger."""
    global _singleton
    if _singleton is None:
        with _singleton_lock:
            if _singleton is None:
                _singleton = ResearchLedger()
    return _singleton


def get_instance() -> ResearchLedger:
    """Compatibility alias for Fase 2 router/scheduler integrations."""
    return get_ledger()
