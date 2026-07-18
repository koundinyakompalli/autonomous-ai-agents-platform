#!/usr/bin/env python3
import argparse
import json
import re
import sys
from pathlib import Path


# Keep this mapping and normalization behavior aligned with
# src/orchestrator/workers/runtime.ts so workflow-time validation matches
# runtime worker loading in production.
BUILTIN_WORKERS = {
    "DARCI": "DARCI",
    "SCRIBE": "SCRIBE",
    "PRISM": "PRISM",
    "QUALIFIER": "Qualifier",
    "HERMES": "HERMES",
    "SENTRY": "SENTRY",
    "BEACON": "BEACON",
    "BC-INTAKE": "BCIntake",
    "BCAT-PLANNER": "BCATplanner",
    "BCAT-EXECUTOR": "BCATExecutor",
    "VERITAS": "VERITAS",
    "ANVIL": "ANVIL",
    "NOTARY": "NOTARY",
    "SRLOG": "SRLOG",
    "FORGE": "FORGE",
    "LEDGER": "LEDGER",
    "RIFT": "RIFT",
}


def normalize_worker_type(value: str) -> str:
    normalized = re.sub(r"[_\s]+", "-", value.strip())
    normalized = re.sub(r"-+", "-", normalized)
    normalized = normalized.upper()
    if not normalized:
        raise ValueError("worker_type must not be empty")
    return normalized


def to_pascal_case(words: list[str]) -> str:
    return "".join(word.lower().capitalize() for word in words)


def build_candidate_stems(worker_type: str) -> list[str]:
    normalized = normalize_worker_type(worker_type)
    candidates: list[str] = []
    seen: set[str] = set()

    def add_candidate(stem: str) -> None:
        if not stem or stem in seen:
            return
        seen.add(stem)
        candidates.append(stem)

    builtin = BUILTIN_WORKERS.get(normalized)
    if builtin:
        add_candidate(builtin)

    words = [token for token in re.split(r"[^A-Z0-9]+", normalized) if token]
    if words:
        add_candidate(to_pascal_case(words))
        add_candidate("".join(words))

    return candidates


def resolve_worker_entry(worker_type: str, source_root: Path) -> dict:
    normalized = normalize_worker_type(worker_type)
    candidates = build_candidate_stems(normalized)

    for stem in candidates:
        source_file = source_root / f"{stem}Worker.ts"
        if source_file.exists():
            return {
                "normalized_worker_type": normalized,
                "module_stem": stem,
                "source_file": str(source_file),
            }

    attempted = ", ".join(f"{stem}Worker.ts" for stem in candidates) or "none"
    raise FileNotFoundError(
        f"Unable to resolve worker source for {worker_type}. "
        f"Tried: {attempted}. "
        "Custom workers must add a matching file under src/orchestrator/workers."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Resolve a worker source entrypoint from WORKER_TYPE")
    parser.add_argument("--worker-type", required=True)
    parser.add_argument(
        "--source-root",
        default="src/orchestrator/workers",
        help="Directory containing *Worker.ts files",
    )
    args = parser.parse_args()

    result = resolve_worker_entry(args.worker_type, Path(args.source_root))
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # pragma: no cover - CLI error path
        print(str(error), file=sys.stderr)
        sys.exit(1)
