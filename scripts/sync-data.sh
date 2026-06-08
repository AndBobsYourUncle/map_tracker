#!/usr/bin/env bash
# One-time (or occasional) seed of locally-ingested maps onto the VM's data
# volume. After this, maps persist on the VM across deploys and new ones can be
# scraped directly from the UI there.
#
#   scripts/sync-data.sh
#
# Config comes from deploy.env (see deploy.env.example). The data dir is owned
# by the remote SSH user (the container runs as that uid too), so rsync writes
# directly. Only with USE_SUDO=1 (a root-owned VM_DATA_DIR) does the remote
# rsync/chown run under sudo.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f deploy.env ]]; then
  echo "deploy.env not found. Copy deploy.env.example to deploy.env and fill it in." >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a; source deploy.env; set +a

: "${VM_USER:?set VM_USER in deploy.env}"
: "${VM_HOST:?set VM_HOST in deploy.env}"
VM_DATA_DIR="${VM_DATA_DIR:-/var/lib/map-tracker}"
LOCAL_DATA_DIR="${MAP_TRACKER_DATA_DIR:-./data}"
SSH="${VM_USER}@${VM_HOST}"

if [[ ! -d "${LOCAL_DATA_DIR}/maps" ]]; then
  echo "No local maps at ${LOCAL_DATA_DIR}/maps — nothing to sync." >&2
  exit 1
fi

# The container runs as the remote SSH user, so own the maps as that uid/gid.
read -r RUID RGID < <(ssh "${SSH}" 'echo "$(id -u) $(id -g)"')

RSYNC_PATH_OPT=()
SUDO=""
if [[ -n "${USE_SUDO:-}" ]]; then
  RSYNC_PATH_OPT=(--rsync-path="sudo rsync")
  SUDO="sudo"
fi

echo "==> Syncing ${LOCAL_DATA_DIR}/maps/ -> ${SSH}:${VM_DATA_DIR}/maps/"
rsync -az --info=progress2 "${RSYNC_PATH_OPT[@]}" \
  "${LOCAL_DATA_DIR}/maps/" "${SSH}:${VM_DATA_DIR}/maps/"

echo "==> Fixing ownership to the container user (${RUID}:${RGID})"
ssh -t "${SSH}" "${SUDO} chown -R ${RUID}:${RGID} '${VM_DATA_DIR}/maps'"

echo "==> Done. Reload the app and the synced maps should appear."
