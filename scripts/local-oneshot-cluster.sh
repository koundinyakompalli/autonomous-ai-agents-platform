#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_DIR="$PROJECT_ROOT/local-oneshot"
COMPOSE_FILE="$LOCAL_DIR/docker-compose.yml"

COMMAND="${1:-up}"
shift || true

WITH_ORCHESTRATOR=false
NO_ORCHESTRATOR=false
NO_CONSUMERS=false
NO_DASHBOARD=false
BUILD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-orchestrator)
      WITH_ORCHESTRATOR=true
      ;;
    --no-orchestrator)
      NO_ORCHESTRATOR=true
      ;;
    --no-consumers)
      NO_CONSUMERS=true
      ;;
    --no-dashboard)
      NO_DASHBOARD=true
      ;;
    --build)
      BUILD=true
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

detect_engine() {
  if command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    CONTAINER_ENGINE=podman
    COMPOSE=(podman compose)
    return
  fi
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    CONTAINER_ENGINE=docker
    COMPOSE=(docker compose)
    return
  fi
  echo "ERROR: podman compose or docker compose is required." >&2
  exit 1
}

compose() {
  "${COMPOSE[@]}" -f "$COMPOSE_FILE" "$@"
}

load_env_file() {
  local env_file="$PROJECT_ROOT/.env.local"
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
}

normalize_aws_env_aliases() {
  if [[ -z "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_KEY:-}" ]]; then
    export AWS_ACCESS_KEY_ID="$AWS_KEY"
  fi
  if [[ -z "${AWS_SECRET_ACCESS_KEY:-}" && -n "${AWS_SECRET:-}" ]]; then
    export AWS_SECRET_ACCESS_KEY="$AWS_SECRET"
  fi
}

export_aws_credentials() {
  if [[ -n "${AWS_ACCESS_KEY_ID:-}" && "${AWS_ACCESS_KEY_ID:-}" != "test" ]]; then
    echo "==> Using exported AWS credentials (${AWS_ACCESS_KEY_ID:0:8}...)."
    return
  fi

  if ! command -v aws >/dev/null 2>&1; then
    echo "==> AWS CLI not found; Moto setup and Bedrock-backed stages will not work."
    return
  fi

  echo "==> Exporting AWS credentials for Bedrock-backed local consumers..."
  if eval "$(aws configure export-credentials --format env 2>/dev/null)"; then
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
    echo "    Credentials exported (${AWS_ACCESS_KEY_ID:0:8}...)."
  else
    echo "    Could not export AWS credentials; continuing with Moto-only credentials."
  fi
}

warn_missing_runtime_env() {
  local missing=()
  for name in GITHUB_REPO_TOKEN GITHUB_WRITE_TOKEN OPENAI_API_KEY; do
    if [[ -z "${!name:-}" ]]; then
      missing+=("$name")
    fi
  done

  if [[ "${#missing[@]}" -gt 0 && "$NO_CONSUMERS" != true ]]; then
    echo "==> WARNING: missing runtime env: ${missing[*]}"
    echo "    Consumers may fail validation until these are exported or set in .env.local."
  fi
}

build_images() {
  echo "==> Building TypeScript..."
  npm run build

  if [[ "$NO_DASHBOARD" != true ]]; then
    echo "==> Building dashboard assets..."
    npm --prefix dashboard run build
  fi
}

build_container_images() {
  echo "==> Building local container images..."
  compose build
}

setup_infra() {
  echo "==> Starting local infra..."
  compose up -d --wait mysql moto

  echo "==> Initializing DB, S3, and SQS..."
  CONTAINER_ENGINE="$CONTAINER_ENGINE" bash "$LOCAL_DIR/setup.sh"
}

start_services() {
  local services=()
  if [[ "$NO_DASHBOARD" != true ]]; then
    services+=(dashboard)
  fi
  if [[ "$NO_CONSUMERS" != true ]]; then
    services+=(qualifier planner reviewer implementer code-reviewer tester)
  fi

  if [[ "$NO_ORCHESTRATOR" != true && "$NO_CONSUMERS" != true ]]; then
    if [[ -z "${JIRA_BASE_URL:-}" || -z "${JIRA_USERNAME:-}" || -z "${JIRA_TOKEN:-}" ]]; then
      echo "ERROR: orchestrator requires JIRA_BASE_URL, JIRA_USERNAME, and JIRA_TOKEN." >&2
      echo "       Set them in .env.local, or use --no-orchestrator for consumer-only local runs." >&2
      exit 1
    fi
    services+=(orchestrator)
  fi

  if [[ "$WITH_ORCHESTRATOR" == true ]]; then
    echo "==> Note: orchestrator is included by default; --with-orchestrator is accepted for compatibility."
  fi

  if [[ "${#services[@]}" -gt 0 ]]; then
    compose up -d "${services[@]}"
  fi
}

print_status() {
  echo ""
  echo "Local OneShot cluster:"
  echo "  Dashboard:    http://localhost:${ONESHOT_DASHBOARD_PORT:-3001}/oneshot"
  echo "  MySQL:        localhost:${ONESHOT_LOCAL_MYSQL_PORT:-3307} (root/specter_local, DB Specter)"
  echo "  Moto:         http://localhost:${ONESHOT_MOTO_PORT:-5002}/moto-api/"
  echo "  Health:"
  echo "    planner       http://localhost:${ONESHOT_PLANNER_HEALTH_PORT:-18080}/ready"
  echo "    reviewer      http://localhost:${ONESHOT_REVIEWER_HEALTH_PORT:-18081}/ready"
  echo "    implementer   http://localhost:${ONESHOT_IMPLEMENTER_HEALTH_PORT:-18082}/ready"
  echo "    code-reviewer http://localhost:${ONESHOT_CODE_REVIEWER_HEALTH_PORT:-18083}/ready"
  echo "    tester        http://localhost:${ONESHOT_TESTER_HEALTH_PORT:-18084}/ready"
  echo "    orchestrator  http://localhost:${ONESHOT_ORCHESTRATOR_HEALTH_PORT:-18085}/health"
  echo "    qualifier     http://localhost:${ONESHOT_QUALIFIER_HEALTH_PORT:-18086}/health"
  echo ""
  echo "Useful commands:"
  echo "  scripts/local-oneshot-cluster.sh logs"
  echo "  scripts/local-oneshot-cluster.sh ps"
  echo "  scripts/local-oneshot-cluster.sh down"
}

detect_engine
load_env_file
normalize_aws_env_aliases

case "$COMMAND" in
  up|start)
    export_aws_credentials
    warn_missing_runtime_env
    if [[ "$BUILD" == true ]]; then
      build_images
      build_container_images
    else
      if [[ ! -d "$PROJECT_ROOT/dist" ]]; then
        build_images
      fi
    fi
    setup_infra
    start_services
    print_status
    ;;
  setup)
    setup_infra
    ;;
  build)
    build_images
    build_container_images
    ;;
  ps|status)
    compose ps
    ;;
  logs)
    compose logs -f
    ;;
  down|stop)
    compose down
    ;;
  reset)
    compose down -v
    rm -rf "$LOCAL_DIR/data/workspaces" "$LOCAL_DIR/data/repo-admin"
    mkdir -p "$LOCAL_DIR/data/workspaces" "$LOCAL_DIR/data/repo-admin" "$LOCAL_DIR/data/repositories"
    ;;
  *)
    cat >&2 <<USAGE
Usage: scripts/local-oneshot-cluster.sh [up|down|reset|setup|build|ps|logs] [options]

Options:
  --build              Rebuild TypeScript, dashboard assets, and images before start.
  --with-orchestrator  Compatibility flag; orchestrator is included by default.
  --no-orchestrator    Skip the Jira/dashboard request orchestrator.
  --no-consumers       Start only infra and optional dashboard.
  --no-dashboard       Skip the dashboard container.

The script loads optional local secrets from .env.local.
USAGE
    exit 2
    ;;
esac
