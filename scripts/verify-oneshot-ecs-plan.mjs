#!/usr/bin/env node
import fs from "node:fs";

const planPath = process.argv[2];

if (!planPath) {
  console.error("Usage: node scripts/verify-oneshot-ecs-plan.mjs <terraform-plan.json>");
  process.exit(2);
}

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const errors = [];

function getResourcesFromModule(module, resources = []) {
  for (const resource of module?.resources ?? []) {
    resources.push(resource);
  }
  for (const child of module?.child_modules ?? []) {
    getResourcesFromModule(child, resources);
  }
  return resources;
}

function getPlannedResources() {
  const plannedResources = getResourcesFromModule(plan.planned_values?.root_module);
  if (plannedResources.length > 0) {
    return plannedResources;
  }
  return (plan.resource_changes ?? []).map((change) => ({
    address: change.address,
    type: change.type,
    name: change.name,
    index: change.index,
    values: change.change?.after,
  }));
}

function parseContainerDefinitions(resource) {
  const raw = resource.values?.container_definitions;
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw !== "string") {
    errors.push(`${resource.address}: container_definitions is not a JSON string`);
    return [];
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    errors.push(`${resource.address}: failed to parse container_definitions: ${error.message}`);
    return [];
  }
}

function envMap(container) {
  return new Map(
    (container.environment ?? []).map((entry) => [entry.name, String(entry.value)]),
  );
}

function allMountPoints(resource, containers) {
  return [
    ...(resource.values?.mountPoints ?? []),
    ...containers.flatMap((container) => container.mountPoints ?? []),
  ];
}

function hasSpecterEfsMount(resource, containers) {
  return allMountPoints(resource, containers).some(
    (mount) => mount.containerPath === "/mnt/efs/specter-repo",
  );
}

function taskKey(resource) {
  if (typeof resource.index === "string") {
    return resource.index;
  }
  const match = resource.address?.match(/\["([^"]+)"\]/);
  return match?.[1] ?? resource.name ?? resource.address ?? "";
}

function hasEphemeralStorage(resource) {
  const value = resource.values?.ephemeral_storage;
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

const resources = getPlannedResources().filter(
  (resource) => resource.type === "aws_ecs_task_definition",
);
const taskDefinitions = resources.map((resource) => ({
  resource,
  containers: parseContainerDefinitions(resource),
}));

const oneShotTasks = taskDefinitions.filter(({ resource }) =>
  [
    "aws_ecs_task_definition.oneshot",
    "aws_ecs_task_definition.workers",
    "aws_ecs_task_definition.orchestrator",
  ].some((prefix) => resource.address?.startsWith(prefix)),
);
const oneShotConsumerTasks = taskDefinitions.filter(({ resource }) =>
  resource.address?.startsWith("aws_ecs_task_definition.oneshot"),
);
const dashboardTasks = taskDefinitions.filter(({ resource }) =>
  resource.address?.startsWith("aws_ecs_task_definition.dashboard"),
);

if (oneShotTasks.length === 0) {
  errors.push("No OneShot ECS task definitions were found in the plan JSON");
}
if (dashboardTasks.length === 0) {
  errors.push("No dashboard ECS task definition was found in the plan JSON");
}

const expectedMavenBuildsEnabled = String(
  plan.variables?.oneshot_maven_builds_enabled?.value ?? true,
);

const requiredWorkspaceEnv = new Map([
  ["ONESHOT_WORKSPACE_LEASE_TTL_SECONDS", "2700"],
  ["ONESHOT_WORKSPACE_LEASE_HEARTBEAT_SECONDS", "30"],
  ["ONESHOT_REPO_CACHE_FRESHNESS_TTL_MS", "300000"],
]);

for (const { resource, containers } of oneShotTasks) {
  for (const container of containers) {
    const env = envMap(container);
    for (const [name, expectedValue] of requiredWorkspaceEnv) {
      if (env.get(name) !== expectedValue) {
        errors.push(
          `${resource.address}/${container.name}: expected ${name}=${expectedValue}, got ${env.get(name) ?? "<missing>"}`,
        );
      }
    }

    const key = taskKey(resource);
    if (["implementer", "tester"].includes(key)) {
      if (env.get("ONESHOT_MAVEN_BUILDS_ENABLED") !== expectedMavenBuildsEnabled) {
        errors.push(
          `${resource.address}/${container.name}: expected ONESHOT_MAVEN_BUILDS_ENABLED=${expectedMavenBuildsEnabled}, got ${env.get("ONESHOT_MAVEN_BUILDS_ENABLED") ?? "<missing>"}`,
        );
      }
      if (expectedMavenBuildsEnabled === "false") {
        for (const forbidden of ["ARTIFACTORY_HOST", "MAVEN_USER", "MAVEN_OPTS", "MAVEN_CLI_OPTS"]) {
          if (env.has(forbidden)) {
            errors.push(`${resource.address}/${container.name}: ${forbidden} must not be injected when Maven builds are disabled`);
          }
        }
        for (const secret of container.secrets ?? []) {
          if (secret.name === "MAVEN_PASSWORD" || secret.name === "MAVEN_USER") {
            errors.push(`${resource.address}/${container.name}: ${secret.name} secret must not be injected when Maven builds are disabled`);
          }
        }
      }
    }

    const needsWorkspaceBase =
      resource.address?.startsWith("aws_ecs_task_definition.oneshot") ||
      resource.address?.startsWith("aws_ecs_task_definition.workers");
    if (needsWorkspaceBase) {
      for (const [name, expectedValue] of [
        ["ONESHOT_REPO_ADMIN_BASE", "/mnt/efs/specter-repo/repo-admin"],
        ["ONESHOT_REPO_CACHE_BASE", "/mnt/efs/specter-repo/oneshot/repos"],
        ["ONESHOT_WORKTREE_BASE", "/var/oneshot/workspaces"],
      ]) {
        if (env.get(name) !== expectedValue) {
          errors.push(
            `${resource.address}/${container.name}: expected ${name}=${expectedValue}, got ${env.get(name) ?? "<missing>"}`,
          );
        }
      }
    }
  }

  if (!hasSpecterEfsMount(resource, containers)) {
    errors.push(`${resource.address}: missing /mnt/efs/specter-repo mount`);
  }
}

for (const { resource, containers } of dashboardTasks) {
  for (const container of containers) {
    const env = envMap(container);
    for (const forbidden of [
      "ONESHOT_REPO_ADMIN_BASE",
      "ONESHOT_WORKSPACE_BASE",
      "ONESHOT_REPO_CACHE_BASE",
      "ONESHOT_WORKTREE_BASE",
    ]) {
      if (env.has(forbidden)) {
        errors.push(`${resource.address}/${container.name}: dashboard must not set ${forbidden}`);
      }
    }
  }
  if (hasSpecterEfsMount(resource, containers)) {
    errors.push(`${resource.address}: dashboard must not mount /mnt/efs/specter-repo`);
  }
}

const workspaceEphemeralVariable =
  plan.variables?.oneshot_workspace_local_storage_gib?.value ?? null;
const buildTestEphemeralVariable =
  plan.variables?.oneshot_build_test_ephemeral_storage_gib?.value ?? null;
if (workspaceEphemeralVariable != null) {
  for (const { resource } of oneShotConsumerTasks) {
    if (!hasEphemeralStorage(resource)) {
      errors.push(
        `${resource.address}: expected ephemeral_storage because oneshot_workspace_local_storage_gib is set`,
      );
    }
  }
}
for (const { resource } of taskDefinitions) {
  if (!hasEphemeralStorage(resource)) {
    continue;
  }
  const key = taskKey(resource);
  const ephemeralAllowed =
    workspaceEphemeralVariable != null
      ? resource.address?.startsWith("aws_ecs_task_definition.oneshot")
      : buildTestEphemeralVariable != null &&
        ["implementer", "tester"].includes(key);
  if (workspaceEphemeralVariable == null && buildTestEphemeralVariable == null) {
    errors.push(
      `${resource.address}: ephemeral_storage rendered even though OneShot ephemeral storage variables are null`,
    );
  } else if (!ephemeralAllowed) {
    errors.push(
      `${resource.address}: ephemeral_storage is only allowed on ${workspaceEphemeralVariable != null ? "OneShot local-worktree consumers" : "implementer/tester"}, got ${key}`,
    );
  }
}

if (errors.length > 0) {
  console.error("OneShot ECS plan verification failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("OneShot ECS plan verification passed");
