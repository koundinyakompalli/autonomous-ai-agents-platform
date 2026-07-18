#!/usr/bin/env zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPO_ROOT=${SCRIPT_DIR:h}
cd "$REPO_ROOT"

function load_env_file() {
  local file=$1
  if [[ -f "$file" ]]; then
    set -a
    source "$file"
    set +a
  fi
}

function prompt_value() {
  local __var_name=$1
  local prompt=$2
  local default_value=${3:-}
  local value

  if [[ "${COCKPIT_ATTENDED_ASSUME_DEFAULTS:-false}" == "true" ]]; then
    typeset -g "$__var_name=$default_value"
    return
  fi

  if [[ -n "$default_value" ]]; then
    read -r "?${prompt} [${default_value}]: " value
    value=${value:-$default_value}
  else
    read -r "?${prompt}: " value
  fi
  typeset -g "$__var_name=$value"
}

function prompt_secret() {
  local __var_name=$1
  local prompt=$2
  local value
  local stty_state

  printf "%s: " "$prompt" >&2
  stty_state=$(stty -g)
  stty -echo
  IFS= read -r value
  stty "$stty_state"
  printf "\n" >&2
  typeset -g "$__var_name=$value"
}

function prompt_secret_if_missing() {
  local __var_name=$1
  local prompt=$2
  local current_value="${(P)__var_name-}"

  if [[ -n "$current_value" ]]; then
    return
  fi
  if [[ "${COCKPIT_ATTENDED_ASSUME_DEFAULTS:-false}" == "true" ]]; then
    return
  fi
  prompt_secret "$__var_name" "$prompt"
}

function require_non_empty() {
  local value=$1
  local name=$2
  if [[ -z "$value" ]]; then
    print -u2 "$name is required."
    exit 1
  fi
}

function require_command() {
  local command_name=$1
  if ! command -v "$command_name" >/dev/null 2>&1; then
    print -u2 "Required command not found: $command_name"
    exit 1
  fi
}

function wait_for_server() {
  local url=$1
  local attempts=40

  local attempt
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    if command -v curl >/dev/null 2>&1 && curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  print -u2 "Dashboard API did not become healthy at $url"
  return 1
}

function close_ssh_master() {
  if [[ -n "${OPENED_SSH_DESTINATION:-}" && -n "${INVESTIGATION_SSH_CONTROL_PATH:-}" ]]; then
    ssh -S "$INVESTIGATION_SSH_CONTROL_PATH" -O exit -p "${INVESTIGATION_SSH_PORT:-22}" "$OPENED_SSH_DESTINATION" >/dev/null 2>&1 || true
  fi
}

function cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  close_ssh_master
}

trap cleanup EXIT INT TERM

require_command npm
require_command ssh

load_env_file "$REPO_ROOT/.env"
load_env_file "$REPO_ROOT/.env.local"
load_env_file "$REPO_ROOT/dashboard/.env"
load_env_file "$REPO_ROOT/dashboard/.env.local"

DEFAULT_JIRA_BASE_URL=${JIRA_BASE_URL:-https://mhkjira.atlassian.net}
DEFAULT_JIRA_USERNAME=${JIRA_USERNAME:-${USER:-operator}@mhk.com}
DEFAULT_OPERATOR_ID=${DASHBOARD_LIVE_INVESTIGATION_OPERATOR_ID:-${USER:-operator}}
DEFAULT_OPERATOR_NAME=${DASHBOARD_LIVE_INVESTIGATION_OPERATOR_NAME:-${USER:-Operator}}
DEFAULT_DB_USERNAME=${INVESTIGATION_DB_USERNAME:-${USER:-operator}}
DEFAULT_SSH_USERNAME=${INVESTIGATION_SSH_USER:-${DEFAULT_DB_USERNAME}}
DEFAULT_CONTROL_PATH=${INVESTIGATION_SSH_CONTROL_PATH:-/tmp/cockpit-${DEFAULT_SSH_USERNAME}-ldap-ssh.sock}
DEFAULT_SERVER_PORT=${PORT:-3012}
DEFAULT_UI_PORT=${DASHBOARD_LIVE_PORT:-5174}
DEFAULT_AWS_PROFILE=${INVESTIGATION_AWS_PROFILE:-${AWS_PROFILE:-}}
DEFAULT_LLM_AWS_PROFILE=${INVESTIGATION_LLM_AWS_PROFILE:-${AWS_PROFILE:-}}
DEFAULT_LLM_MODEL=${INVESTIGATION_LLM_MODEL_ID:-${ANTHROPIC_MODEL:-${BEDROCK_MODEL:-${BEDROCK_MODEL_ID:-us.anthropic.claude-sonnet-4-6}}}}
if [[ ! "$DEFAULT_LLM_MODEL" =~ '^[A-Za-z0-9._:/-]+$' ]]; then
  DEFAULT_LLM_MODEL=us.anthropic.claude-sonnet-4-6
fi
DEFAULT_LLM_REGION=${INVESTIGATION_LLM_AWS_REGION:-${BEDROCK_AWS_REGION:-us-east-2}}
DEFAULT_AWS_REGIONS=${INVESTIGATION_AWS_DISCOVERY_REGIONS:-${AWS_REGION:-us-east-2}}
DEFAULT_ROLE_HINTS=${INVESTIGATION_AWS_DISCOVERY_ROLE_HINTS:-login,app,web,batch}
DEFAULT_TARGETS_FILE=${INVESTIGATION_TARGETS_FILE:-}
DEFAULT_SSH_PROBE_ROOTS=${INVESTIGATION_SSH_CONFIG_PROBE_ROOTS:-/opt/software/medhok,/usr/local/medhok,/home/medhok}

print "Investigation Cockpit attended launcher"
print "Credentials are held only in this process tree for this operator session."
print "After startup, use the UI with Jira key only for each ticket."
print ""

prompt_value JIRA_BASE_URL "Jira base URL" "$DEFAULT_JIRA_BASE_URL"
prompt_value JIRA_USERNAME "Jira username" "$DEFAULT_JIRA_USERNAME"
prompt_secret_if_missing JIRA_TOKEN "Jira API token"

prompt_value OPERATOR_ID "Operator id" "$DEFAULT_OPERATOR_ID"
prompt_value OPERATOR_NAME "Operator display name" "$DEFAULT_OPERATOR_NAME"

prompt_value INVESTIGATION_DB_USERNAME "LDAP DB username" "$DEFAULT_DB_USERNAME"
prompt_secret_if_missing INVESTIGATION_DB_PASSWORD "LDAP DB password"

require_non_empty "$JIRA_TOKEN" "Jira API token"
require_non_empty "$INVESTIGATION_DB_USERNAME" "LDAP DB username"
require_non_empty "$INVESTIGATION_DB_PASSWORD" "LDAP DB password"

prompt_value INVESTIGATION_SSH_USER "LDAP SSH username" "$DEFAULT_SSH_USERNAME"
prompt_value INVESTIGATION_SSH_CONTROL_PATH "LDAP SSH ControlPath" "$DEFAULT_CONTROL_PATH"
prompt_value SSH_MASTER_HOST "LDAP SSH host for Cockpit/Meridian tunnel (optional hostname/IP)" "${INVESTIGATION_SSH_HOST:-${INVESTIGATION_SSH_MASTER_HOST:-}}"
prompt_value INVESTIGATION_SSH_PORT "LDAP SSH port" "${INVESTIGATION_SSH_PORT:-22}"
prompt_value INVESTIGATION_DB_REMOTE_HOST "Remote DB host for Meridian LDAP SSH tunnel (optional)" "${INVESTIGATION_DB_REMOTE_HOST:-${MERIDIAN_DB_REMOTE_HOST:-}}"
prompt_value INVESTIGATION_DB_REMOTE_PORT "Remote DB port for Meridian LDAP SSH tunnel" "${INVESTIGATION_DB_REMOTE_PORT:-${MERIDIAN_DB_REMOTE_PORT:-${INVESTIGATION_DB_PORT:-3306}}}"

prompt_value INVESTIGATION_AWS_PROFILE "AWS profile for attended discovery" "$DEFAULT_AWS_PROFILE"
prompt_value INVESTIGATION_LLM_AWS_PROFILE "AWS profile for Bedrock LLM (separate from client discovery)" "$DEFAULT_LLM_AWS_PROFILE"
prompt_value INVESTIGATION_LLM_MODEL_ID "Bedrock LLM model/inference profile" "$DEFAULT_LLM_MODEL"
prompt_value INVESTIGATION_LLM_AWS_REGION "Bedrock LLM region" "$DEFAULT_LLM_REGION"
prompt_value INVESTIGATION_AWS_DISCOVERY_REGIONS "AWS discovery regions" "$DEFAULT_AWS_REGIONS"
prompt_value INVESTIGATION_AWS_DISCOVERY_ROLE_HINTS "AWS discovery role hints" "$DEFAULT_ROLE_HINTS"
prompt_value INVESTIGATION_TARGETS_FILE "Investigation targets file (optional)" "$DEFAULT_TARGETS_FILE"
prompt_value INVESTIGATION_SSH_CONFIG_PROBE_ROOTS "LDAP SSH config probe roots" "$DEFAULT_SSH_PROBE_ROOTS"

prompt_value PORT "Dashboard API port" "$DEFAULT_SERVER_PORT"
prompt_value DASHBOARD_LIVE_PORT "Dashboard UI port" "$DEFAULT_UI_PORT"

export NODE_ENV=${NODE_ENV:-development}
export TMPDIR=${TMPDIR:-/private/tmp}
export JIRA_BASE_URL
export JIRA_USERNAME
export JIRA_TOKEN
export DASHBOARD_OPERATOR_ID_HEADER=${DASHBOARD_OPERATOR_ID_HEADER:-x-operator-id}
export DASHBOARD_OPERATOR_NAME_HEADER=${DASHBOARD_OPERATOR_NAME_HEADER:-x-operator-name}
export DASHBOARD_LIVE_INVESTIGATION_OPERATOR_ID="$OPERATOR_ID"
export DASHBOARD_LIVE_INVESTIGATION_OPERATOR_NAME="$OPERATOR_NAME"
export INVESTIGATION_REQUIRE_OPERATOR_DB_CREDENTIALS=true
export INVESTIGATION_DB_USERNAME
export INVESTIGATION_DB_PASSWORD
export INVESTIGATION_OPERATOR_SSH_PASSWORD=${INVESTIGATION_OPERATOR_SSH_PASSWORD:-$INVESTIGATION_DB_PASSWORD}
export INVESTIGATION_SSH_USER
export INVESTIGATION_SSH_CONTROL_PATH
export INVESTIGATION_SSH_PORT
export INVESTIGATION_SSH_CONFIG_PROBE_ROOTS
if [[ -n "$SSH_MASTER_HOST" ]]; then
  export SSH_MASTER_HOST
  export INVESTIGATION_SSH_HOST=${INVESTIGATION_SSH_HOST:-$SSH_MASTER_HOST}
  export INVESTIGATION_SSH_MASTER_HOST=${INVESTIGATION_SSH_MASTER_HOST:-$SSH_MASTER_HOST}
fi
if [[ -n "$INVESTIGATION_DB_REMOTE_HOST" ]]; then
  export INVESTIGATION_DB_REMOTE_HOST
  export MERIDIAN_DB_REMOTE_HOST=${MERIDIAN_DB_REMOTE_HOST:-$INVESTIGATION_DB_REMOTE_HOST}
fi
if [[ -n "$INVESTIGATION_DB_REMOTE_PORT" ]]; then
  export INVESTIGATION_DB_REMOTE_PORT
  export MERIDIAN_DB_REMOTE_PORT=${MERIDIAN_DB_REMOTE_PORT:-$INVESTIGATION_DB_REMOTE_PORT}
fi
export INVESTIGATION_AWS_INFER_HOST_TARGETS=${INVESTIGATION_AWS_INFER_HOST_TARGETS:-true}
export INVESTIGATION_AWS_PROFILE
export INVESTIGATION_LLM_AWS_PROFILE
export INVESTIGATION_LLM_MODEL_ID
export INVESTIGATION_LLM_AWS_REGION
export INVESTIGATION_AWS_DISCOVERY_REGIONS
export INVESTIGATION_AWS_DISCOVERY_ROLE_HINTS
export INVESTIGATION_SSM_FILE_LOGS_ENABLED=${INVESTIGATION_SSM_FILE_LOGS_ENABLED:-false}
export INVESTIGATION_HOST_SSM_POSTURE_ENABLED=${INVESTIGATION_HOST_SSM_POSTURE_ENABLED:-false}
export INVESTIGATION_QUEUE_AUTOSTART=${INVESTIGATION_QUEUE_AUTOSTART:-true}
export INVESTIGATION_WORKER_CONCURRENCY=${INVESTIGATION_WORKER_CONCURRENCY:-2}
export INVESTIGATION_TARGET_THROTTLE_STORE=${INVESTIGATION_TARGET_THROTTLE_STORE:-auto}
export INVESTIGATION_LLM_PLANNER_ENABLED=${INVESTIGATION_LLM_PLANNER_ENABLED:-true}
export INVESTIGATION_LLM_PLANNER_MAX_CALLS=${INVESTIGATION_LLM_PLANNER_MAX_CALLS:-4}
export INVESTIGATION_LLM_PLANNER_TIMEOUT_MS=${INVESTIGATION_LLM_PLANNER_TIMEOUT_MS:-60000}
export INVESTIGATION_LLM_MAX_TURNS=${INVESTIGATION_LLM_MAX_TURNS:-3}
export INVESTIGATION_LLM_MAX_OUTPUT_TOKENS=${INVESTIGATION_LLM_MAX_OUTPUT_TOKENS:-4096}
export INVESTIGATION_MAX_PLANNING_ITERATIONS=${INVESTIGATION_MAX_PLANNING_ITERATIONS:-8}
export INVESTIGATION_ADAPTER_TIMEOUT_MS=${INVESTIGATION_ADAPTER_TIMEOUT_MS:-60000}
export PORT
export DASHBOARD_LIVE_PORT

export MERIDIAN_REQUIRE_OPERATOR_DB_CREDENTIALS=${MERIDIAN_REQUIRE_OPERATOR_DB_CREDENTIALS:-true}
export MERIDIAN_SSH_USER=${MERIDIAN_SSH_USER:-$INVESTIGATION_SSH_USER}
export MERIDIAN_SSH_CONTROL_PATH=${MERIDIAN_SSH_CONTROL_PATH:-$INVESTIGATION_SSH_CONTROL_PATH}
export MERIDIAN_SSH_PORT=${MERIDIAN_SSH_PORT:-$INVESTIGATION_SSH_PORT}
export MERIDIAN_DB_USERNAME=${MERIDIAN_DB_USERNAME:-$INVESTIGATION_DB_USERNAME}
export MERIDIAN_DB_PASSWORD=${MERIDIAN_DB_PASSWORD:-$INVESTIGATION_DB_PASSWORD}
export MERIDIAN_DB_DATABASE=${MERIDIAN_DB_DATABASE:-${INVESTIGATION_DB_DATABASE:-medhok}}

if [[ -n "$INVESTIGATION_TARGETS_FILE" ]]; then
  export INVESTIGATION_TARGETS_FILE
fi

if [[ "${COCKPIT_ATTENDED_VALIDATE_ONLY:-false}" == "true" ]]; then
  print "Attended launcher configuration validated."
  print "API port: ${PORT}"
  print "UI port: ${DASHBOARD_LIVE_PORT}"
  print "Jira user: ${JIRA_USERNAME}"
  print "Operator: ${OPERATOR_ID} / ${OPERATOR_NAME}"
  print "LDAP DB user: ${INVESTIGATION_DB_USERNAME}"
  print "LDAP SSH user: ${INVESTIGATION_SSH_USER}"
  print "LDAP SSH host: ${INVESTIGATION_SSH_HOST:-<not configured>}"
  print "LDAP SSH ControlPath: ${INVESTIGATION_SSH_CONTROL_PATH}"
  print "Meridian remote DB host: ${INVESTIGATION_DB_REMOTE_HOST:-<not configured>}"
  print "Meridian remote DB port: ${INVESTIGATION_DB_REMOTE_PORT:-<not configured>}"
  print "AWS profile: ${INVESTIGATION_AWS_PROFILE:-<default>}"
  print "Bedrock LLM AWS profile: ${INVESTIGATION_LLM_AWS_PROFILE:-<ambient task role/default>}"
  print "Bedrock LLM planner enabled: ${INVESTIGATION_LLM_PLANNER_ENABLED}"
  print "Bedrock LLM model: ${INVESTIGATION_LLM_MODEL_ID}"
  print "Bedrock LLM region: ${INVESTIGATION_LLM_AWS_REGION}"
  print "AWS discovery regions: ${INVESTIGATION_AWS_DISCOVERY_REGIONS}"
  print "Investigation targets file: ${INVESTIGATION_TARGETS_FILE:-<configured/inferred>}"
  exit 0
fi

if [[ -n "$SSH_MASTER_HOST" ]]; then
  mkdir -p "${INVESTIGATION_SSH_CONTROL_PATH:h}"
  OPENED_SSH_DESTINATION="${INVESTIGATION_SSH_USER}@${SSH_MASTER_HOST}"
  print "Opening LDAP SSH control master for ${OPENED_SSH_DESTINATION}."
  print "If prompted, enter your LDAP SSH password. The password is handled by ssh, not stored by Cockpit."
  ssh -fN -M -S "$INVESTIGATION_SSH_CONTROL_PATH" \
    -o ControlMaster=yes \
    -o ControlPersist=8h \
    -o StrictHostKeyChecking=accept-new \
    -p "$INVESTIGATION_SSH_PORT" \
    "$OPENED_SSH_DESTINATION"
fi

print ""
print "Starting Investigation Cockpit API on http://127.0.0.1:${PORT}"
print "Investigation planner: enabled=${INVESTIGATION_LLM_PLANNER_ENABLED}, profile=${INVESTIGATION_LLM_AWS_PROFILE:-<ambient task role/default>}, model=${INVESTIGATION_LLM_MODEL_ID}, region=${INVESTIGATION_LLM_AWS_REGION}"
npm --prefix dashboard run dev:server &
SERVER_PID=$!

wait_for_server "http://127.0.0.1:${PORT}/health"

UI_URL="http://127.0.0.1:${DASHBOARD_LIVE_PORT}/investigation"
print "Starting Investigation Cockpit UI at ${UI_URL}"
if [[ "${OPEN_COCKPIT:-true}" == "true" && "$OSTYPE" == darwin* ]]; then
  (sleep 2 && open "$UI_URL" >/dev/null 2>&1) &
fi

npm --prefix dashboard run dev:live -- \
  --port="$DASHBOARD_LIVE_PORT" \
  --investigation-target="http://127.0.0.1:${PORT}" \
  --investigation-operator-id="$OPERATOR_ID" \
  --investigation-operator-name="$OPERATOR_NAME"
