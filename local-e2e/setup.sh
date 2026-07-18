#!/usr/bin/env bash
# local-e2e/setup.sh — Wait for services, apply schema + migrations, create S3 bucket
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3307}"
MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_PASS="${MYSQL_PASS:-specter_e2e}"
MYSQL_DB="${MYSQL_DB:-Specter}"

LOCALSTACK_ENDPOINT="${LOCALSTACK_ENDPOINT:-http://127.0.0.1:4566}"
S3_BUCKET="${S3_BUCKET:-specter-results}"

# Resolve mysql client from Homebrew if not in PATH
MYSQL_BIN="$(command -v mysql 2>/dev/null || echo "")"
MYSQLADMIN_BIN="$(command -v mysqladmin 2>/dev/null || echo "")"
if [ -z "$MYSQL_BIN" ] && [ -d "/opt/homebrew/opt/mysql-client/bin" ]; then
  MYSQL_BIN="/opt/homebrew/opt/mysql-client/bin/mysql"
  MYSQLADMIN_BIN="/opt/homebrew/opt/mysql-client/bin/mysqladmin"
fi
if [ -z "$MYSQL_BIN" ]; then
  echo "ERROR: mysql client not found. Install with: brew install mysql-client" >&2
  exit 1
fi

echo "==> Waiting for MySQL..."
for i in $(seq 1 30); do
  if "$MYSQLADMIN_BIN" ping -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASS" --silent 2>/dev/null; then
    echo "    MySQL is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: MySQL did not become ready in time." >&2
    exit 1
  fi
  sleep 1
done

echo "==> Waiting for LocalStack S3..."
for i in $(seq 1 20); do
  if curl -sf "${LOCALSTACK_ENDPOINT}/_localstack/health" >/dev/null 2>&1; then
    echo "    LocalStack is ready."
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "ERROR: LocalStack did not become ready in time." >&2
    exit 1
  fi
  sleep 1
done

echo "==> Applying schema.sql..."
"$MYSQL_BIN" -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASS" "$MYSQL_DB" < "$PROJECT_ROOT/db/schema.sql"

echo "==> Seeding e2e agent rows..."
"$MYSQL_BIN" -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASS" "$MYSQL_DB" <<'SQL'
INSERT INTO agents (name, description, task_type, model, jql, is_active) VALUES
(
  'CODE_REVIEWER',
  'OneShot code reviewer queue consumer',
  'oneshot_code_review',
  'gpt-5.4',
  '',
  FALSE
),
(
  'TESTER',
  'OneShot tester queue consumer (deterministic, no LLM)',
  'oneshot_testing',
  'none',
  '',
  FALSE
)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  task_type = VALUES(task_type),
  model = VALUES(model),
  jql = VALUES(jql),
  updated_at = CURRENT_TIMESTAMP;
SQL

echo "==> Creating S3 bucket: $S3_BUCKET"
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-2 \
  aws --endpoint-url "$LOCALSTACK_ENDPOINT" s3 mb "s3://$S3_BUCKET" 2>/dev/null || true

echo "==> Setup complete."
