#!/usr/bin/env bash
# ─── RepoCiv — Event store backup ────────────────────────────────────────────
# Copies events.jsonl to a timestamped backup.
# Rotates: keeps last 7 backups.
# Usage: ./scripts/backup-events.sh [--keep N]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$REPO_ROOT/.env" ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$REPO_ROOT/.env" | grep -v '^$' | xargs)
fi

CONFIG_DIR="${REPOCIV_CONFIG_DIR:-$HOME/.repociv}"
EVENTS_FILE="$CONFIG_DIR/events.jsonl"
BACKUP_DIR="$CONFIG_DIR/backups"
KEEP="${2:-7}"  # second arg overrides --keep; default 7

if [[ "${1:-}" == "--keep" ]] && [[ -n "${2:-}" ]]; then
  KEEP="$2"
fi

if [[ ! -f "$EVENTS_FILE" ]]; then
  echo "ℹ Sin events.jsonl en $EVENTS_FILE — nada que respaldar."
  exit 0
fi

mkdir -p "$BACKUP_DIR"

LINES=$(wc -l < "$EVENTS_FILE" || echo 0)
SIZE=$(du -sh "$EVENTS_FILE" | cut -f1)
TS=$(date +%Y%m%d-%H%M%S)
DEST="$BACKUP_DIR/events-$TS.jsonl"

cp "$EVENTS_FILE" "$DEST"
echo "✔ Backup: $DEST ($LINES líneas, $SIZE)"

# Rotate: keep newest $KEEP backups
EXCESS=$(ls -t "$BACKUP_DIR"/events-*.jsonl 2>/dev/null | tail -n +$((KEEP + 1)) || true)
if [[ -n "$EXCESS" ]]; then
  COUNT=$(echo "$EXCESS" | wc -l)
  echo "$EXCESS" | xargs rm -f
  echo "  → $COUNT backup(s) antiguo(s) eliminado(s)"
fi

echo "  → Total backups: $(ls "$BACKUP_DIR"/events-*.jsonl 2>/dev/null | wc -l)"
