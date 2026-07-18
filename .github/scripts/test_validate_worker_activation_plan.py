#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / ".github" / "scripts" / "validate-worker-activation-plan.py"


def make_change(address: str, actions: list[str], mode: str = "managed") -> dict:
    return {
        "address": address,
        "mode": mode,
        "change": {
            "actions": actions,
        },
    }


class ValidateWorkerActivationPlanCliTest(unittest.TestCase):
    def run_validator(self, plan: dict, agent_key: str = "bc-intake") -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as temp_dir:
            plan_path = Path(temp_dir) / "plan.json"
            plan_path.write_text(json.dumps(plan), encoding="utf-8")
            return subprocess.run(
                ["python3", str(SCRIPT), "--plan-json", str(plan_path), "--agent-key", agent_key],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )

    def test_allows_target_worker_task_definition_replacement(self) -> None:
        plan = {
            "resource_changes": [
                make_change('aws_ecs_service.workers["bc-intake"]', ["update"]),
                make_change('aws_ecs_task_definition.workers["bc-intake"]', ["delete", "create"]),
            ]
        }

        result = self.run_validator(plan)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"status": "ok"', result.stdout)
        self.assertIn("allowed replacements", result.stdout)

    def test_rejects_delete_for_other_target_worker_resources(self) -> None:
        plan = {
            "resource_changes": [
                make_change('aws_cloudwatch_log_group.workers["bc-intake"]', ["delete", "create"]),
            ]
        }

        result = self.run_validator(plan)

        self.assertEqual(result.returncode, 1)
        self.assertIn("activation plans must not delete resources", result.stderr)

    def test_rejects_changes_for_other_workers(self) -> None:
        plan = {
            "resource_changes": [
                make_change('aws_ecs_task_definition.workers["qualifier"]', ["delete", "create"]),
            ]
        }

        result = self.run_validator(plan)

        self.assertEqual(result.returncode, 1)
        self.assertIn("while targeting 'bc-intake'", result.stderr)


if __name__ == "__main__":
    unittest.main()
