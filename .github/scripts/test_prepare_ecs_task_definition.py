#!/usr/bin/env python3

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import prepare_ecs_task_definition as subject


class PrepareEcsTaskDefinitionTest(unittest.TestCase):
    def described_task_definition(self) -> dict:
        return {
            "taskDefinition": {
                "taskDefinitionArn": "arn:old",
                "revision": 12,
                "status": "ACTIVE",
                "family": "spec-factory-test",
                "networkMode": "awsvpc",
                "requiresCompatibilities": ["FARGATE"],
                "cpu": "1024",
                "memory": "2048",
                "containerDefinitions": [
                    {"name": "spec-factory", "image": "app:old"},
                    {"name": "compose-markitdown", "image": "markitdown:old"},
                    {"name": "ecs-cwagent", "image": "cwagent:pinned"},
                ],
            },
            "tags": [{"key": "Service", "value": "spec-factory"}],
        }

    def test_builds_registration_payload_and_replaces_multiple_images(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.json"
            source.write_text(json.dumps(self.described_task_definition()))
            registration = subject.load_registration_payload(str(source))

        subject.replace_container_images(
            registration,
            {
                "spec-factory": "registry/app@sha256:new",
                "compose-markitdown": "registry/markitdown@sha256:new",
            },
        )

        self.assertNotIn("taskDefinitionArn", registration)
        self.assertNotIn("revision", registration)
        self.assertNotIn("status", registration)
        self.assertEqual(
            registration["tags"], [{"key": "Service", "value": "spec-factory"}]
        )
        images = {
            container["name"]: container["image"]
            for container in registration["containerDefinitions"]
        }
        self.assertEqual(images["spec-factory"], "registry/app@sha256:new")
        self.assertEqual(images["compose-markitdown"], "registry/markitdown@sha256:new")
        self.assertEqual(images["ecs-cwagent"], "cwagent:pinned")

    def test_rejects_missing_container(self) -> None:
        registration = self.described_task_definition()["taskDefinition"]
        with self.assertRaisesRegex(ValueError, "containers not found: absent"):
            subject.replace_container_images(registration, {"absent": "image:new"})

    def test_rejects_duplicate_and_malformed_overrides(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate"):
            subject.parse_image_overrides(["app=one", "app=two"])
        with self.assertRaisesRegex(ValueError, "invalid"):
            subject.parse_image_overrides(["missing-image="])


if __name__ == "__main__":
    unittest.main()
