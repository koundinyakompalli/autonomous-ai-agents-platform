#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


ROOT_KEY = "additional_worker_agents"


def load_catalog(path: Path) -> dict:
    if not path.exists():
        return {ROOT_KEY: {}}

    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    if not isinstance(data, dict):
        raise ValueError("Catalog file must contain a JSON object")

    agents = data.get(ROOT_KEY)
    if agents is None:
        data[ROOT_KEY] = {}
    elif not isinstance(agents, dict):
        raise ValueError(f"{ROOT_KEY} must be a JSON object")

    return data


def write_catalog(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")


def normalize_agent_key(value: str) -> str:
    key = value.strip().lower()
    if not key:
        raise ValueError("agent_key must not be empty")
    return key


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage the tracked Terraform worker-agent catalog")
    parser.add_argument("--file", required=True, help="Path to additional-worker-agents.auto.tfvars.json")

    subparsers = parser.add_subparsers(dest="command", required=True)

    upsert = subparsers.add_parser("upsert", help="Add or update an additional worker agent")
    upsert.add_argument("--agent-key", required=True)
    upsert.add_argument("--cpu", required=True)
    upsert.add_argument("--memory", required=True)
    upsert.add_argument("--desired-count", required=True, type=int)

    set_desired_count = subparsers.add_parser("set-desired-count", help="Update desired_count for an existing agent")
    set_desired_count.add_argument("--agent-key", required=True)
    set_desired_count.add_argument("--desired-count", required=True, type=int)

    args = parser.parse_args()
    catalog_path = Path(args.file)
    catalog = load_catalog(catalog_path)
    agents = catalog[ROOT_KEY]

    if args.command == "upsert":
        key = normalize_agent_key(args.agent_key)
        agents[key] = {
            "cpu": str(args.cpu),
            "memory": str(args.memory),
            "desired_count": int(args.desired_count),
        }
        write_catalog(catalog_path, catalog)
        print(json.dumps({"agent_key": key, "agent": agents[key]}, indent=2, sort_keys=True))
        return

    key = normalize_agent_key(args.agent_key)
    if key not in agents:
        raise KeyError(
            f"Agent key not found in catalog: {key}. "
            "Merge the onboarding catalog PR or add the agent with the upsert command first."
        )

    agents[key]["desired_count"] = int(args.desired_count)
    write_catalog(catalog_path, catalog)
    print(json.dumps({"agent_key": key, "agent": agents[key]}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
