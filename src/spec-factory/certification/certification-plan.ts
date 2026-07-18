import { createHash } from "node:crypto";

export const SPEC_FACTORY_CERTIFICATION_SCHEMA_VERSION = 2;
export const SPEC_FACTORY_CERTIFICATION_MANIFEST_ID_PREFIX = "sfv4-manifest-";
export const SPEC_FACTORY_CERTIFICATION_ARTIFACT_KINDS = [
  "result",
  "logs",
  "metrics",
  "report",
] as const;

export type CertificationCategory =
  | "functional"
  | "load"
  | "chaos"
  | "security"
  | "disaster_recovery";

export interface CertificationScenario {
  id: string;
  category: CertificationCategory;
  description: string;
  execution: "automated" | "operator";
  command: string;
  successCriteria: string[];
  requiredEvidence: string[];
}

export interface CertificationManifest {
  schemaVersion: number;
  manifestId: string;
  releaseSha: string;
  environment: string;
  generatedAt: string;
  scenarios: CertificationScenario[];
}

export type CertificationArtifactKind =
  (typeof SPEC_FACTORY_CERTIFICATION_ARTIFACT_KINDS)[number];

export interface CertificationArtifactEvidence {
  kind: CertificationArtifactKind;
  uri: string;
  sha256: string;
  bytes: number;
}

export interface CertificationScenarioEvidence {
  scenarioId: string;
  status: "passed" | "failed" | "blocked";
  startedAt: string;
  completedAt: string;
  artifacts: CertificationArtifactEvidence[];
  metrics?: Record<string, number | string | boolean | null>;
  notes?: string;
}

export interface CertificationEvidenceBundle {
  schemaVersion: number;
  manifestId: string;
  releaseSha: string;
  environment: string;
  scenarios: CertificationScenarioEvidence[];
}

export interface CertificationEvaluation {
  certificationId: string | null;
  passed: boolean;
  evaluatedAt: string;
  missingScenarioIds: string[];
  failedScenarioIds: string[];
  invalidEvidence: string[];
}

export const SPEC_FACTORY_CERTIFICATION_SCENARIOS: CertificationScenario[] = [
  scenario(
    "functional.idempotent-turn",
    "functional",
    "Same idempotency key and body returns the same turn; a changed body returns 409.",
  ),
  scenario(
    "functional.session-ordering",
    "functional",
    "Distinct sessions execute concurrently while turns within one session remain ordered.",
  ),
  scenario(
    "functional.worker-fence",
    "functional",
    "Worker termination around provider and commit boundaries cannot create duplicate final output.",
  ),
  scenario(
    "functional.archive-fence",
    "functional",
    "Archive at every stage prevents authoritative post-archive writes.",
  ),
  scenario(
    "functional.cumulative-context",
    "functional",
    "A child context retains parent facts except explicit removals and records conflicts.",
  ),
  scenario(
    "functional.source-removal",
    "functional",
    "Deleting a source creates provenance-preserving context removal operations.",
  ),
  scenario(
    "functional.handoff-watermark",
    "functional",
    "The immutable handoff includes all messages and source revisions through its frozen watermarks.",
  ),
  scenario(
    "functional.draft-resume",
    "functional",
    "A failed durable draft stage resumes without rerunning successful stages.",
  ),
  scenario(
    "functional.sqs-redelivery",
    "functional",
    "SQS duplicate delivery is a fenced no-op after completion.",
  ),
  scenario(
    "functional.sse-replay",
    "functional",
    "API replica loss reconnects through durable replay without gaps or duplicates.",
  ),
  scenario(
    "load.sse-design",
    "load",
    "Sustain 5,000 long-lived SSE clients with reconnect churn.",
  ),
  scenario(
    "load.sse-stress",
    "load",
    "Sustain 25,000 long-lived SSE clients with reconnect churn.",
  ),
  scenario(
    "load.turn-design",
    "load",
    "Accept and process 20 turns per second across distinct sessions.",
  ),
  scenario(
    "load.turn-stress",
    "load",
    "Accept and process 100 turns per second across distinct sessions.",
  ),
  scenario(
    "load.hot-session",
    "load",
    "Drive repeated turns through one session while preserving ordering and fairness for other sessions.",
  ),
  scenario(
    "load.mixed-workload",
    "load",
    "Run chat, conversion, context, research, handoff, draft, and publish concurrently.",
  ),
  scenario(
    "load.large-source-fanout",
    "load",
    "Upload large sources and sustain revision, chunk, conversion, distillation, and merge fanout.",
  ),
  scenario(
    "load.draft-burst",
    "load",
    "Burst immutable handoff and draft workflows without violating interactive chat SLOs.",
  ),
  scenario(
    "load.soak-24h",
    "load",
    "Run 24 hours at 60 percent design load without leaks or growing backlog.",
  ),
  scenario(
    "chaos.worker-termination",
    "chaos",
    "Terminate workers before and after provider response and DB commit.",
  ),
  scenario(
    "chaos.dependencies",
    "chaos",
    "Exercise SQS delay/duplicate, Valkey outage, S3 outage, and Bedrock throttle/malformed output.",
  ),
  scenario(
    "chaos.aurora-failover",
    "chaos",
    "Force Aurora failover and prove fenced workflow recovery.",
  ),
  scenario(
    "security.role-boundaries",
    "security",
    "Each runtime role is denied unrelated secrets, tools, S3 prefixes, and network destinations.",
  ),
  scenario(
    "security.redaction",
    "security",
    "The redaction corpus covers DSNs, cloud keys, PATs, JWTs, PEM, bearer tokens, and unknown-key values.",
  ),
  scenario(
    "security.dsr",
    "security",
    "DSR removes database rows, S3 objects, events, and audit artifacts without escaping approved prefixes.",
  ),
  scenario(
    "disaster-recovery.aurora-restore",
    "disaster_recovery",
    "Restore Aurora into an isolated environment and validate schema compatibility.",
  ),
  scenario(
    "disaster-recovery.queue-rehydrate",
    "disaster_recovery",
    "Rehydrate queues from durable DB/outbox state and resume non-terminal work once.",
  ),
  scenario(
    "disaster-recovery.artifact-integrity",
    "disaster_recovery",
    "Verify every restored immutable artifact against its recorded checksum and size.",
  ),
];

export function buildCertificationManifest(input: {
  releaseSha: string;
  environment: string;
  generatedAt?: Date;
}): CertificationManifest {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.releaseSha.trim())) {
    throw new Error("certification_release_sha_invalid");
  }
  if (!input.environment.trim()) {
    throw new Error("certification_environment_required");
  }
  const unsignedManifest = {
    schemaVersion: SPEC_FACTORY_CERTIFICATION_SCHEMA_VERSION,
    releaseSha: input.releaseSha.trim().toLowerCase(),
    environment: input.environment.trim(),
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    scenarios: SPEC_FACTORY_CERTIFICATION_SCENARIOS,
  };
  return {
    ...unsignedManifest,
    manifestId: certificationManifestId(unsignedManifest),
  };
}

export function evaluateCertification(
  manifest: CertificationManifest,
  evidence: CertificationEvidenceBundle,
  evaluatedAt: Date = new Date(),
  artifactIntegrityErrors: string[] = [],
): CertificationEvaluation {
  const invalidEvidence: string[] = [...artifactIntegrityErrors];
  if (manifest.schemaVersion !== SPEC_FACTORY_CERTIFICATION_SCHEMA_VERSION) {
    invalidEvidence.push("manifest_schema_version_mismatch");
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.releaseSha)) {
    invalidEvidence.push("manifest_release_sha_invalid");
  }
  if (!manifest.environment.trim()) {
    invalidEvidence.push("manifest_environment_invalid");
  }
  const manifestGeneratedAt = Date.parse(manifest.generatedAt);
  if (!Number.isFinite(manifestGeneratedAt)) {
    invalidEvidence.push("manifest_generated_at_invalid");
  }
  if (
    stableJson(manifest.scenarios) !==
    stableJson(SPEC_FACTORY_CERTIFICATION_SCENARIOS)
  ) {
    invalidEvidence.push("manifest_scenarios_mismatch");
  }
  const expectedManifestId = certificationManifestId({
    schemaVersion: manifest.schemaVersion,
    releaseSha: manifest.releaseSha,
    environment: manifest.environment,
    generatedAt: manifest.generatedAt,
    scenarios: manifest.scenarios,
  });
  if (manifest.manifestId !== expectedManifestId) {
    invalidEvidence.push("manifest_id_mismatch");
  }
  if (evidence.schemaVersion !== manifest.schemaVersion) {
    invalidEvidence.push("schema_version_mismatch");
  }
  if (evidence.manifestId !== manifest.manifestId) {
    invalidEvidence.push("manifest_evidence_mismatch");
  }
  if (evidence.releaseSha !== manifest.releaseSha) {
    invalidEvidence.push("release_sha_mismatch");
  }
  if (evidence.environment !== manifest.environment) {
    invalidEvidence.push("environment_mismatch");
  }
  const evidenceById = new Map<string, CertificationScenarioEvidence>();
  const canonicalIds = new Set(
    SPEC_FACTORY_CERTIFICATION_SCENARIOS.map((scenario) => scenario.id),
  );
  for (const entry of evidence.scenarios) {
    if (!canonicalIds.has(entry.scenarioId)) {
      invalidEvidence.push(`${entry.scenarioId}:unknown_scenario`);
      continue;
    }
    if (evidenceById.has(entry.scenarioId)) {
      invalidEvidence.push(`${entry.scenarioId}:duplicate_evidence`);
      continue;
    }
    evidenceById.set(entry.scenarioId, entry);
  }
  const missingScenarioIds: string[] = [];
  const failedScenarioIds: string[] = [];
  for (const scenario of manifest.scenarios) {
    const entry = evidenceById.get(scenario.id);
    if (!entry) {
      missingScenarioIds.push(scenario.id);
      continue;
    }
    if (entry.status !== "passed") {
      failedScenarioIds.push(scenario.id);
    }
    if (!validTimestampOrder(entry.startedAt, entry.completedAt)) {
      invalidEvidence.push(`${scenario.id}:invalid_timestamps`);
    } else {
      if (Date.parse(entry.startedAt) < manifestGeneratedAt) {
        invalidEvidence.push(`${scenario.id}:evidence_predates_manifest`);
      }
      if (Date.parse(entry.completedAt) > evaluatedAt.getTime()) {
        invalidEvidence.push(`${scenario.id}:evidence_completed_in_future`);
      }
    }
    validateScenarioArtifacts(scenario, entry, invalidEvidence);
  }
  const passed =
    missingScenarioIds.length === 0 &&
    failedScenarioIds.length === 0 &&
    invalidEvidence.length === 0;
  const digest = passed
    ? createHash("sha256")
        .update(stableJson({ manifest, evidence }))
        .digest("hex")
    : null;
  return {
    certificationId: digest ? `sfv4-${digest}` : null,
    passed,
    evaluatedAt: evaluatedAt.toISOString(),
    missingScenarioIds,
    failedScenarioIds,
    invalidEvidence,
  };
}

export function certificationManifestId(
  manifest: Omit<CertificationManifest, "manifestId">,
): string {
  return `${SPEC_FACTORY_CERTIFICATION_MANIFEST_ID_PREFIX}${createHash("sha256")
    .update(stableJson(manifest))
    .digest("hex")}`;
}

function validateScenarioArtifacts(
  scenario: CertificationScenario,
  entry: CertificationScenarioEvidence,
  invalidEvidence: string[],
): void {
  if (entry.artifacts.length < scenario.requiredEvidence.length) {
    invalidEvidence.push(`${scenario.id}:insufficient_artifacts`);
  }
  const uris = new Set<string>();
  const kinds = new Set<CertificationArtifactKind>();
  const acceptedKinds = new Set<string>(
    SPEC_FACTORY_CERTIFICATION_ARTIFACT_KINDS,
  );
  for (const artifact of entry.artifacts) {
    const uri = artifact.uri.trim();
    if (!uri) invalidEvidence.push(`${scenario.id}:artifact_uri_required`);
    if (
      uri.startsWith("/") ||
      uri.startsWith("\\") ||
      uri.split(/[\\/]/).includes("..") ||
      /^[a-z][a-z0-9+.-]*:/i.test(uri)
    ) {
      invalidEvidence.push(`${scenario.id}:artifact_uri_outside_bundle`);
    }
    if (uris.has(uri)) {
      invalidEvidence.push(`${scenario.id}:duplicate_artifact_uri`);
    }
    uris.add(uri);
    if (!acceptedKinds.has(artifact.kind)) {
      invalidEvidence.push(`${scenario.id}:artifact_kind_invalid`);
    } else {
      kinds.add(artifact.kind);
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      invalidEvidence.push(`${scenario.id}:artifact_sha256_invalid`);
    }
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
      invalidEvidence.push(`${scenario.id}:artifact_bytes_invalid`);
    }
  }
  if (!kinds.has("result")) {
    invalidEvidence.push(`${scenario.id}:result_artifact_required`);
  }
  if (!kinds.has("logs") && !kinds.has("metrics")) {
    invalidEvidence.push(`${scenario.id}:logs_or_metrics_artifact_required`);
  }
}

function scenario(
  id: string,
  category: CertificationCategory,
  description: string,
): CertificationScenario {
  return {
    id,
    category,
    description,
    execution:
      category === "functional" || id === "security.redaction"
        ? "automated"
        : "operator",
    command: commandFor(category, id),
    successCriteria: [description, "No lost or duplicate authoritative work."],
    requiredEvidence: ["machine-readable result", "logs or metrics artifact"],
  };
}

function commandFor(category: CertificationCategory, id: string): string {
  if (category === "functional")
    return "npm run spec-factory:certification:functional";
  if (category === "security") {
    return id === "security.redaction"
      ? "npm run spec-factory:certification:security"
      : `operator-runbook:docs/spec-factory/operations.md#work-order-t-certification:${id}`;
  }
  if (category === "load")
    return `k6 run certification/spec-factory-load.js -e SCENARIO=${id}`;
  if (category === "chaos")
    return `aws fis start-experiment --experiment-template-id \"$SPEC_FACTORY_FIS_TEMPLATE_ID\" --tags scenario=${id}`;
  return `operator-runbook:docs/spec-factory/operations.md#work-order-t-certification:${id}`;
}

function validTimestampOrder(startedAt: string, completedAt: string): boolean {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}
