#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAMBDA_SRC_DIR="$ROOT_DIR/terraform/lambda/agent_registry"
BUILD_DIR="$ROOT_DIR/terraform/build/agent_registry"
ZIP_PATH="$ROOT_DIR/terraform/build/agent-registry-lambda.zip"
REQUIREMENTS_FILE="$LAMBDA_SRC_DIR/requirements.txt"
VENV_DIR="$(mktemp -d "${TMPDIR:-/tmp}/specter-agent-registry-venv.XXXXXX")"

cleanup() {
  rm -rf "$VENV_DIR"
}

trap cleanup EXIT

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install \
  --quiet \
  --disable-pip-version-check \
  --no-cache-dir \
  --requirement "$REQUIREMENTS_FILE" \
  --target "$BUILD_DIR"

cp "$LAMBDA_SRC_DIR/index.py" "$BUILD_DIR/index.py"

(
  cd "$BUILD_DIR"
  rm -f "$ZIP_PATH"
  zip -qr "$ZIP_PATH" .
)

echo "$ZIP_PATH"
