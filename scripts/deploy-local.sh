#!/usr/bin/env bash
# scripts/deploy-local.sh — prepare the production checkout used by
# deploy/systemd/repociv-prod.service.
#
# The live service should not run from the checkout you develop in: there,
# `scripts/check.sh` rewrites dist/ and coverage/, edits hot-reload open tabs,
# and the bridge keeps running whatever was imported at its last restart. This
# script materialises a separate git worktree at a chosen ref, installs the
# pinned dependencies and builds dist/. It does not touch the running service
# unless --restart is given.
#
# Usage:
#   scripts/deploy-local.sh                 # deploy origin/main
#   scripts/deploy-local.sh --ref v0.2.0    # deploy a tag/branch/commit
#   scripts/deploy-local.sh --restart       # ...then restart repociv-prod.service
#
# Env: REPOCIV_DEPLOY_DIR (default ~/.local/share/repociv/deploy)
set -euo pipefail

REF="origin/main"
RESTART=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --restart) RESTART=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${REPOCIV_DEPLOY_DIR:-$HOME/.local/share/repociv/deploy}"

git -C "$SRC" fetch --quiet origin
COMMIT="$(git -C "$SRC" rev-parse --verify "$REF^{commit}")"

if [[ -d "$DEPLOY_DIR/.git" || -f "$DEPLOY_DIR/.git" ]]; then
  if [[ -n "$(git -C "$DEPLOY_DIR" status --porcelain --untracked-files=no)" ]]; then
    echo "✗ $DEPLOY_DIR has local modifications — refusing to overwrite them." >&2
    exit 1
  fi
  git -C "$DEPLOY_DIR" checkout --quiet --detach "$COMMIT"
else
  mkdir -p "$(dirname "$DEPLOY_DIR")"
  git -C "$SRC" worktree add --quiet --detach "$DEPLOY_DIR" "$COMMIT"
fi
echo "▶ $DEPLOY_DIR @ $(git -C "$DEPLOY_DIR" log -1 --format='%h %s')"

cd "$DEPLOY_DIR"
npm ci --no-audit --no-fund
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -r requirements.lock
# Generated asset atlases are not versioned (npm run assets); reuse the ones
# already built in the source tree. Must happen before vite copies public/.
if [[ -d "$SRC/public/assets" ]]; then
  rsync -a --ignore-existing "$SRC/public/assets/" "$DEPLOY_DIR/public/assets/"
fi
npx --no-install vite build

echo "✔ Build ready at $DEPLOY_DIR/dist"
if [[ "$RESTART" -eq 1 ]]; then
  systemctl --user restart repociv-prod.service
  echo "✔ repociv-prod.service restarted"
else
  echo "  Activate with: systemctl --user restart repociv-prod.service"
fi
