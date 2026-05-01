#!/usr/bin/env python3
"""Minimal agent container entrypoint.

Runtime policy is supplied by Docker flags in ``server.container_runtime``. The
entrypoint intentionally does not read host secrets or write to the mounted repo.
"""
from __future__ import annotations

import os
import sys


def main() -> int:
    mission = " ".join(sys.argv[1:]).strip()
    repo = os.environ.get("REPOCIV_TARGET_REPO", "/repo")
    workspace = os.environ.get("REPOCIV_WORKSPACE", "/tmp/workspace")
    print(f"[repociv-container] repo={repo} workspace={workspace}")
    if mission:
        print("[repociv-container] mission received")
    else:
        print("[repociv-container] no mission provided")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
