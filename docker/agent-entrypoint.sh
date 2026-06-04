#!/bin/sh
# Isolated agent entrypoint for repociv-agent image.
# Mission text is passed as docker run arguments (see container_runtime.py).
set -eu

MISSION="${*:-}"
TARGET="${REPOCIV_TARGET_REPO:-/repo}"
WORK="${REPOCIV_WORKSPACE:-/tmp/workspace}"

cd "$WORK" 2>/dev/null || true

if [ -n "${REPOCIV_AGENT_CMD:-}" ]; then
  # Trusted-only override for images that bundle a real agent CLI.
  # Parse like a normal argv vector (no shell evaluation / no sh -c).
  export REPOCIV_MISSION="$MISSION"
  exec python3 -c 'import os, shlex; cmd=os.environ["REPOCIV_AGENT_CMD"]; argv=shlex.split(cmd); assert argv, "empty REPOCIV_AGENT_CMD"; os.execvp(argv[0], argv)'
fi

if [ "${REPOCIV_CONTAINER_STUB:-0}" = "1" ]; then
  printf '%s\n' "[repociv-agent] stub run (REPOCIV_CONTAINER_STUB=1)"
  printf '%s\n' "[repociv-agent] target_repo=${TARGET} workspace=${WORK}"
  printf '%s\n' "REPOCIV_CONTAINER_STUB=1"
  printf '%s\n' "$MISSION"
  exit 0
fi

printf '%s\n' "[repociv-agent] error: set REPOCIV_AGENT_CMD for a real agent or REPOCIV_CONTAINER_STUB=1 for smoke tests" >&2
exit 64
