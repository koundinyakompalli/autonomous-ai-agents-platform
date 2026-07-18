#!/usr/bin/env bash
#
# Repository bootstrap script for Specter EFS.
# Run this from a bastion/debug host after mounting the shared EFS volume.
#
# Required environment:
#   GITHUB_APP_INSTALLATION_TOKEN   GitHub App installation token with read access to the mhk-repos repos
#
# Optional environment:
#   REPO_BASE           Defaults to /mnt/efs/specter-repo/repositories
#   GITHUB_OWNER        Defaults to mhk-repos
#

set -euo pipefail

REPO_BASE="${REPO_BASE:-/mnt/efs/specter-repo/repositories}"
GITHUB_OWNER="${GITHUB_OWNER:-mhk-repos}"

if [[ -z "${GITHUB_APP_INSTALLATION_TOKEN:-}" ]]; then
  echo "GITHUB_APP_INSTALLATION_TOKEN is required." >&2
  echo "Export a GitHub App installation token with read access to the ${GITHUB_OWNER} repositories and rerun." >&2
  exit 1
fi

AUTH_HEADER="$(printf 'x-access-token:%s' "${GITHUB_APP_INSTALLATION_TOKEN}" | base64 | tr -d '\n')"

COMMON_VERSION_BRANCHES=("3.20" "3.19" "3.18" "3.17" "3.16" "3.15" "3.14" "3.13" "3.12" "3.11")

declare -A REPO_URLS=(
  ["core-app"]="https://github.com/${GITHUB_OWNER}/cp-medhok-monorepo.git"
  ["client-services"]="https://github.com/${GITHUB_OWNER}/cp-client-services-monorepo.git"
  ["batch-jobs"]="https://github.com/${GITHUB_OWNER}/cp-batch-monorepo.git"
  ["provider-portal"]="https://github.com/${GITHUB_OWNER}/cp-provider-portal.git"
  ["React-based-new-ui"]="https://github.com/${GITHUB_OWNER}/cp-mhk-smart-prominence.git"
  ["Ai-agents"]="https://github.com/${GITHUB_OWNER}/enterprise-ai-agent-platform.git"
  ["Document-ai"]="https://github.com/${GITHUB_OWNER}/document-ai.git"
  ["mp-web"]="https://github.com/${GITHUB_OWNER}/mp-web.git"
  ["mp-product-client-configs"]="https://github.com/${GITHUB_OWNER}/mp-product-client-configs.git"
)

declare -A DEFAULT_BRANCHES=(
  ["core-app"]="master"
  ["client-services"]="master"
  ["batch-jobs"]="master"
  ["provider-portal"]="master"
  ["React-based-new-ui"]="master"
  ["Ai-agents"]="main"
  ["Document-ai"]="main"
  ["mp-web"]="master"
  ["mp-product-client-configs"]="main"
)

declare -A VERSIONED_BRANCH_PREFIXES=(
  ["core-app"]="medhok-monorepo"
  ["client-services"]="client-services-monorepo"
  ["batch-jobs"]="batch-monorepo"
  ["provider-portal"]="provider-portal"
)

git_auth() {
  git \
    -c credential.helper= \
    -c core.askPass=true \
    -c "http.extraheader=AUTHORIZATION: basic ${AUTH_HEADER}" \
    "$@"
}

ensure_origin_url() {
  local repo_dir="$1"
  local repo_url="$2"
  git -C "${repo_dir}" remote set-url origin "${repo_url}"
}

ensure_default_branch_checkout() {
  local repo_dir="$1"
  local default_branch="$2"

  if git -C "${repo_dir}" show-ref --verify --quiet "refs/heads/${default_branch}"; then
    git -C "${repo_dir}" checkout "${default_branch}" >/dev/null 2>&1
    return
  fi

  if git -C "${repo_dir}" show-ref --verify --quiet "refs/remotes/origin/${default_branch}"; then
    git -C "${repo_dir}" checkout -B "${default_branch}" "origin/${default_branch}" >/dev/null 2>&1
    return
  fi

  echo "  WARNING: default branch ${default_branch} was not found locally or on origin." >&2
}

clone_or_update_repo() {
  local repo_name="$1"
  local repo_url="$2"
  local default_branch="$3"
  local repo_dir="${REPO_BASE}/${repo_name}"

  mkdir -p "${repo_dir}"

  if [[ -d "${repo_dir}/.git" ]]; then
    echo "  Repository already exists, fetching latest refs..."
    ensure_origin_url "${repo_dir}" "${repo_url}"
    git_auth -C "${repo_dir}" fetch --all --tags --prune
  else
    echo "  Cloning repository..."
    rm -rf "${repo_dir:?}/"*
    git_auth clone --no-single-branch "${repo_url}" "${repo_dir}"
    ensure_origin_url "${repo_dir}" "${repo_url}"
  fi

  ensure_default_branch_checkout "${repo_dir}" "${default_branch}"
}

ensure_remote_branch_ref() {
  local repo_dir="$1"
  local remote_branch="$2"

  git_auth -C "${repo_dir}" fetch origin \
    "refs/heads/${remote_branch}:refs/remotes/origin/${remote_branch}" \
    --no-tags >/dev/null 2>&1
}

ensure_worktree() {
  local repo_name="$1"
  local remote_prefix="$2"
  local branch_version="$3"
  local repo_dir="${REPO_BASE}/${repo_name}"
  local remote_branch="${remote_prefix}-${branch_version}"
  local worktree_path="${repo_dir}/${branch_version}"

  if ! ensure_remote_branch_ref "${repo_dir}" "${remote_branch}"; then
    echo "  Branch ${remote_branch} not found on origin, skipping."
    return
  fi

  if [[ -d "${worktree_path}" ]]; then
    echo "  Updating worktree ${branch_version} from ${remote_branch}..."
    git_auth -C "${worktree_path}" pull origin "${remote_branch}" >/dev/null 2>&1 || {
      echo "  WARNING: failed to pull ${remote_branch} in ${worktree_path}." >&2
    }
    return
  fi

  if ! git -C "${repo_dir}" show-ref --verify --quiet "refs/heads/${remote_branch}"; then
    git -C "${repo_dir}" branch --track "${remote_branch}" "origin/${remote_branch}" >/dev/null 2>&1 || true
  fi

  echo "  Creating worktree ${branch_version} from ${remote_branch}..."
  git -C "${repo_dir}" worktree add "${worktree_path}" "${remote_branch}" >/dev/null 2>&1 || {
    echo "  WARNING: failed to create worktree ${branch_version} from ${remote_branch}." >&2
  }
}

echo "========================================="
echo "Specter Repository Setup"
echo "========================================="
echo "Base directory: ${REPO_BASE}"
echo "GitHub owner:   ${GITHUB_OWNER}"
echo ""

mkdir -p "${REPO_BASE}"
cd "${REPO_BASE}"

for repo_name in "${!REPO_URLS[@]}"; do
  repo_url="${REPO_URLS[$repo_name]}"
  default_branch="${DEFAULT_BRANCHES[$repo_name]:-main}"

  echo ""
  echo "Setting up ${repo_name}"
  echo "  URL: ${repo_url}"
  echo "  Default branch: ${default_branch}"

  clone_or_update_repo "${repo_name}" "${repo_url}" "${default_branch}"

  if [[ -n "${VERSIONED_BRANCH_PREFIXES[$repo_name]:-}" ]]; then
    branch_prefix="${VERSIONED_BRANCH_PREFIXES[$repo_name]}"
    echo "  Preparing versioned worktrees..."
    for branch_version in "${COMMON_VERSION_BRANCHES[@]}"; do
      ensure_worktree "${repo_name}" "${branch_prefix}" "${branch_version}"
    done
  else
    echo "  No versioned worktrees required."
  fi

  echo "  ${repo_name} ready"
done

echo ""
echo "Creating task workspace directory..."
mkdir -p "${REPO_BASE}/tasks"

echo ""
echo "========================================="
echo "Repository setup complete"
echo "========================================="
echo ""
echo "Repository structure:"
echo "${REPO_BASE}/"
echo "|-- core-app/                 (default branch in base folder)"
echo "|   |-- 3.20/                 (worktree)"
echo "|   `-- ..."
echo "|-- client-services/"
echo "|-- batch-jobs/"
echo "|-- provider-portal/"
echo "|-- React-based-new-ui/"
echo "|-- Ai-agents/"
echo "|-- Document-ai/"
echo "|-- mp-web/"
echo "|-- mp-product-client-configs/"
echo "`-- tasks/                    (task workspace symlinks)"
echo ""
echo "Storage usage:"
du -sh "${REPO_BASE}" 2>/dev/null || echo "Run 'du -sh ${REPO_BASE}' to check"
echo ""
echo "Next steps:"
echo "1. Workers will create task workspaces automatically."
echo "2. Workers will create additional worktrees on demand."
echo "3. Start or redeploy the required agent services."
