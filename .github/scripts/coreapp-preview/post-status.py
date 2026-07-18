#!/usr/bin/env python3

import argparse
import json
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Post OneShot deployment status callback.")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--deployment-id", required=True)
    parser.add_argument("--secret", required=True)
    parser.add_argument("--status", required=True)
    parser.add_argument("--workflow-run-id")
    parser.add_argument("--workflow-url")
    parser.add_argument("--image-uri")
    parser.add_argument("--task-definition-arn")
    parser.add_argument("--preview-url")
    parser.add_argument("--error")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    payload = {
        "status": args.status,
    }

    optional_fields = {
        "workflowRunId": args.workflow_run_id,
        "workflowUrl": args.workflow_url,
        "imageUri": args.image_uri,
        "taskDefinitionArn": args.task_definition_arn,
        "previewUrl": args.preview_url,
        "error": args.error,
    }

    for key, value in optional_fields.items():
        if value not in (None, ""):
            payload[key] = value

    request = urllib.request.Request(
        url=f"{args.base_url.rstrip('/')}/api/oneshot/deployments/{args.deployment_id}/callback",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-oneshot-deploy-secret": args.secret,
        },
        method="POST",
    )

    with urllib.request.urlopen(request) as response:
        if response.status >= 300:
            raise SystemExit(f"Callback failed with status {response.status}")


if __name__ == "__main__":
    main()
