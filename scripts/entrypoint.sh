#!/bin/bash
# ============================================================================
# Specter Container Entrypoint Script
# ============================================================================
# This script ensures all required environment variables are set before
# starting the application. It can be used as:
# 1. Container entrypoint
# 2. Local development setup script
#
# Usage:
#   ./scripts/entrypoint.sh              # Run orchestrator
#   ./scripts/entrypoint.sh worker       # Run worker
#   ./scripts/entrypoint.sh darci        # Run DARCI worker
# ============================================================================

set -e

# ============================================================================
# REQUIRED: Claude Agent SDK / Bedrock Configuration
# ============================================================================

# Enable Bedrock mode (REQUIRED)
export CLAUDE_CODE_USE_BEDROCK=1

# AWS Region (REQUIRED - Claude Code doesn't read from .aws config)
export AWS_REGION="${AWS_REGION:-us-east-2}"

# Model selection (recommended to set explicitly)
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}"
export ANTHROPIC_SMALL_FAST_MODEL="${ANTHROPIC_SMALL_FAST_MODEL:-us.anthropic.claude-haiku-4-5-20251001-v1:0}"

# Token settings (recommended for Bedrock stability)
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-4096}"
export MAX_THINKING_TOKENS="${MAX_THINKING_TOKENS:-1024}"

# ============================================================================
# AWS Credentials
# ============================================================================
# In ECS, these come automatically from the Task IAM Role
# For local development, you can set them manually:
#
# export AWS_ACCESS_KEY_ID="your-access-key"
# export AWS_SECRET_ACCESS_KEY="your-secret-key"
# export AWS_SESSION_TOKEN="your-session-token"  # If using temporary credentials

# Check if running in ECS (container metadata available)
if [ -n "$ECS_CONTAINER_METADATA_URI_V4" ]; then
    echo "Running in ECS - credentials from Task IAM Role"
elif [ -z "$AWS_ACCESS_KEY_ID" ]; then
    echo "Warning: Not running in ECS and AWS_ACCESS_KEY_ID not set"
    echo "For local development, set AWS credentials in environment"
fi

# ============================================================================
# Application Configuration
# ============================================================================

export NODE_ENV="${NODE_ENV:-production}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

# EFS paths (for repositories)
export EFS_MOUNT_PATH="${EFS_MOUNT_PATH:-/mnt/efs}"
export REPOSITORY_PATH="${REPOSITORY_PATH:-/mnt/efs/repos}"

# ============================================================================
# Print Configuration (for debugging)
# ============================================================================

echo "============================================"
echo "Specter Environment Configuration"
echo "============================================"
echo "CLAUDE_CODE_USE_BEDROCK: $CLAUDE_CODE_USE_BEDROCK"
echo "AWS_REGION: $AWS_REGION"
echo "ANTHROPIC_MODEL: $ANTHROPIC_MODEL"
echo "ANTHROPIC_SMALL_FAST_MODEL: $ANTHROPIC_SMALL_FAST_MODEL"
echo "CLAUDE_CODE_MAX_OUTPUT_TOKENS: $CLAUDE_CODE_MAX_OUTPUT_TOKENS"
echo "MAX_THINKING_TOKENS: $MAX_THINKING_TOKENS"
echo "NODE_ENV: $NODE_ENV"
echo "EFS_MOUNT_PATH: $EFS_MOUNT_PATH"
echo "AWS Credentials: ${AWS_ACCESS_KEY_ID:+SET (hidden)}${AWS_ACCESS_KEY_ID:-NOT SET}"
echo "============================================"

# ============================================================================
# Verify Dependencies
# ============================================================================

echo "Checking dependencies..."

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found"
    exit 1
fi
echo "✓ Node.js $(node --version)"

# Check Git
if ! command -v git &> /dev/null; then
    echo "ERROR: Git not found"
    exit 1
fi
echo "✓ Git $(git --version)"

# Configure git safe.directory for EFS mounted repositories
# This is required when running as a different user than the repo owner
echo "Configuring git safe.directory for EFS repositories..."
git config --global --add safe.directory '*'
echo "✓ Git safe.directory configured (allowing all directories)"

# Check Claude Code CLI
if ! command -v claude &> /dev/null; then
    echo "Warning: Claude Code CLI not found - installing..."
    npm install -g @anthropic-ai/claude-code
fi
echo "✓ Claude Code CLI available"

# Check ripgrep (optional but recommended)
if command -v rg &> /dev/null; then
    echo "✓ ripgrep $(rg --version | head -1)"
else
    echo "○ ripgrep not found (optional)"
fi

echo "============================================"

# ============================================================================
# Start Application
# ============================================================================

MODE="${1:-orchestrator}"

case "$MODE" in
    orchestrator)
        echo "Starting Orchestrator..."
        exec node dist/orchestrator/index.js
        ;;
    worker)
        echo "Starting Worker (type: ${WORKER_TYPE:-DARCI})..."
        exec node dist/worker-main.js
        ;;
    darci)
        export WORKER_TYPE=DARCI
        echo "Starting DARCI Worker..."
        exec node dist/worker-main.js
        ;;
    scribe)
        export WORKER_TYPE=SCRIBE
        echo "Starting SCRIBE Worker..."
        exec node dist/worker-main.js
        ;;
    prism)
        export WORKER_TYPE=PRISM
        echo "Starting PRISM Worker..."
        exec node dist/worker-main.js
        ;;
    hermes)
        export WORKER_TYPE=HERMES
        echo "Starting HERMES Worker..."
        exec node dist/worker-main.js
        ;;
    shell)
        echo "Starting shell (for debugging)..."
        exec /bin/bash
        ;;
    *)
        echo "Unknown mode: $MODE"
        echo "Usage: $0 [orchestrator|worker|darci|scribe|prism|hermes|shell]"
        exit 1
        ;;
esac
