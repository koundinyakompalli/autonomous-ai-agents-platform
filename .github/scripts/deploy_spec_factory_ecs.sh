#!/usr/bin/env bash

set -Eeuo pipefail

release_sha="${1:-${SPEC_FACTORY_RELEASE_SHA:-}}"
aws_region="${AWS_REGION:-us-east-2}"
cluster="${SPEC_FACTORY_ECS_CLUSTER:-specter-cluster}"
registry="${ECR_REGISTRY:-}"
dry_run="${SPEC_FACTORY_DEPLOY_DRY_RUN:-false}"

if [[ ! "${release_sha}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Release SHA must be a full 40-character lowercase Git commit SHA." >&2
  exit 2
fi
if [[ -z "${registry}" ]]; then
  echo "ECR_REGISTRY is required." >&2
  exit 2
fi
if [[ "${dry_run}" != "true" && "${dry_run}" != "false" ]]; then
  echo "SPEC_FACTORY_DEPLOY_DRY_RUN must be true or false." >&2
  exit 2
fi

export AWS_DEFAULT_REGION="${aws_region}"

account_id="$(aws sts get-caller-identity --query Account --output text)"
expected_registry="${account_id}.dkr.ecr.${aws_region}.amazonaws.com"
if [[ "${registry}" != "${expected_registry}" ]]; then
  echo "ECR_REGISTRY ${registry} does not match authenticated account ${expected_registry}." >&2
  exit 2
fi

services=(
  SPEC-FACTORY
  SPEC-FACTORY-WORKER
  SPEC-FACTORY-TURN
  SPEC-FACTORY-CONTEXT
  SPEC-FACTORY-RESEARCH
  SPEC-FACTORY-CONVERSION
  SPEC-FACTORY-DRAFT
  SPEC-FACTORY-RELAY
  SPEC-FACTORY-RETENTION
)

repositories_by_service=(
  specter/spec-factory-api
  specter/spec-factory
  specter/spec-factory
  specter/spec-factory
  specter/spec-factory-research
  specter/spec-factory-conversion
  specter/spec-factory
  specter/spec-factory
  specter/spec-factory
)

resolve_image() {
  local repository="$1"
  local digest
  digest="$(aws ecr describe-images \
    --repository-name "${repository}" \
    --image-ids "imageTag=${release_sha}" \
    --query 'imageDetails[0].imageDigest' \
    --output text)"
  if [[ ! "${digest}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "Could not resolve immutable digest for ${repository}:${release_sha}." >&2
    return 1
  fi
  printf '%s/%s@%s' "${registry}" "${repository}" "${digest}"
}

api_image="$(resolve_image specter/spec-factory-api)"
core_image="$(resolve_image specter/spec-factory)"
research_image="$(resolve_image specter/spec-factory-research)"
conversion_image="$(resolve_image specter/spec-factory-conversion)"
markitdown_image="$(resolve_image specter/compose-markitdown)"

image_for_repository() {
  case "$1" in
    specter/spec-factory-api) printf '%s' "${api_image}" ;;
    specter/spec-factory) printf '%s' "${core_image}" ;;
    specter/spec-factory-research) printf '%s' "${research_image}" ;;
    specter/spec-factory-conversion) printf '%s' "${conversion_image}" ;;
    *) echo "Unsupported Spec Factory repository: $1" >&2; return 1 ;;
  esac
}

temporary_directory="$(mktemp -d)"
previous_task_definitions=()
deployed_task_definitions=()
updated_service_indexes=()

on_exit() {
  local status=$?
  trap - EXIT
  if (( status != 0 && ${#updated_service_indexes[@]} > 0 )); then
    echo "Deployment failed; restoring previous task definitions." >&2
    rollback_services=()
    for service_index in "${updated_service_indexes[@]}"; do
      service="${services[${service_index}]}"
      rollback_services+=("${service}")
      aws ecs update-service \
        --cluster "${cluster}" \
        --service "${service}" \
        --task-definition "${previous_task_definitions[${service_index}]}" \
        --query 'service.taskDefinition' \
        --output text >&2 || true
    done
    aws ecs wait services-stable \
      --cluster "${cluster}" \
      --services "${rollback_services[@]}" || true
  fi
  exit "${status}"
}
trap on_exit EXIT

for service_index in "${!services[@]}"; do
  service="${services[${service_index}]}"
  service_payload="$(aws ecs describe-services \
    --cluster "${cluster}" \
    --services "${service}" \
    --output json)"
  if [[ "$(jq '.failures | length' <<<"${service_payload}")" != "0" ]]; then
    echo "ECS service lookup failed for ${service}." >&2
    jq '.failures' <<<"${service_payload}" >&2
    exit 1
  fi

  current_task_definition="$(jq -r '.services[0].taskDefinition // empty' <<<"${service_payload}")"
  if [[ -z "${current_task_definition}" ]]; then
    echo "ECS service ${service} has no task definition." >&2
    exit 1
  fi
  previous_task_definitions["${service_index}"]="${current_task_definition}"

  source_payload="${temporary_directory}/${service}-current.json"
  registration_payload="${temporary_directory}/${service}-register.json"
  aws ecs describe-task-definition \
    --task-definition "${current_task_definition}" \
    --include TAGS \
    --output json > "${source_payload}"

  app_repository="${repositories_by_service[${service_index}]}"
  app_image="$(image_for_repository "${app_repository}")"
  prepare_arguments=(
    --source "${source_payload}"
    --container-image "spec-factory=${app_image}"
    --output "${registration_payload}"
  )
  if [[ "${service}" == "SPEC-FACTORY" || "${service}" == "SPEC-FACTORY-CONVERSION" ]]; then
    prepare_arguments+=(
      --container-image "compose-markitdown=${markitdown_image}"
    )
  fi

  python3 .github/scripts/prepare_ecs_task_definition.py "${prepare_arguments[@]}"
  if [[ "${dry_run}" == "true" ]]; then
    aws ecs register-task-definition \
      --cli-input-json "file://${registration_payload}" \
      --generate-cli-skeleton output > /dev/null
    deployed_task_definitions["${service_index}"]="dry-run:${current_task_definition}"
    echo "Validated ${service} from ${current_task_definition}."
    continue
  fi

  new_task_definition="$(aws ecs register-task-definition \
    --cli-input-json "file://${registration_payload}" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)"
  if [[ -z "${new_task_definition}" || "${new_task_definition}" == "None" ]]; then
    echo "Task-definition registration failed for ${service}." >&2
    exit 1
  fi
  deployed_task_definitions["${service_index}"]="${new_task_definition}"

  aws ecs update-service \
    --cluster "${cluster}" \
    --service "${service}" \
    --task-definition "${new_task_definition}" \
    --query 'service.taskDefinition' \
    --output text
  updated_service_indexes+=("${service_index}")
done

if [[ "${dry_run}" == "true" ]]; then
  trap - EXIT
  echo "Validated Spec Factory release ${release_sha} against ${cluster}; no ECS resources were changed."
  exit 0
fi

aws ecs wait services-stable \
  --cluster "${cluster}" \
  --services "${services[@]}"

for service_index in "${!services[@]}"; do
  service="${services[${service_index}]}"
  service_payload="$(aws ecs describe-services \
    --cluster "${cluster}" \
    --services "${service}" \
    --output json)"
  current_task_definition="$(jq -r '.services[0].taskDefinition // empty' <<<"${service_payload}")"
  if [[ "${current_task_definition}" != "${deployed_task_definitions[${service_index}]}" ]]; then
    echo "ECS service ${service} did not retain the deployed task definition." >&2
    exit 1
  fi
  desired_count="$(jq -r '.services[0].desiredCount' <<<"${service_payload}")"
  running_count="$(jq -r '.services[0].runningCount' <<<"${service_payload}")"
  pending_count="$(jq -r '.services[0].pendingCount' <<<"${service_payload}")"
  if [[ "${desired_count}" != "${running_count}" || "${pending_count}" != "0" ]]; then
    echo "ECS service ${service} is not stable after deployment." >&2
    exit 1
  fi
done

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Spec Factory ECS deployment"
    echo "- Cluster: \`${cluster}\`"
    echo "- Release: \`${release_sha}\`"
    echo "- Image policy: immutable ECR digests"
    echo ""
    echo "| Service | Task definition |"
    echo "| --- | --- |"
    for service_index in "${!services[@]}"; do
      service="${services[${service_index}]}"
      echo "| \`${service}\` | \`${deployed_task_definitions[${service_index}]}\` |"
    done
  } >> "${GITHUB_STEP_SUMMARY}"
fi

trap - EXIT
echo "Spec Factory release ${release_sha} is stable on ${cluster}."
