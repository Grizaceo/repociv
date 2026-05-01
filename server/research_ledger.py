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

    @property
    def available(self) -> bool:
        """True if DuckDB is installed and the connection is open."""
        return self._conn is not None

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
    # ── Query helpers ─────────────────────────────────────────────────────────

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
