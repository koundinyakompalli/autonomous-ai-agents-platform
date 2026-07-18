#!/usr/bin/env bash
# local-e2e/teardown.sh — Stop and remove local e2e containers
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

detect_engine() {
  if [[ -n "${CONTAINER_ENGINE:-}" ]]; then
    case "$CONTAINER_ENGINE" in
      docker|podman) ;;
      *)
        echo "ERROR: CONTAINER_ENGINE must be docker or podman, got: $CONTAINER_ENGINE" >&2
        exit 2
        ;;
    esac
  elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    CONTAINER_ENGINE=podman
  elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    CONTAINER_ENGINE=docker
  else
    echo "ERROR: podman compose or docker compose is required." >&2
    exit 1
  fi

  COMPOSE=("$CONTAINER_ENGINE" compose)
}

detect_engine

echo "==> Tearing down local e2e infrastructure..."
"${COMPOSE[@]}" -f "$SCRIPT_DIR/docker-compose.yml" down -v --remove-orphans
echo "==> Teardown complete."
