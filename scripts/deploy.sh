#!/usr/bin/env bash
# Build the production image locally, ship it to the Debian VM over SSH (no
# registry), and (re)start it with docker compose. Map data on the VM lives on a
# bind-mounted volume and is left untouched by deploys.
#
#   scripts/deploy.sh
#
# Config comes from deploy.env (see deploy.env.example). The container's app
# user is uid/gid 1001, so the data dir is chowned to 1001:1001 on the VM.
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
: "${REMOTE_DIR:?set REMOTE_DIR in deploy.env}"
VM_DATA_DIR="${VM_DATA_DIR:-/var/lib/map-tracker}"
IMAGE="${IMAGE:-map-tracker:latest}"
PLATFORM="${PLATFORM:-linux/amd64}"
SSH="${VM_USER}@${VM_HOST}"
SUDO=""; [[ -n "${USE_SUDO:-}" ]] && SUDO="sudo"

echo "==> Building ${IMAGE} for ${PLATFORM}"
docker build --platform "${PLATFORM}" -t "${IMAGE}" .

echo "==> Shipping image to ${SSH} (docker save | ssh | docker load)"
docker save "${IMAGE}" | gzip | ssh "${SSH}" "gunzip | docker load"

echo "==> Preparing remote dirs on ${SSH}"
# -t allocates a TTY so a sudo password prompt works (harmless if sudo is
# passwordless or USE_SUDO is unset).
ssh -t "${SSH}" "
  set -e
  mkdir -p '${REMOTE_DIR}'
  ${SUDO} mkdir -p '${VM_DATA_DIR}/maps'
  ${SUDO} chown -R 1001:1001 '${VM_DATA_DIR}'
"

echo "==> Uploading compose.yaml + .env"
scp compose.yaml "${SSH}:${REMOTE_DIR}/compose.yaml"
ssh "${SSH}" "printf 'MAP_TRACKER_HOST_DATA=%s\n' '${VM_DATA_DIR}' > '${REMOTE_DIR}/.env'"

echo "==> Starting service"
ssh "${SSH}" "cd '${REMOTE_DIR}' && docker compose up -d && docker compose ps"

echo "==> Done. App should be reachable at http://${VM_HOST}:3000"
echo "    Seed existing maps once with: scripts/sync-data.sh"
