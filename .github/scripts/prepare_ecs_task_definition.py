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
    parser = argparse.ArgumentParser(
        description="Prepare an ECS task-definition registration payload with image overrides."
    )
    parser.add_argument(
        "--source", required=True, help="Path to aws ecs describe-task-definition output JSON"
    )
    parser.add_argument(
        "--container-image",
        action="append",
        default=[],
        metavar="NAME=IMAGE",
        help="Container image override; may be supplied more than once",
    )
    parser.add_argument("--output", required=True, help="Output path for registration JSON")
    return parser.parse_args()


def load_registration_payload(source_path: str) -> dict:
    described = json.loads(Path(source_path).read_text())
    task_definition = described.get("taskDefinition")
    if not isinstance(task_definition, dict):
        raise ValueError("expected describe-task-definition payload with taskDefinition object")

    registration = {
        key: value
        for key, value in task_definition.items()
        if key in ALLOWED_TASK_DEFINITION_KEYS and key != "tags"
    }
    if "containerDefinitions" not in registration:
        raise ValueError("task definition does not contain containerDefinitions")

    tags = described.get("tags")
    if isinstance(tags, list) and tags:
        registration["tags"] = tags
    return registration


def parse_image_overrides(values: list[str]) -> dict[str, str]:
    overrides: dict[str, str] = {}
    for value in values:
        name, separator, image = value.partition("=")
        if not separator or not name.strip() or not image.strip():
            raise ValueError(f"invalid container image override: {value!r}")
        name = name.strip()
        if name in overrides:
            raise ValueError(f"duplicate container image override: {name}")
        overrides[name] = image.strip()
    if not overrides:
        raise ValueError("at least one --container-image override is required")
    return overrides


def replace_container_images(registration: dict, overrides: dict[str, str]) -> None:
    unmatched = set(overrides)
    for container in registration["containerDefinitions"]:
        name = container.get("name")
        if name in overrides:
            container["image"] = overrides[name]
            unmatched.remove(name)
    if unmatched:
        raise ValueError(f"containers not found: {', '.join(sorted(unmatched))}")


def main() -> None:
    args = parse_args()
    try:
        registration = load_registration_payload(args.source)
        overrides = parse_image_overrides(args.container_image)
        replace_container_images(registration, overrides)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        raise SystemExit(str(error)) from error

    Path(args.output).write_text(json.dumps(registration, indent=2) + "\n")


if __name__ == "__main__":
    main()
