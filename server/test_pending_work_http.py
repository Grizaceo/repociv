"""Exercise the real bridge HTTP handler in a fresh isolated process."""
import json
import os
import secrets
import subprocess
import time
import urllib.request

from server.test_pending_work import commit, git, init_repo


def test_pending_work_http_restart_and_read_only_git(tmp_path):
    repo = init_repo(tmp_path / "repo")
    (repo / "tracked").write_text("base")
    commit(repo)
    (repo / "tracked").write_text("edited")
    linked = tmp_path / "linked"
    git(repo, "worktree", "add", "-b", "feature", str(linked))
    (linked / "new").write_text("new")
    selected = tmp_path / "map-state.json"
    selected.write_text(json.dumps({"version": 1, "activeRoot": str(tmp_path), "roots": {
        str(tmp_path): {"selectedRepoPaths": [str(repo)]},
    }}))
    state = tmp_path / "pending-work.json"
    ready = tmp_path / "ready.json"
    home = tmp_path / "home"
    home.mkdir()
    token = secrets.token_hex(32)
    env = {**os.environ, "HOME": str(home), "HERMES_HOME": str(home / ".hermes"),
           "XDG_STATE_HOME": str(home / "state"), "REPOCIV_CONFIG_DIR": str(home / ".repociv"),
           "REPOCIV_STATE_FILE": str(selected), "REPOCIV_PENDING_WORK_STATE_FILE": str(state),
           "REPOCIV_PENDING_WORK_CACHE_MS": "0", "REPOCIV_REMOTE": "0", "REPOCIV_TOKEN": token,
           "GIT_CEILING_DIRECTORIES": str(tmp_path)}
    child_code = """
import json, sys
from pathlib import Path
from http.server import ThreadingHTTPServer
from server.bridge import BridgeHandler
server = ThreadingHTTPServer(('127.0.0.1', 0), BridgeHandler)
Path(sys.argv[1]).write_text(json.dumps({'port': server.server_port}))
server.serve_forever()
"""

    def start():
        ready.unlink(missing_ok=True)
        log = (tmp_path / "bridge.log").open("a")
        proc = subprocess.Popen([os.sys.executable, "-c", child_code, str(ready)], env=env,
                                stdout=log, stderr=log)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                log.close()
                raise AssertionError(f"bridge exited {proc.returncode}; see {tmp_path / 'bridge.log'}")
            if ready.exists():
                port = json.loads(ready.read_text())["port"]
                return proc, log, port
            time.sleep(0.05)
        proc.terminate()
        proc.wait(timeout=5)
        log.close()
        raise AssertionError("bridge HTTP readiness timed out")

    def fetch(port):
        # Query paths are deliberately ignored, not used as an arbitrary-root API.
        request = urllib.request.Request(f"http://127.0.0.1:{port}/api/pending-work?path=/",
                                         headers={"X-RepoCiv-Token": token})
        with urllib.request.urlopen(request, timeout=10) as response:
            assert response.status == 200
            return json.load(response)

    def stop(proc, log):
        proc.terminate()
        proc.wait(timeout=5)
        log.close()

    proc, log, port = start()
    index = repo / ".git" / "index"
    before = index.stat().st_mtime_ns
    try:
        first = fetch(port)
        assert len(first["entries"]) == 2
        assert all(row["state"] == "dirty" for row in first["entries"])
        assert not first["errors"]
        second = fetch(port)
        assert index.stat().st_mtime_ns == before
        assert {row["worktreePath"] for row in second["entries"]} == {str(repo), str(linked)}
    finally:
        stop(proc, log)

    proc, log, port = start()
    try:
        restarted = fetch(port)
        assert {row["worktreePath"]: row["firstObservedAtMs"] for row in restarted["entries"]} == {
            row["worktreePath"]: row["firstObservedAtMs"] for row in first["entries"]}
        assert index.stat().st_mtime_ns == before
    finally:
        stop(proc, log)
