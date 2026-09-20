"""Answering an external agent session: one headless turn over its own thread.

What this actually does is worth being blunt about, because it is not what
"enviar un mensaje" sounds like. The session is closed — nothing is listening.
So a reply *spawns a new process* that resumes the session, runs one turn with
the user's text and exits. It is not talking to the agent that was there; it is
reviving its context for a turn.

Which is why the two rules below are the whole safety story:

  * a session with a live process is refused outright (``server/session_liveness``
    → ``session_resume.plan`` says ``attached``). Two processes over one thread
    is what Hermes' lease registry exists to prevent.
  * the turn runs with **the same permissions RepoCiv already gives its own
    missions** (``server/agent_runner.py``): the bypass flags per CLI. This is a
    deliberate inheritance, not a fresh choice — the gate that an operator can
    actually turn is ``server/policy.py`` plus the ``policies.d`` YAML overlay,
    which sees these turns as the ``external_reply`` command type.

``build()`` decides the argv and the environment without running anything, so
the interesting part is testable; ``start()`` spawns it on a worker thread and
keeps a small status record. The agent's answer is not streamed back: it lands
in the session's own transcript, which the panel is already polling.
"""

from __future__ import annotations

import os
import subprocess
import threading
import time
from typing import Any

from server import session_resume
from server._env_filter import redact_env_for_spawn

# Mirrors of what server/agent_runner.py passes for RepoCiv's own missions.
# Kept next to each other so a change there is an obvious change here.
_CLAUDE_FLAGS = ["--print", "--dangerously-skip-permissions"]
_CODEX_FLAGS = ["--dangerously-bypass-approvals-and-sandbox"]
_HERMES_FLAGS = ["-Q", "--source", "tool"]


_TIMEOUT_S = 600.0
_ERROR_TAIL = 400  # of a failing CLI's output, for the message shown to the user

_RUNS: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()


class ReplyRefused(Exception):
    """The turn must not run. ``str(err)`` is a short code for the API."""


def build(
    *,
    agent: str,
    native_id: str,
    cwd: str,
    text: str,
    profile: str = "",
    live: bool | None = None,
    hermes_home: str = "~/.hermes",
    ended: bool = False,
    model: str = "",
) -> dict[str, Any]:
    """argv + cwd + env for one turn, or raise ReplyRefused.

    Returns ``{"argv", "cwd", "env", "family"}``; ``env`` holds only the
    variables this turn adds on top of the spawning environment.
    """
    message = (text or "").strip()
    if not message:
        raise ReplyRefused("empty_message")

    plan = session_resume.plan(
        agent=agent, native_id=native_id, cwd=cwd, profile=profile,
        live=live, hermes_home=hermes_home, ended=ended,
    )
    if plan["mode"] == "attached":
        raise ReplyRefused("session_is_live")
    if plan["mode"] != "resume":
        raise ReplyRefused("no_resume_path")

    family = session_resume.agent_family(agent)
    if family == "claude":
        argv = ["claude", *_CLAUDE_FLAGS]
        if model:
            argv += ["--model", model]
        argv += ["--resume", native_id, message]
        return {"argv": argv, "cwd": cwd, "env": {}, "family": family}

    if family == "codex":
        argv = ["codex", "exec", "resume", *_CODEX_FLAGS]
        if model:
            argv += ["-m", model]
        argv += [native_id, message]
        return {"argv": argv, "cwd": cwd, "env": {}, "family": family}

    # Hermes restores the session's own working directory, so the spawn does not
    # set one; HERMES_HOME is what points the CLI at the right profile.
    argv = ["hermes", "chat", "-q", message, *_HERMES_FLAGS, "--resume", native_id]
    if model:
        argv += ["-m", model]
    home = session_resume.hermes_profile_home(hermes_home, profile)
    return {"argv": argv, "cwd": "", "env": {"HERMES_HOME": os.path.expanduser(home)}, "family": family}


# ─── Running it ──────────────────────────────────────────────────────────────
def _binary(family: str) -> str | None:
    """The CLI RepoCiv already resolves for its own missions."""
    from server import agent_runner  # noqa: PLC0415 — lazy: agent_runner is heavy

    finder = {
        "claude": agent_runner._find_claude_code,
        "codex": agent_runner._find_codex,
        "hermes": agent_runner._find_hermes_cli,
    }.get(family)
    return finder() if finder else None


def status(session_id: str) -> dict[str, Any] | None:
    """The last turn RepoCiv ran over this session, if any."""
    with _LOCK:
        run = _RUNS.get(session_id)
        return dict(run) if run else None


def _finish(session_id: str, **fields: Any) -> None:
    with _LOCK:
        run = _RUNS.get(session_id)
        if run is not None:
            run.update(finishedAt=time.time(), **fields)


def _run(session_id: str, spec: dict[str, Any]) -> None:
    """One turn, start to finish. Never raises: the record carries the outcome."""
    try:
        proc = subprocess.run(
            spec["argv"],
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_S,
            stdin=subprocess.DEVNULL,
            cwd=spec["cwd"] or None,
            env=redact_env_for_spawn(
                {**os.environ, **spec["env"]}, extra_keep=set(spec["env"])
            ),
            check=False,
        )
    except subprocess.TimeoutExpired:
        _finish(session_id, state="failed", error="timeout")
        return
    except OSError as exc:
        _finish(session_id, state="failed", error=f"spawn_failed: {exc}")
        return
    if proc.returncode != 0:
        tail = ((proc.stderr or "") + (proc.stdout or "")).strip()[-_ERROR_TAIL:]
        _finish(session_id, state="failed", error=tail or f"exit_{proc.returncode}")
        return
    _finish(session_id, state="done", error="")


def start(session_id: str, spec: dict[str, Any]) -> dict[str, Any]:
    """Spawn the turn on a worker thread. Raises ReplyRefused if one is running
    or the CLI is missing."""
    binary = _binary(spec["family"])
    if not binary:
        raise ReplyRefused(f"{spec['family']}_not_found")
    with _LOCK:
        current = _RUNS.get(session_id)
        if current and current.get("state") == "running":
            raise ReplyRefused("already_running")
        record = {"state": "running", "startedAt": time.time(), "finishedAt": None, "error": ""}
        _RUNS[session_id] = record
        run_spec = {**spec, "argv": [binary, *spec["argv"][1:]]}
    threading.Thread(
        target=_run, args=(session_id, run_spec), name=f"external-reply-{session_id[:16]}", daemon=True
    ).start()
    return dict(record)
