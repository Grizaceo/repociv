"""RepoCiv — pending Git work inventory (read-only, on demand).

``GET /api/pending-work`` answers one question honestly: *which checked-out
worktrees of the selected repositories still hold uncommitted work, and for how
long has the bridge been observing it?*

Contract (docs/PENDING_WORK.md):

* No filesystem path is ever taken from the request. The bridge resolves the
  active map root's selection through ``repo_roots_state``. An empty active
  selection is empty, never an invitation to scan another map root.
* Read-only only. Every Git call runs with ``--no-optional-locks`` and
  ``GIT_OPTIONAL_LOCKS=0`` so sampling never rewrites ``.git/index``, and the
  environment is scrubbed of ``GIT_DIR``/``GIT_WORK_TREE``/… so a bridge that
  happens to run inside a hook cannot be redirected at another repository.
  Nothing here commits, stages, discards, fetches, switches branches or runs
  hooks.
* A Git failure is *never* reported as ``clean``. It becomes ``unavailable``
  with a visible error, and any observation already recorded is retained — an
  unreadable worktree is not evidence of finished work.
* A dirty episode is keyed by ``realpath(worktree) + branch + HEAD``. Keeping
  HEAD in the key means a commit (or a checkout) starts a new episode instead of
  pretending the remaining dirt is as old as the previous one. Episodes live in a
  separate XDG state file, are written atomically and serialized behind a lock,
  and a corrupt or unwritable file is surfaced as ``persistenceError`` instead of
  being silently dropped.
* Related sessions are context, never authorship. They come from the existing
  bridge registries (external agents, own sessions, live Claude sessions) and
  match only on exact realpath containment inside the worktree.
* No diff content, prompts, credentials, process arguments or environment is
  returned. Paths, status pairs, counts and timestamps only.

Timestamps are integer milliseconds (``time.time() * 1000``), matching the rest
of the bridge.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

__all__ = [
    "collect",
    "state_file",
    "reset_cache",
]

# ── tunables ─────────────────────────────────────────────────────────────────
_STATE_VERSION = 1
_GIT_BIN = "git"
_GIT_TIMEOUT_S = 5.0          # per subprocess call
_SCAN_BUDGET_S = 6.0         # whole inventory, so one hung repo cannot wedge the panel
_CACHE_TTL_MS = 3000          # cached polls: the panel refreshes, git does not
_MAX_FILES_PER_ENTRY = 200    # files[] is capped; the counts stay complete
_MAX_WORKTREES = 400          # worktrees[] is capped; the excess is reported
_MAX_EPISODES = 500           # persisted episodes, bounded
_PRUNE_AFTER_MS = 30 * 24 * 3600 * 1000

# Environment variables that would silently redirect git at another repository
# when the bridge itself runs from inside a hook or a git command.
_STRIP_ENV = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
)

_UNMERGED = {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}
_STAGED_INDEX = set("MADRCT")
_UNSTAGED_WORKTREE = set("MDT")


# ── state file ───────────────────────────────────────────────────────────────
def state_file() -> Path:
    """Persistence file for observed dirty episodes (separate from map state)."""
    explicit = os.environ.get("REPOCIV_PENDING_WORK_STATE_FILE", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    xdg = os.environ.get("XDG_STATE_HOME", "").strip()
    base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "state"
    return base / "repociv" / "pending-work.json"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _load_episodes() -> tuple[dict[str, dict[str, Any]], str | None]:
    """Read persisted episodes. Returns ``(episodes, error)`` — never raises."""
    path = state_file()
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}, None
    except OSError as exc:
        return {}, f"pending-work state unreadable: {exc}"
    try:
        data = json.loads(raw)
    except ValueError as exc:
        return {}, f"pending-work state corrupt: {exc}"
    if not isinstance(data, dict):
        return {}, "pending-work state corrupt: not an object"
    episodes = data.get("episodes")
    if data.get("version") != _STATE_VERSION or not isinstance(episodes, dict):
        return {}, "pending-work state corrupt: wrong version or missing episodes"
    clean: dict[str, dict[str, Any]] = {}
    invalid = False
    for key, record in episodes.items():
        if not isinstance(key, str) or not isinstance(record, dict):
            invalid = True
            continue
        first = record.get("firstObservedAtMs")
        last = record.get("lastObservedAtMs")
        if (type(first) is not int or type(last) is not int or first < 0 or last < first
                or not isinstance(record.get("worktreePath"), str)):
            invalid = True
            continue
        entry: dict[str, Any] = {"firstObservedAtMs": first, "lastObservedAtMs": last}
        for field in ("repoPath", "worktreePath", "branch", "head"):
            value = record.get(field)
            if isinstance(value, str):
                entry[field] = value
        clean[key] = entry
    return clean, "pending-work state corrupt: invalid episode records" if invalid else None


def _save_episodes(episodes: dict[str, dict[str, Any]]) -> str | None:
    """Atomically replace the state file. Returns an error string on failure."""
    path = state_file()
    payload = {"version": _STATE_VERSION, "episodes": episodes}
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:
        try:
            tmp.unlink()
        except OSError:
            pass
        return f"pending-work state unwritable: {exc}"
    return None


_STATE_LOCK = threading.Lock()


def _quarantine_corrupt_state() -> None:
    """Move an unparseable state file aside so the next write can repair it."""
    path = state_file()
    try:
        if not path.exists():
            return
        json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    else:
        return
    try:
        os.replace(path, path.with_name(f"{path.name}.corrupt-{_now_ms()}"))
    except OSError:
        pass


# ── git plumbing ─────────────────────────────────────────────────────────────
def _git_env() -> dict[str, str]:
    """A copy of the environment that cannot redirect git elsewhere."""
    env = dict(os.environ)
    for key in list(env):
        if key in _STRIP_ENV or key.startswith("GIT_CONFIG_"):
            env.pop(key, None)
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def _git(args: list[str], cwd: str, timeout: float = _GIT_TIMEOUT_S) -> subprocess.CompletedProcess[str]:
    """Run one read-only git command. Raises on timeout / missing binary."""
    cmd = [
        _GIT_BIN,
        "-c",
        "core.quotepath=false",   # raw UTF-8 paths, never octal escapes
        "-c",
        "status.relativePaths=false",  # paths always relative to the worktree top
        "-c",
        "core.fsmonitor=false",  # status must not execute a configured monitor hook
        "--no-optional-locks",    # never rewrite .git/index while sampling
        *args,
    ]
    env = _git_env()
    # Never discover a parent checkout when a selected repo loses its .git.
    env["GIT_CEILING_DIRECTORIES"] = os.pathsep.join(filter(None, [
        env.get("GIT_CEILING_DIRECTORIES", ""), os.path.dirname(_real(cwd)),
    ]))
    return subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def _parse_worktree_list(raw: str) -> list[dict[str, str]]:
    """Parse ``git worktree list --porcelain -z``.

    With ``-z`` every field *and* every record terminator is a NUL, so a record
    ends on an empty token — which is what lets worktree paths contain literal
    newlines and still round-trip.
    """
    records: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for token in raw.split("\0"):
        if token == "":
            if current:
                records.append(current)
                current = {}
            continue
        key, sep, value = token.partition(" ")
        current[key] = value if sep else ""
    if current:
        records.append(current)
    return records


def _parse_status(raw: str) -> list[dict[str, str]]:
    """Parse ``git status --porcelain=v1 -z`` into one record per path.

    Rename and copy records carry a second NUL-terminated field with the
    original path; the pair counts as a single path.
    """
    tokens = raw.split("\0")
    out: list[dict[str, str]] = []
    index = 0
    total = len(tokens)
    while index < total:
        token = tokens[index]
        index += 1
        if not token or len(token) < 4 or token[2] != " ":
            continue  # malformed / stray separator
        xy = token[:2]
        entry = {"path": token[3:], "index": xy[0], "worktree": xy[1], "xy": xy}
        if xy[0] in ("R", "C"):
            entry["origPath"] = tokens[index] if index < total else ""
            index += 1
        out.append(entry)
    return out


def _classify(entries: list[dict[str, str]]) -> dict[str, int]:
    staged = unstaged = untracked = conflicts = 0
    for entry in entries:
        xy = entry["xy"]
        if xy == "??":
            untracked += 1
            continue
        if xy in _UNMERGED:
            conflicts += 1
        if entry["index"] in _STAGED_INDEX:
            staged += 1
        if entry["worktree"] in _UNSTAGED_WORKTREE:
            unstaged += 1
    return {
        "stagedCount": staged,
        "unstagedCount": unstaged,
        "untrackedCount": untracked,
        "conflictCount": conflicts,
        "changedCount": len(entries),
    }


# ── selection ────────────────────────────────────────────────────────────────
def _selected_repo_paths() -> tuple[list[str], list[str]]:
    """Only the active map root's explicit selection."""
    errors: list[str] = []
    paths: list[str] = []
    try:
        from server import repo_roots_state  # noqa: PLC0415

        root = repo_roots_state.active_root()
        if root:
            paths = [p for p in repo_roots_state.get_selection(root) if isinstance(p, str)]
    except Exception as exc:  # pragma: no cover - defensive
        errors.append(f"repo selection unavailable: {exc}")

    canonical: list[str] = []
    seen: set[str] = set()
    for path in paths:
        if not path.strip():
            continue
        real = _real(path)
        if real and real not in seen:
            seen.add(real)
            canonical.append(real)
    return canonical, errors


def _real(path: str) -> str:
    """realpath with a normalized fallback for paths that no longer exist."""
    expanded = os.path.abspath(os.path.expanduser(path))
    try:
        return os.path.realpath(expanded)
    except OSError:
        return expanded


# ── related sessions ─────────────────────────────────────────────────────────
def _iso_to_ms(value: Any) -> int | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        from datetime import datetime  # noqa: PLC0415

        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    try:
        value_ms = int(parsed.timestamp() * 1000)
        return value_ms if value_ms >= 0 else None
    except (ValueError, OverflowError, OSError):
        return None


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        result = int(value)
        return result if result >= 0 else None
    except (ValueError, OverflowError):
        return None


def _within(path: str, root: str) -> bool:
    """True when ``path`` is ``root`` or lives inside it (both realpath'd)."""
    if not path or not root:
        return False
    candidate = _real(path)
    container = _real(root)
    if candidate == container:
        return True
    return candidate.startswith(container.rstrip(os.sep) + os.sep)


def _session_sources() -> tuple[dict[str, Any], list[str]]:
    """Snapshot each registry once per inventory, not once per worktree."""
    from server import claude_live, own_sessions, suvadu_tracker  # noqa: PLC0415

    sources: dict[str, Any] = {}
    errors: list[str] = []
    for name, read in (
        ("external", suvadu_tracker.sessions),
        ("own", own_sessions.snapshot),
        ("live claude", lambda: claude_live.get_manager().sessions()),
    ):
        try:
            sources[name] = read()
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name} sessions unavailable: {exc}")
    return sources, errors


def _related_sessions(worktree_path: str, sources: dict[str, Any] | None = None) -> tuple[list[dict[str, Any]], list[str]]:
    """Sessions whose working directory is inside ``worktree_path``.

    Reads only the existing bridge registries. A match is context, not
    authorship: it says a session ran here, nothing about who edited what.
    """
    found: list[dict[str, Any]] = []
    errors: list[str] = []
    if sources is None:
        sources, errors = _session_sources()
    seen: set[str] = set()

    def add(session_id: Any, name: Any, status: Any, last_ms: Any) -> None:
        sid = str(session_id or "").strip()
        if not sid or sid in seen:
            return
        seen.add(sid)
        found.append(
            {
                "id": sid,
                "name": str(name or sid),
                "status": str(status or "unknown"),
                "lastActivityAtMs": _int_or_none(last_ms) or _iso_to_ms(last_ms),
            }
        )

    # External agents (suvadu tracker) — cityId decodes to the repo path.
    try:
        payload = sources.get("external", {})
        rows = payload.get("sessions") if isinstance(payload, dict) else None
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            path = None
            city_id = row.get("cityId")
            if isinstance(city_id, str) and city_id:
                try:
                    from server.repo_roots_state import decode_repo_id  # noqa: PLC0415

                    path = decode_repo_id(city_id)
                except Exception:  # noqa: BLE001 - a bad id must not break the scan
                    path = None
            if path and _within(path, worktree_path):
                unit = row.get("unit")
                label = unit or f"{row.get('agent', '')} · {row.get('profile', '')}".strip(" ·")
                add(row.get("sessionId"), label, row.get("state"), row.get("lastActivityAt"))
    except Exception as exc:  # noqa: BLE001 - visible, never swallowed as "none"
        errors.append(f"external sessions unavailable: {exc}")

    # RepoCiv's own sessions — cityRepoPath is the exact working directory.
    try:
        snapshot = sources.get("own", {})
        rows = snapshot.get("agents") if isinstance(snapshot, dict) else None
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            if _within(str(row.get("cityRepoPath") or ""), worktree_path):
                add(row.get("unit"), row.get("unit"), row.get("state"), row.get("lastActivityAt"))
    except Exception as exc:  # noqa: BLE001
        errors.append(f"own sessions unavailable: {exc}")

    # Live Claude sessions — cwd is the exact working directory.
    try:
        for row in sources.get("live claude", []):
            if not isinstance(row, dict):
                continue
            if _within(str(row.get("cwd") or ""), worktree_path):
                add(row.get("sessionId"), row.get("nativeId"), "live" if row.get("alive") else "ended", row.get("lastActivityAt"))
    except Exception as exc:  # noqa: BLE001
        errors.append(f"live claude sessions unavailable: {exc}")

    found.sort(key=lambda row: (row["lastActivityAtMs"] is None, -(row["lastActivityAtMs"] or 0), row["id"]))
    return found, errors


# ── entry construction ───────────────────────────────────────────────────────
def _episode_key(worktree_path: str, branch: str, head: str) -> str:
    return f"{worktree_path}\0{branch}\0{head}"


def _entry(
    *,
    repo_path: str,
    worktree_path: str,
    branch: str,
    detached: bool,
    head: str,
    now_ms: int,
) -> dict[str, Any]:
    return {
        "repoPath": repo_path,
        "repoName": os.path.basename(repo_path.rstrip(os.sep)) or repo_path,
        "worktreePath": worktree_path,
        "branch": branch,
        "detached": detached,
        "head": head,
        "state": "clean",
        "stagedCount": 0,
        "unstagedCount": 0,
        "untrackedCount": 0,
        "conflictCount": 0,
        "changedCount": 0,
        "files": [],
        "firstObservedAtMs": None,
        "lastObservedAtMs": None,
        "ageMs": None,
        "relatedSessions": [],
    }


def _unavailable(
    repo_path: str,
    worktree_path: str,
    error: str,
    now_ms: int,
    episodes: dict[str, dict[str, Any]] | None = None,
    key: str | None = None,
) -> dict[str, Any]:
    entry = _entry(repo_path=repo_path, worktree_path=worktree_path, branch="", detached=False, head="", now_ms=now_ms)
    entry["state"] = "unavailable"
    entry["error"] = error
    if episodes is not None and key is not None:
        _retain_episode(entry, episodes, key, now_ms)
    return entry


def _observe_worktree(
    record: dict[str, str],
    repo_path: str,
    episodes: dict[str, dict[str, Any]],
    now_ms: int,
    errors: list[str],
    *,
    deadline: float = float("inf"),
    sources: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Sample one worktree and reconcile its dirty episode."""
    raw_path = record.get("worktree", "")
    if not raw_path:
        return None
    worktree_path = _real(raw_path)
    head = record.get("HEAD", "")
    if head and set(head) == {"0"}:
        head = ""  # unborn branch: no commit exists yet
    branch_ref = record.get("branch", "")
    detached = "detached" in record
    branch = branch_ref[len("refs/heads/") :] if branch_ref.startswith("refs/heads/") else ""

    entry = _entry(
        repo_path=repo_path,
        worktree_path=worktree_path,
        branch=branch,
        detached=detached,
        head=head,
        now_ms=now_ms,
    )

    if not os.path.isdir(worktree_path):
        entry["state"] = "unavailable"
        entry["error"] = "worktree directory missing"
        _retain_episode(entry, episodes, _episode_key(worktree_path, branch, head), now_ms)
        return entry

    try:
        result = _git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd=worktree_path, timeout=_remaining(deadline))
    except TimeoutError:
        entry["state"] = "unavailable"
        entry["error"] = "sampling budget exhausted; git status was not run"
    except subprocess.TimeoutExpired as exc:
        entry["state"] = "unavailable"
        entry["error"] = f"git status timed out after {exc.timeout:g}s"
    except Exception as exc:  # noqa: BLE001 - any git failure stays "unavailable"
        entry["state"] = "unavailable"
        entry["error"] = f"git status failed: {exc}"
    else:
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip().splitlines()
            entry["state"] = "unavailable"
            entry["error"] = f"git status exited {result.returncode}: {detail[0] if detail else 'no output'}"

    if entry["state"] == "unavailable":
        # Retain the last known age: an unreadable worktree is not evidence of
        # finished work.
        _retain_episode(entry, episodes, _episode_key(worktree_path, branch, head), now_ms)
        return entry

    parsed = _parse_status(result.stdout)
    if len(parsed) > _MAX_FILES_PER_ENTRY:
        errors.append(f"{worktree_path}: showing {_MAX_FILES_PER_ENTRY} of {len(parsed)} files; counts are complete")
    counts = _classify(parsed)
    entry.update(counts)
    entry["files"] = [
        {"path": item["path"], "index": item["index"], "worktree": item["worktree"]}
        for item in parsed[:_MAX_FILES_PER_ENTRY]
    ]
    entry["state"] = "dirty" if counts["changedCount"] else "clean"

    key = _episode_key(worktree_path, branch, head)
    previous = episodes.get(key)
    # A successful observation ends other branch/HEAD episodes for this path.
    for old_key, old_record in list(episodes.items()):
        if old_key != key and old_record.get("worktreePath") == worktree_path:
            episodes.pop(old_key)
    if entry["state"] == "dirty":
        if previous is None:
            episodes[key] = {
                "firstObservedAtMs": now_ms,
                "lastObservedAtMs": now_ms,
                "repoPath": repo_path,
                "worktreePath": worktree_path,
                "branch": branch,
                "head": head,
            }
            entry["firstObservedAtMs"] = now_ms
        else:
            first = previous["firstObservedAtMs"]
            episodes[key] = {
                "firstObservedAtMs": first,
                "lastObservedAtMs": now_ms,
                "repoPath": repo_path,
                "worktreePath": worktree_path,
                "branch": branch,
                "head": head,
            }
            entry["firstObservedAtMs"] = first
        entry["lastObservedAtMs"] = now_ms
        entry["ageMs"] = max(0, now_ms - int(entry["firstObservedAtMs"]))
    else:
        # A successfully observed clean state resets the episode.
        episodes.pop(key, None)

    sessions, session_errors = _related_sessions(worktree_path, sources)
    entry["relatedSessions"] = sessions
    errors.extend(session_errors)
    return entry


def _retain_episode(entry: dict[str, Any], episodes: dict[str, dict[str, Any]], key: str, now_ms: int) -> None:
    """Keep the last known age for a worktree we could not observe."""
    previous = episodes.get(key)
    if previous is None:
        return
    entry["firstObservedAtMs"] = previous["firstObservedAtMs"]
    entry["lastObservedAtMs"] = previous["lastObservedAtMs"]
    entry["ageMs"] = max(0, now_ms - int(previous["firstObservedAtMs"]))


def _retained_entries(repo_path: str, episodes: dict[str, dict[str, Any]], now_ms: int, seen: set[str] | None = None) -> list[dict[str, Any]]:
    """Unavailable entries for worktrees we know about from persisted episodes.

    Used when ``git worktree list`` itself fails: the repo is unreadable, but any
    episode we recorded is still evidence of pending work, so it must not vanish.
    """
    out: list[dict[str, Any]] = []
    for record in sorted(episodes.values(), key=lambda r: r.get("worktreePath") or ""):
        worktree = record.get("worktreePath")
        # Directory containment is not Git-family evidence: nested independent
        # repos can have their own selection and must never be resurrected here.
        if not worktree or (record.get("repoPath") != repo_path and worktree != repo_path):
            continue
        if seen is not None and worktree in seen:
            continue
        branch = record.get("branch", "")
        head = record.get("head", "")
        key = _episode_key(worktree, branch, head)
        entry = _unavailable(
            repo_path,
            worktree,
            "repo unreadable; retaining last known observation",
            now_ms,
            episodes,
            key,
        )
        entry["branch"] = branch
        entry["head"] = head
        entry["detached"] = not branch
        out.append(entry)
    return out


def _remaining(deadline: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise TimeoutError("sampling budget exhausted")
    return min(_GIT_TIMEOUT_S, left)


def _scan_repo(repo_path: str, episodes: dict[str, dict[str, Any]], now_ms: int, errors: list[str], *, deadline: float = float("inf"), sources: dict[str, Any] | None = None, seen: set[str] | None = None) -> list[dict[str, Any]]:

    def unreadable(error: str) -> list[dict[str, Any]]:
        # If we already recorded episodes for this repo, surface those (with
        # their last known age) rather than a single anonymous failure.
        retained = _retained_entries(repo_path, episodes, now_ms, seen)
        if retained:
            return retained
        if seen is not None and repo_path in seen:
            return []
        return [_unavailable(repo_path, repo_path, error, now_ms)]

    if not os.path.isdir(repo_path):
        return unreadable("repo path is not a directory")

    try:
        result = _git(["worktree", "list", "--porcelain", "-z"], cwd=repo_path, timeout=_remaining(deadline))
    except TimeoutError:
        return unreadable("sampling budget exhausted; git worktree list was not run")
    except subprocess.TimeoutExpired as exc:
        return unreadable(f"git worktree list timed out after {exc.timeout:g}s")
    except Exception as exc:  # noqa: BLE001 - any git failure stays "unavailable"
        return unreadable(f"git worktree list failed: {exc}")

    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        return unreadable(
            f"git worktree list exited {result.returncode}: {detail[0] if detail else 'no output'}"
        )

    records = _parse_worktree_list(result.stdout)
    inspectable = [record for record in records if "bare" not in record and record.get("worktree")]
    if not inspectable:
        # A bare repository has no worktree to inspect; saying "clean" would be
        # a false negative.
        return [_unavailable(repo_path, repo_path, "bare repository: no worktree to inspect", now_ms)]

    entries: list[dict[str, Any]] = []
    for record in inspectable:
        worktree = _real(record["worktree"])
        if seen is not None:
            if worktree in seen:
                continue
            seen.add(worktree)
        entry = _observe_worktree(record, repo_path, episodes, now_ms, errors, deadline=deadline, sources=sources)
        if time.monotonic() >= deadline:
            errors.append("sampling budget exhausted; some worktrees were not inspected")
        if entry is not None:
            entries.append(entry)
    return entries


def _prune(episodes: dict[str, dict[str, Any]], now_ms: int, protected: set[str] | None = None) -> None:
    for key in list(episodes):
        record = episodes[key]
        last = record.get("lastObservedAtMs")
        worktree = record.get("worktreePath") or key.split("\0", 1)[0]
        stale = isinstance(last, int) and not isinstance(last, bool) and now_ms - last > _PRUNE_AFTER_MS
        if stale and worktree not in (protected or set()):
            episodes.pop(key, None)
    if len(episodes) <= _MAX_EPISODES:
        return
    ordered = sorted(episodes.items(), key=lambda item: item[1].get("lastObservedAtMs") or 0)
    for key, _ in ordered[: len(episodes) - _MAX_EPISODES]:
        episodes.pop(key, None)


def _order(entry: dict[str, Any]) -> tuple[int, float, str]:
    if entry["state"] == "dirty":
        rank = 0 if entry["conflictCount"] else 1
    else:
        rank = 2
    first = entry["firstObservedAtMs"]
    return (rank, float("inf") if first is None else float(first), entry["worktreePath"])


# ── cached polls ─────────────────────────────────────────────────────────────
_CACHE: dict[str, Any] = {"signature": None, "at_ms": 0, "payload": None}
_CACHE_LOCK = threading.Lock()


def reset_cache() -> None:
    """Drop the cached sample (tests and long-idle panels)."""
    with _CACHE_LOCK:
        _CACHE.update(signature=None, at_ms=0, payload=None)


def _cache_ttl_ms() -> int:
    raw = os.environ.get("REPOCIV_PENDING_WORK_CACHE_MS", "").strip()
    if raw:
        try:
            return max(0, int(raw))
        except ValueError:
            pass
    return _CACHE_TTL_MS


def collect(now_ms: int | None = None, *, force: bool = False) -> dict[str, Any]:
    """Build (or reuse) the pending-work payload.

    ``now_ms`` pins the clock — tests pass it and bypass the cache.
    """
    pinned = now_ms is not None
    now = int(now_ms) if now_ms is not None else _now_ms()

    repo_paths, selection_errors = _selected_repo_paths()
    signature = tuple(repo_paths)

    if not pinned and not force:
        ttl = _cache_ttl_ms()
        with _CACHE_LOCK:
            if (
                ttl > 0
                and _CACHE["payload"] is not None
                and _CACHE["signature"] == signature
                and 0 <= now - int(_CACHE["at_ms"] or 0) < ttl
            ):
                return _CACHE["payload"]

    errors: list[str] = list(selection_errors)
    persistence_error: str | None = None

    if shutil.which(_GIT_BIN) is None:
        return {
            "available": False,
            "sampledAtMs": now,
            "entries": [],
            "errors": [f"{_GIT_BIN} executable not found"],
        }

    if not repo_paths:
        errors.append("no repositories selected")

    with _STATE_LOCK:
        # A concurrent request may have finished the same scan while we waited.
        if not pinned and not force:
            now = _now_ms()
            with _CACHE_LOCK:
                if (_CACHE["payload"] is not None and _CACHE["signature"] == signature
                        and 0 <= now - int(_CACHE["at_ms"] or 0) < _cache_ttl_ms()):
                    return _CACHE["payload"]
        episodes, load_error = _load_episodes()
        if load_error:
            persistence_error = load_error
            _quarantine_corrupt_state()

        entries: list[dict[str, Any]] = []
        deadline = time.monotonic() + _SCAN_BUDGET_S
        sources, source_errors = _session_sources() if repo_paths else ({}, [])
        errors.extend(source_errors)
        seen: set[str] = set()
        for repo_path in repo_paths:
            if entries and time.monotonic() > deadline:
                errors.append("sampling budget exhausted; remaining repositories were not inspected")
                break
            try:
                entries.extend(_scan_repo(repo_path, episodes, now, errors, deadline=deadline, sources=sources, seen=seen))
            except Exception as exc:  # noqa: BLE001 - one bad repo must not kill the scan
                entries.append(_unavailable(repo_path, repo_path, f"scan failed: {exc}", now))

        if len(episodes) > _MAX_EPISODES:
            errors.append(f"observation history exceeds {_MAX_EPISODES} episodes; oldest records will be evicted")
        _prune(episodes, now, {row["worktreePath"] for row in entries})
        save_error = _save_episodes(episodes)
        if save_error:
            persistence_error = persistence_error or save_error

        return _publish(entries, errors, persistence_error, now, signature, pinned)


def _publish(entries: list[dict[str, Any]], errors: list[str], persistence_error: str | None, now: int, signature: tuple[str, ...], pinned: bool) -> dict[str, Any]:
    by_path: dict[str, dict[str, Any]] = {}
    for row in entries:
        existing = by_path.get(row["worktreePath"])
        # A persisted fallback must not overwrite a successfully sampled state,
        # regardless of selected-repo order. Prefer newer evidence on a tie.
        evidence = (row["state"] != "unavailable", row["lastObservedAtMs"] if row["lastObservedAtMs"] is not None else -1)
        previous = (existing["state"] != "unavailable", existing["lastObservedAtMs"] if existing["lastObservedAtMs"] is not None else -1) if existing else None
        if previous is None or evidence > previous:
            by_path[row["worktreePath"]] = row
    entries = list(by_path.values())
    entries.sort(key=_order)
    if len(entries) > _MAX_WORKTREES:
        errors.append(f"{len(entries)} worktrees found; showing {_MAX_WORKTREES} prioritized entries")
        entries = entries[:_MAX_WORKTREES]
    errors = list(dict.fromkeys(errors))

    payload: dict[str, Any] = {
        "available": True,
        "sampledAtMs": now,
        "entries": entries,
        "errors": errors,
    }
    if persistence_error:
        payload["persistenceError"] = persistence_error

    if not pinned:
        with _CACHE_LOCK:
            _CACHE.update(signature=signature, at_ms=now, payload=payload)
    return payload
