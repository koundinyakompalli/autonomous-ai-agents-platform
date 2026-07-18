#!/usr/bin/env python3

import argparse
import json
from pathlib import Path


ALLOWED_TASK_DEFINITION_KEYS = {
    "family",
    "taskRoleArn",
    "executionRoleArn",
    "networkMode",
    "containerDefinitions",
    "volumes",
    "placementConstraints",
    "requiresCompatibilities",
    "cpu",
    "memory",
    "tags",
    "pidMode",
    "ipcMode",
    "proxyConfiguration",
    "inferenceAccelerators",
    "ephemeralStorage",
    "runtimePlatform",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare an ECS task definition registration payload.")
    parser.add_argument("--source", required=True, help="Path to aws ecs describe-task-definition output JSON")
    parser.add_argument("--container-name", required=True, help="Container definition name to replace")
    parser.add_argument("--image-uri", required=True, help="New container image URI")
    parser.add_argument("--output", required=True, help="Output path for register-task-definition JSON")
    return parser.parse_args()


def load_described_task_definition(source_path: str) -> dict:
    payload = json.loads(Path(source_path).read_text())
    task_definition = payload.get("taskDefinition")
    if not isinstance(task_definition, dict):
        raise SystemExit("Expected describe-task-definition payload with top-level taskDefinition object")
    return task_definition


def sanitize_task_definition(task_definition: dict) -> dict:
    sanitized = {
        key: value
        for key, value in task_definition.items()
        if key in ALLOWED_TASK_DEFINITION_KEYS
    }
    if "containerDefinitions" not in sanitized:
        raise SystemExit("Task definition payload does not contain containerDefinitions")
    return sanitized


def replace_container_image(task_definition: dict, container_name: str, image_uri: str) -> None:
    containers = task_definition["containerDefinitions"]
    replaced = False
    for container in containers:
        if container.get("name") == container_name:
            container["image"] = image_uri
            replaced = True
            break

    if not replaced:
        raise SystemExit(f"Container '{container_name}' was not found in task definition")


def main() -> None:
    args = parse_args()
    task_definition = load_described_task_definition(args.source)
    sanitized = sanitize_task_definition(task_definition)
    replace_container_image(sanitized, args.container_name, args.image_uri)
    Path(args.output).write_text(json.dumps(sanitized, indent=2) + "\n")


if __name__ == "__main__":
    main()
