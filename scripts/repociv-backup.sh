#!/bin/bash
# RepoCiv event store backup — called by systemd timer every 6h.
set -euo pipefail

STORE_DIR="${HOME}/.repociv"
BACKUP_DIR="${STORE_DIR}/backups"

mkdir -p "${BACKUP_DIR}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

for f in events.jsonl missions.json scheduler-queue.json directive_records.jsonl directive_templates.json; do
    if [ -f "${STORE_DIR}/${f}" ]; then
        base="${f%.*}"
        ext="${f##*.}"
        cp "${STORE_DIR}/${f}" "${BACKUP_DIR}/${base}-${timestamp}.${ext}"
    fi
done

# Rotate: keep last 30 days
find "${BACKUP_DIR}" -type f -mtime +30 -delete
