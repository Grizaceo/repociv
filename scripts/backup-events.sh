#!/bin/bash
# RepoCiv events.jsonl backup script
# Usage: ./scripts/backup-events.sh
# Recommended: cron daily @ 3am or systemd timer

set -euo pipefail

SOURCE="${HOME}/.repociv/events.jsonl"
BACKUP_DIR="${HOME}/.repociv/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DEST="${BACKUP_DIR}/events_${TIMESTAMP}.jsonl"

# Only backup if source exists and is non-empty
if [[ ! -s "$SOURCE" ]]; then
    echo "SKIP: events.jsonl empty or missing"
    exit 0
fi

# Create backup
cp "$SOURCE" "$DEST"

# Compress older than 1 hour to save space
find "$BACKUP_DIR" -name "events_*.jsonl" -mmin +60 -exec gzip {} \; 2>/dev/null || true

# Keep last 7 days of compressed backups, delete older
find "$BACKUP_DIR" -name "events_*.jsonl.gz" -mtime +7 -delete 2>/dev/null || true

# Count
CURRENT_SIZE=$(stat -c%s "$DEST" 2>/dev/null || stat -f%z "$DEST")
echo "OK: backed up events.jsonl (${CURRENT_SIZE} bytes) -> events_${TIMESTAMP}.jsonl"
