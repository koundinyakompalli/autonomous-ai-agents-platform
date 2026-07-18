import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  certificationArtifactFromFile,
  createCertificationEvidenceBundle,
  recordCertificationScenarioEvidence,
} from "./certification-evidence.js";
import type {
  CertificationArtifactKind,
  CertificationEvidenceBundle,
  CertificationManifest,
  CertificationScenarioEvidence,
} from "./certification-plan.js";

const DEFAULT_MANIFEST = "artifacts/spec-factory-certification/manifest.json";
const DEFAULT_EVIDENCE = "artifacts/spec-factory-certification/evidence.json";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const manifestPath = value(args, "manifest") ?? DEFAULT_MANIFEST;
  const evidencePath = value(args, "evidence") ?? DEFAULT_EVIDENCE;
  const manifest = await readJson<CertificationManifest>(manifestPath);

  if (command === "init") {
    const bundle = createCertificationEvidenceBundle(manifest);
    await writeJsonAtomically(evidencePath, bundle);
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
    return;
  }
  if (command !== "record") {
    throw new Error("certification_evidence_command_required:init_or_record");
  }

  const bundle = await readJson<CertificationEvidenceBundle>(evidencePath);
  const scenarioId = requiredValue(args, "scenario");
  const status = certificationStatus(requiredValue(args, "status"));
  const startedAt = requiredTimestamp(args, "started-at");
  const completedAt = requiredTimestamp(args, "completed-at");
  const artifactInputs = values(args, "artifact");
  const evidenceDir = path.dirname(path.resolve(evidencePath));
  const artifacts = await Promise.all(
    artifactInputs.map(async (entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error("certification_artifact_format_invalid:kind=path");
      }
      const kind = artifactKind(entry.slice(0, separator));
      const filePath = path.resolve(entry.slice(separator + 1));
      const relativePath = path.relative(evidenceDir, filePath);
      if (
        !relativePath ||
        relativePath.startsWith("..") ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error("certification_artifact_outside_evidence_directory");
      }
      return certificationArtifactFromFile({
        kind,
        filePath,
        uri: relativePath.split(path.sep).join("/"),
      });
    }),
  );
  const scenarioEvidence: CertificationScenarioEvidence = {
    scenarioId,
    status,
    startedAt,
    completedAt,
    artifacts,
    notes: value(args, "notes") ?? undefined,
  };
  const updated = recordCertificationScenarioEvidence({
    manifest,
    bundle,
    evidence: scenarioEvidence,
  });
  await writeJsonAtomically(evidencePath, updated);
  process.stdout.write(`${JSON.stringify(scenarioEvidence, null, 2)}\n`);
}

function certificationStatus(
  raw: string,
): CertificationScenarioEvidence["status"] {
  if (raw === "passed" || raw === "failed" || raw === "blocked") return raw;
  throw new Error(`certification_status_invalid:${raw}`);
}

function artifactKind(raw: string): CertificationArtifactKind {
  if (
    raw === "result" ||
    raw === "logs" ||
    raw === "metrics" ||
    raw === "report"
  ) {
    return raw;
  }
  throw new Error(`certification_artifact_kind_invalid:${raw}`);
}

function requiredTimestamp(args: string[], name: string): string {
  const timestamp = requiredValue(args, name);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`certification_timestamp_invalid:${name}`);
  }
  return timestamp;
}

function requiredValue(args: string[], name: string): string {
  const result = value(args, name);
  if (!result) throw new Error(`certification_argument_required:${name}`);
  return result;
}

function value(args: string[], name: string): string | null {
  return values(args, name).at(-1) ?? null;
}

function values(args: string[], name: string): string[] {
  const prefix = `--${name}=`;
  return args
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJsonAtomically(
  filePath: string,
  valueToWrite: unknown,
): Promise<void> {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(valueToWrite, null, 2)}\n`,
    "utf8",
  );
  await rename(temporary, resolved);
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
