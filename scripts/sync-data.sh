#!/usr/bin/env bash
# One-time (or occasional) seed of locally-ingested maps onto the VM's data
# volume. After this, maps persist on the VM across deploys and new ones can be
# scraped directly from the UI there.
#
#   scripts/sync-data.sh
#
# Config comes from deploy.env (see deploy.env.example). The remote data dir is
# owned by uid 1001 (the container user); with USE_SUDO=1 the remote rsync runs
# under sudo so it can write there.
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

RSYNC_PATH_OPT=()
CHOWN_CMD="true"
if [[ -n "${USE_SUDO:-}" ]]; then
  RSYNC_PATH_OPT=(--rsync-path="sudo rsync")
  CHOWN_CMD="sudo chown -R 1001:1001 '${VM_DATA_DIR}/maps'"
fi

echo "==> Syncing ${LOCAL_DATA_DIR}/maps/ -> ${SSH}:${VM_DATA_DIR}/maps/"
rsync -az --info=progress2 "${RSYNC_PATH_OPT[@]}" \
  "${LOCAL_DATA_DIR}/maps/" "${SSH}:${VM_DATA_DIR}/maps/"

echo "==> Fixing ownership to the container user (uid 1001)"
ssh -t "${SSH}" "${CHOWN_CMD}"

echo "==> Done. Reload the app and the synced maps should appear."
