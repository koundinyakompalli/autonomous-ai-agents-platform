#!/usr/bin/env bash
#
# Publish OneShot prompt and guardrail assets to S3 with version pinning.
#
# Usage:
#   ./scripts/publish-oneshot-prompts.sh <bucket> [prefix]
#
# Prerequisites:
#   - S3 versioning must be enabled on the target bucket
#   - AWS CLI v2 with valid credentials
#
# What it does:
#   1. Uploads all .md files from oneshot-prompts/prompts/ and
#      oneshot-prompts/guardrails/ to S3
#   2. Captures returned S3 VersionIds from each upload
#   3. Builds a manifest JSON mapping logical names to { key, versionId }
#   4. Uploads the manifest to S3
#   5. Prints the manifest VersionId for use in
#      ONESHOT_PROMPT_MANIFEST_VERSION_ID
#
# Example:
#   ./scripts/publish-oneshot-prompts.sh specter-results oneshot
#   # => export ONESHOT_PROMPT_MANIFEST_VERSION_ID=<version-id>

set -euo pipefail

BUCKET="${1:?Usage: $0 <bucket> [prefix]}"
PREFIX="${2:-oneshot}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ASSET_DIR="$REPO_ROOT/oneshot-prompts"

if [ ! -d "$ASSET_DIR" ]; then
  echo "ERROR: Asset directory not found at $ASSET_DIR" >&2
  exit 1
fi

MANIFEST_ASSETS="{}"
CREATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

upload_assets() {
  local asset_type="$1"
  local asset_dir="$ASSET_DIR/$asset_type"

  if [ ! -d "$asset_dir" ]; then
    echo "WARN: No $asset_type directory found at $asset_dir, skipping" >&2
    return
  fi

  for file in "$asset_dir"/*.md; do
    [ -f "$file" ] || continue

    local logical_name
    logical_name="$(basename "$file" .md)"
    local s3_key="$PREFIX/$asset_type/$logical_name.md"

    echo "  Uploading $asset_type/$logical_name -> s3://$BUCKET/$s3_key"

    local upload_output
    upload_output="$(aws s3api put-object \
      --bucket "$BUCKET" \
      --key "$s3_key" \
      --body "$file" \
      --content-type "text/markdown" \
      --output json 2>&1)"

    local version_id
    version_id="$(echo "$upload_output" | python3 -c "import sys,json; print(json.load(sys.stdin).get('VersionId',''))" 2>/dev/null || echo "")"

    if [ -z "$version_id" ]; then
      echo "ERROR: Failed to get VersionId for $s3_key. Is versioning enabled?" >&2
      echo "  Upload output: $upload_output" >&2
      exit 1
    fi

    local qualified_name="$asset_type/$logical_name"
    MANIFEST_ASSETS="$(echo "$MANIFEST_ASSETS" | python3 -c "
import sys, json
assets = json.load(sys.stdin)
assets['$qualified_name'] = {'key': '$s3_key', 'versionId': '$version_id'}
json.dump(assets, sys.stdout)
")"

    echo "    VersionId: $version_id"
  done
}

echo "Publishing OneShot prompt assets to s3://$BUCKET/$PREFIX/"
echo ""

echo "Uploading prompts..."
upload_assets "prompts"

echo ""
echo "Uploading guardrails..."
upload_assets "guardrails"

echo ""
echo "Building manifest..."

MANIFEST_JSON="$(python3 -c "
import json, sys
assets = json.loads('$MANIFEST_ASSETS')
manifest = {
    'version': '$CREATED_AT',
    'createdAt': '$CREATED_AT',
    'assets': assets,
}
json.dump(manifest, sys.stdout, indent=2)
")"

MANIFEST_KEY="$PREFIX/manifest.json"
MANIFEST_TMP="$(mktemp)"
echo "$MANIFEST_JSON" > "$MANIFEST_TMP"

echo "  Uploading manifest -> s3://$BUCKET/$MANIFEST_KEY"

MANIFEST_UPLOAD="$(aws s3api put-object \
  --bucket "$BUCKET" \
  --key "$MANIFEST_KEY" \
  --body "$MANIFEST_TMP" \
  --content-type "application/json" \
  --output json 2>&1)"

rm -f "$MANIFEST_TMP"

MANIFEST_VERSION_ID="$(echo "$MANIFEST_UPLOAD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('VersionId',''))" 2>/dev/null || echo "")"

if [ -z "$MANIFEST_VERSION_ID" ]; then
  echo "ERROR: Failed to get manifest VersionId. Is versioning enabled?" >&2
  exit 1
fi

echo ""
echo "============================================"
echo "Publish complete!"
echo ""
echo "Assets: $(echo "$MANIFEST_ASSETS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")"
echo "Manifest: s3://$BUCKET/$MANIFEST_KEY"
echo "Manifest VersionId: $MANIFEST_VERSION_ID"
echo ""
echo "Set this env var for deployment:"
echo ""
echo "  export ONESHOT_PROMPT_MANIFEST_VERSION_ID=$MANIFEST_VERSION_ID"
echo "============================================"
