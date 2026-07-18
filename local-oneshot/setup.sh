#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENGINE="${CONTAINER_ENGINE:-podman}"
MYSQL_CONTAINER="${ONESHOT_MYSQL_CONTAINER:-specter-oneshot-mysql}"
REGION="${AWS_REGION:-us-east-2}"
BUCKET="${ONESHOT_ARTIFACT_BUCKET:-specter-local-results}"
TASK_BUCKET="${ONESHOT_TASK_BUCKET:-${S3_BUCKET_PREFIX:-specter-local}-tasks}"
MOTO_ENDPOINT="${ONESHOT_MOTO_ENDPOINT:-http://127.0.0.1:${ONESHOT_MOTO_PORT:-5002}}"

mysql_exec() {
  "$ENGINE" exec -i "$MYSQL_CONTAINER" mysql -uroot -pspecter_local "$@"
}

aws_moto() {
  if ! command -v aws >/dev/null 2>&1; then
    echo "ERROR: aws CLI is required to initialize Moto S3/SQS resources." >&2
    exit 1
  fi
  AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" \
    AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}" \
    AWS_DEFAULT_REGION="$REGION" \
    aws --endpoint-url "$MOTO_ENDPOINT" "$@"
}

wait_for_mysql() {
  echo "==> Waiting for MySQL..."
  for _ in $(seq 1 60); do
    if "$ENGINE" exec "$MYSQL_CONTAINER" mysqladmin ping -h localhost -pspecter_local --silent >/dev/null 2>&1; then
      echo "    MySQL is ready."
      return
    fi
    sleep 2
  done
  echo "ERROR: MySQL did not become ready." >&2
  exit 1
}

wait_for_moto() {
  echo "==> Waiting for Moto..."
  for _ in $(seq 1 60); do
    if curl -sf "$MOTO_ENDPOINT/moto-api/" >/dev/null 2>&1; then
      echo "    Moto is ready."
      return
    fi
    sleep 2
  done
  echo "ERROR: Moto did not become ready at $MOTO_ENDPOINT." >&2
  exit 1
}

create_fifo_queue() {
  local name="$1"
  local visibility_timeout="$2"
  local dlq_name="${name%.fifo}-dlq.fifo"

  local dlq_arn
  aws_moto sqs create-queue \
    --queue-name "$dlq_name" \
    --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"true\",\"VisibilityTimeout\":\"$visibility_timeout\",\"MessageRetentionPeriod\":\"1209600\"}" \
    --region "$REGION" >/dev/null

  dlq_arn="$(aws_moto sqs get-queue-attributes \
    --queue-url "$MOTO_ENDPOINT/000000000000/$dlq_name" \
    --attribute-names QueueArn \
    --region "$REGION" \
    --query 'Attributes.QueueArn' \
    --output text)"

  aws_moto sqs create-queue \
    --queue-name "$name" \
    --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"$visibility_timeout\",\"MessageRetentionPeriod\":\"345600\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}" \
    --region "$REGION" >/dev/null
}

seed_database() {
  local existing_tables
  existing_tables="$(mysql_exec -Nse "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'Specter' AND table_name = 'oneshot_runs';")"
  if [[ "$existing_tables" == "0" ]]; then
    echo "==> Applying db/schema.sql..."
    mysql_exec < "$PROJECT_ROOT/db/schema.sql"
  else
    echo "==> Existing Specter schema detected; skipping db/schema.sql. Use reset to rebuild from scratch."
  fi

  echo "==> Seeding local OneShot agent rows..."
  mysql_exec Specter <<SQL
INSERT INTO agents (name, description, task_type, model, jql, jira_token, jira_username, is_active) VALUES
  ('QUALIFIER', 'PFOS Qualification & OneShot Control-Plane Entry', 'qualification', 'us.anthropic.claude-sonnet-4-6', 'labels = PFOS ORDER BY updated DESC', '${JIRA_TOKEN:-local-jira-token}', '${JIRA_USERNAME:-local@example.com}', TRUE),
  ('CODE_REVIEWER', 'OneShot code reviewer queue consumer', 'oneshot_code_review', 'gpt-5.4', '', '${JIRA_TOKEN:-local-jira-token}', '${JIRA_USERNAME:-local@example.com}', FALSE),
  ('TESTER', 'OneShot tester queue consumer', 'oneshot_testing', 'none', '', '${JIRA_TOKEN:-local-jira-token}', '${JIRA_USERNAME:-local@example.com}', FALSE)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  task_type = VALUES(task_type),
  model = VALUES(model),
  jql = VALUES(jql),
  jira_token = VALUES(jira_token),
  jira_username = VALUES(jira_username),
  is_active = CASE WHEN name = 'QUALIFIER' THEN TRUE ELSE is_active END,
  updated_at = CURRENT_TIMESTAMP;

UPDATE agents
   SET jira_token = COALESCE(NULLIF('${JIRA_TOKEN:-}', ''), jira_token),
       jira_username = COALESCE(NULLIF('${JIRA_USERNAME:-}', ''), jira_username)
WHERE name IN ('QUALIFIER', 'PLANNER', 'REVIEWER', 'IMPLEMENTER', 'CODE_REVIEWER', 'TESTER');
SQL
}

apply_local_migrations() {
  echo "==> Applying local OneShot migrations..."
  mysql_exec Specter < "$PROJECT_ROOT/db/migrations/036_oneshot_trace_verify_artifacts.sql"
}

create_moto_resources() {
  echo "==> Creating S3 bucket: $BUCKET"
  aws_moto s3 mb "s3://$BUCKET" --region "$REGION" >/dev/null 2>&1 || true
  echo "==> Creating S3 bucket: $TASK_BUCKET"
  aws_moto s3 mb "s3://$TASK_BUCKET" --region "$REGION" >/dev/null 2>&1 || true

  echo "==> Creating OneShot SQS queues..."
  create_fifo_queue oneshot-planning.fifo 1200
  create_fifo_queue oneshot-review.fifo 900
  create_fifo_queue oneshot-implementation.fifo 5400
  create_fifo_queue oneshot-code-review.fifo 3600
  create_fifo_queue oneshot-testing.fifo 1800
}

mkdir -p \
  "$SCRIPT_DIR/data/repo-admin" \
  "$SCRIPT_DIR/data/repositories" \
  "$SCRIPT_DIR/data/workspaces"

wait_for_mysql
wait_for_moto
seed_database
apply_local_migrations
create_moto_resources

echo "==> Local OneShot setup complete."
