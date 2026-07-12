#!/usr/bin/env bash
# RepoCiv state backup — intended for the systemd timer.
set -euo pipefail

STATE_DIR="${REPOCIV_STATE_DIR:-${REPOCIV_DATA_DIR:-${REPOCIV_CONFIG_DIR:-${HOME}/.repociv}}}"
CONFIG_DIR="${REPOCIV_CONFIG_DIR:-${HOME}/.repociv}"
BACKUP_DIR="${REPOCIV_BACKUP_DIR:-${STATE_DIR}/backups}"
ROOTS_FILE="${REPOCIV_STATE_FILE:-${XDG_STATE_HOME:-${HOME}/.local/state}/repociv/repo-roots.json}"

mkdir -p "${BACKUP_DIR}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp="${BACKUP_DIR}/.${timestamp}.tmp.$$"
final="${BACKUP_DIR}/${timestamp}"
mkdir -p "${tmp}/state" "${tmp}/config" "${tmp}/vite"

state_files=(
  events.jsonl missions.json scheduler-queue.json approvals.json
  workspace-state.json checkpoints.json endpoint-usage.json
  directive_records.jsonl directive_templates.json
  ledger.duckdb ledger.duckdb.wal
)
for name in "${state_files[@]}"; do
  if [[ -f "${STATE_DIR}/${name}" ]]; then
    cp -a -- "${STATE_DIR}/${name}" "${tmp}/state/${name}"
  fi
done

state_dirs=(sessions run-state working-intentions discovery)
for name in "${state_dirs[@]}"; do
  if [[ -d "${STATE_DIR}/${name}" ]]; then
    cp -a -- "${STATE_DIR}/${name}" "${tmp}/state/${name}"
  fi
done

config_files=(profiles.json repo-roots.json)
for name in "${config_files[@]}"; do
  if [[ -f "${CONFIG_DIR}/${name}" ]]; then
    cp -a -- "${CONFIG_DIR}/${name}" "${tmp}/config/${name}"
  fi
done

if [[ -f "${ROOTS_FILE}" ]]; then
  cp -a -- "${ROOTS_FILE}" "${tmp}/vite/repo-roots.json"
fi

(
  cd "${tmp}"
  find state config vite -type f -print0 \
    | sort -z \
    | xargs -0 sha256sum > SHA256SUMS
)

if [[ -e "${final}" ]]; then
  final="${BACKUP_DIR}/${timestamp}-$$"
fi
mv -- "${tmp}" "${final}"

# Rotate complete snapshots older than 30 days; never inspect outside BACKUP_DIR.
while IFS= read -r -d '' old_snapshot; do
  find "${old_snapshot}" -depth -delete
done < <(find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime +30 -print0)
printf '%s\n' "${final}"
