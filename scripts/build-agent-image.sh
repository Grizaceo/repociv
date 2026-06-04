#!/usr/bin/env bash
# Build the isolated agent image (repociv-agent:latest).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

IMAGE="${REPOCIV_AGENT_IMAGE:-repociv-agent:latest}"

docker build -f Dockerfile.agent -t "$IMAGE" .
echo "Built $IMAGE"
echo "Enable: REPOCIV_AGENT_CONTAINER=1 (and ensure docker CLI works on the bridge host)"
