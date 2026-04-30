#!/bin/bash
# RepoCiv event store backup — called by systemd timer every 6h.
set -euo pipefail

STORE_DIR="${HOME}/.repociv"
BACKUP_DIR="${STORE_DIR}/backups"

mkdir -p "${BACKUP_DIR}"

for f in events.jsonl missions.json directive_records.jsonl; do
    if [ -f "${STORE_DIR}/${f}" ]; then
        base="${f%.*}"
        ext="${f##*.}"
        cp "${STORE_DIR}/${f}" "${BACKUP_DIR}/${base}-$(date -Iminutes).${ext}"
    fi
done

# Rotate: keep last 30 days
find "${BACKUP_DIR}" -type f -mtime +30 -delete
