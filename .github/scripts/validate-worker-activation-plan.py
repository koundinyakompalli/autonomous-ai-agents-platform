#!/usr/bin/env python3
import argparse
import json
import re
import sys
from pathlib import Path


WORKER_MANAGED_RESOURCE_PATTERNS = (
    re.compile(r'^aws_ecs_service\.workers\["(?P<key>[^"]+)"\]$'),
    re.compile(r'^aws_ecs_task_definition\.workers\["(?P<key>[^"]+)"\]$'),
    re.compile(r'^aws_cloudwatch_log_group\.workers\["(?P<key>[^"]+)"\]$'),
    re.compile(r'^aws_ecr_repository\.workers\["(?P<key>[^"]+)"\]$'),
    re.compile(r'^aws_ecr_lifecycle_policy\.workers\["(?P<key>[^"]+)"\]$'),
    re.compile(r'^aws_cloudwatch_log_metric_filter\.sdk_stall\["(?P<key>[^"]+)-worker"\]$'),
    re.compile(r'^aws_cloudwatch_metric_alarm\.sdk_stall\["(?P<key>[^"]+)-worker"\]$'),
)

WORKER_DATA_RESOURCE_PATTERNS = (
    re.compile(r'^data\.aws_ecr_image\.workers\["(?P<key>[^"]+)"\]$'),
)


def is_allowed_replacement(address: str, target_agent: str, actions: list[str]) -> bool:
    worker_key = extract_worker_key(
        address,
        (re.compile(r'^aws_ecs_task_definition\.workers\["(?P<key>[^"]+)"\]$'),),
    )
    if worker_key != target_agent:
        return False

    # ECS task definitions are immutable, so digest pinning during activation
    # legitimately shows up as a replacement.
    return sorted(actions) == ["create", "delete"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate that a worker-scoped onboarding/activation plan only affects the intended worker."
    )
    parser.add_argument("--plan-json", required=True, help="Path to terraform show -json output")
    parser.add_argument("--agent-key", required=True, help="Activated worker key")
    return parser.parse_args()


def extract_worker_key(address: str, patterns: tuple[re.Pattern[str], ...]) -> str | None:
    for pattern in patterns:
        match = pattern.match(address)
        if match:
            return match.group("key")
    return None


def main() -> int:
    args = parse_args()
    plan_path = Path(args.plan_json)
    target_agent = args.agent_key.strip().lower()

    with plan_path.open("r", encoding="utf-8") as handle:
        plan = json.load(handle)

    violations: list[str] = []

    for change in plan.get("resource_changes", []):
        address = change.get("address", "<unknown>")
        mode = change.get("mode", "managed")
        actions = change.get("change", {}).get("actions", [])
        if not actions or actions == ["no-op"]:
            continue

        if "delete" in actions and not is_allowed_replacement(address, target_agent, actions):
            violations.append(
                f"{address}: activation plans must not delete resources (actions={actions})"
            )

        if mode == "data":
            worker_key = extract_worker_key(address, WORKER_DATA_RESOURCE_PATTERNS)
            if worker_key != target_agent:
                violations.append(
                    f"{address}: plan must not read data for worker "
                    f"'{worker_key or 'unknown'}' while targeting '{target_agent}'"
                )
            continue

        worker_key = extract_worker_key(address, WORKER_MANAGED_RESOURCE_PATTERNS)
        if worker_key != target_agent:
            violations.append(
                f"{address}: plan must not modify resource "
                f"'{worker_key or 'outside worker scope'}' while targeting '{target_agent}'"
            )

    if violations:
        print("Worker-scoped plan validation failed:", file=sys.stderr)
        for violation in violations:
            print(f"- {violation}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "status": "ok",
                "agent_key": target_agent,
                "message": "Plan only affects the intended worker scope and only uses allowed replacements.",
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
