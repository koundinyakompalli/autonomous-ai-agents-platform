#!/usr/bin/env bash
# local-e2e/run.sh — One-command: start infra, setup, run integration test, teardown
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

  export CONTAINER_ENGINE
  COMPOSE=("$CONTAINER_ENGINE" compose)
}

cleanup() {
  echo ""
  echo "==> Cleaning up..."
  bash "$SCRIPT_DIR/teardown.sh"
}
trap cleanup EXIT

detect_engine

echo "==> Starting local e2e infrastructure with $CONTAINER_ENGINE compose..."
"${COMPOSE[@]}" -f "$SCRIPT_DIR/docker-compose.yml" up -d --wait

echo "==> Running setup..."
bash "$SCRIPT_DIR/setup.sh"

echo "==> Running integration test..."
cd "$PROJECT_ROOT"
ONESHOT_E2E=1 npx vitest run src/oneshot/e2e/pipeline.integration.test.ts --reporter=verbose

echo ""
echo "==> All tests passed!"
