import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import {
  SPEC_FACTORY_CERTIFICATION_ARTIFACT_KINDS,
  SPEC_FACTORY_CERTIFICATION_SCHEMA_VERSION,
  type CertificationArtifactEvidence,
  type CertificationArtifactKind,
  type CertificationEvidenceBundle,
  type CertificationManifest,
  type CertificationScenarioEvidence,
} from "./certification-plan.js";

const ARTIFACT_KINDS = new Set<CertificationArtifactKind>([
  ...SPEC_FACTORY_CERTIFICATION_ARTIFACT_KINDS,
]);

export function createCertificationEvidenceBundle(
  manifest: CertificationManifest,
): CertificationEvidenceBundle {
  assertManifestShape(manifest);
  return {
    schemaVersion: manifest.schemaVersion,
    manifestId: manifest.manifestId,
    releaseSha: manifest.releaseSha,
    environment: manifest.environment,
    scenarios: [],
  };
}

export async function certificationArtifactFromFile(input: {
  kind: CertificationArtifactKind;
  filePath: string;
  uri: string;
}): Promise<CertificationArtifactEvidence> {
  if (!ARTIFACT_KINDS.has(input.kind)) {
    throw new Error(`certification_artifact_kind_invalid:${input.kind}`);
  }
  if (!input.uri.trim()) throw new Error("certification_artifact_uri_required");
  if (!isBundleRelativeUri(input.uri)) {
    throw new Error("certification_artifact_uri_outside_bundle");
  }
  const file = await open(input.filePath, "r");
  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile()) {
      throw new Error("certification_artifact_file_empty_or_invalid");
    }
    const content = await file.readFile();
    if (content.byteLength <= 0) {
      throw new Error("certification_artifact_file_empty_or_invalid");
    }
    return {
      kind: input.kind,
      uri: input.uri.trim(),
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
    };
  } finally {
    await file.close();
  }
}

export async function verifyCertificationArtifactFiles(
  bundle: CertificationEvidenceBundle,
  evidenceDirectory: string,
): Promise<string[]> {
  const errors: string[] = [];
  const base = path.resolve(evidenceDirectory);
  for (const scenario of bundle.scenarios) {
    for (const artifact of scenario.artifacts) {
      if (!isBundleRelativeUri(artifact.uri)) {
        errors.push(`${scenario.scenarioId}:artifact_uri_outside_bundle`);
        continue;
      }
      const filePath = path.resolve(base, artifact.uri);
      if (!isPathInside(base, filePath)) {
        errors.push(`${scenario.scenarioId}:artifact_uri_outside_bundle`);
        continue;
      }
      try {
        const content = await readFile(filePath);
        if (content.byteLength !== artifact.bytes) {
          errors.push(`${scenario.scenarioId}:artifact_size_mismatch`);
        }
        const sha256 = createHash("sha256").update(content).digest("hex");
        if (sha256 !== artifact.sha256) {
          errors.push(`${scenario.scenarioId}:artifact_checksum_mismatch`);
        }
      } catch {
        errors.push(`${scenario.scenarioId}:artifact_unreadable`);
      }
    }
  }
  return errors;
}

export function recordCertificationScenarioEvidence(input: {
  manifest: CertificationManifest;
  bundle: CertificationEvidenceBundle;
  evidence: CertificationScenarioEvidence;
}): CertificationEvidenceBundle {
  assertBundleMatchesManifest(input.manifest, input.bundle);
  if (
    !input.manifest.scenarios.some(
      (scenario) => scenario.id === input.evidence.scenarioId,
    )
  ) {
    throw new Error(
      `certification_scenario_unknown:${input.evidence.scenarioId}`,
    );
  }
  if (
    input.bundle.scenarios.some(
      (entry) => entry.scenarioId === input.evidence.scenarioId,
    )
  ) {
    throw new Error(
      `certification_scenario_already_recorded:${input.evidence.scenarioId}`,
    );
  }
  return {
    ...input.bundle,
    scenarios: [...input.bundle.scenarios, input.evidence].sort((left, right) =>
      left.scenarioId.localeCompare(right.scenarioId),
    ),
  };
}

export function assertBundleMatchesManifest(
  manifest: CertificationManifest,
  bundle: CertificationEvidenceBundle,
): void {
  assertManifestShape(manifest);
  if (
    bundle.schemaVersion !== manifest.schemaVersion ||
    bundle.manifestId !== manifest.manifestId ||
    bundle.releaseSha !== manifest.releaseSha ||
    bundle.environment !== manifest.environment
  ) {
    throw new Error("certification_evidence_manifest_mismatch");
  }
}

function assertManifestShape(manifest: CertificationManifest): void {
  if (
    manifest.schemaVersion !== SPEC_FACTORY_CERTIFICATION_SCHEMA_VERSION ||
    !manifest.manifestId
  ) {
    throw new Error("certification_manifest_schema_invalid");
  }
}

function isBundleRelativeUri(uri: string): boolean {
  const trimmed = uri.trim();
  return (
    Boolean(trimmed) &&
    !path.isAbsolute(trimmed) &&
    !trimmed.split(/[\\/]/).includes("..") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  );
}

function isPathInside(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}
