import { describe, expect, it } from "vitest";
import {
  SPEC_FACTORY_CERTIFICATION_SCENARIOS,
  buildCertificationManifest,
  evaluateCertification,
  type CertificationEvidenceBundle,
} from "./certification-plan.js";

describe("Spec Factory v4 certification", () => {
  const releaseSha = "abcdef1234567890abcdef1234567890abcdef12";
  const artifact = (
    kind: "result" | "logs" | "metrics" | "report",
    name: string,
  ) => ({
    kind,
    uri: `artifacts/${name}`,
    sha256: "a".repeat(64),
    bytes: 128,
  });

  it("requires every verification category", () => {
    expect(
      new Set(
        SPEC_FACTORY_CERTIFICATION_SCENARIOS.map((item) => item.category),
      ),
    ).toEqual(
      new Set(["functional", "load", "chaos", "security", "disaster_recovery"]),
    );
    expect(
      SPEC_FACTORY_CERTIFICATION_SCENARIOS.filter(
        (item) => item.execution === "automated",
      ).every((item) => item.command.startsWith("npm run ")),
    ).toBe(true);
    expect(
      SPEC_FACTORY_CERTIFICATION_SCENARIOS.filter(
        (item) => item.category === "disaster_recovery",
      ).every((item) => item.command.startsWith("operator-runbook:")),
    ).toBe(true);
    expect(
      SPEC_FACTORY_CERTIFICATION_SCENARIOS.find(
        (item) => item.id === "security.role-boundaries",
      )?.execution,
    ).toBe("operator");
    expect(
      SPEC_FACTORY_CERTIFICATION_SCENARIOS.find(
        (item) => item.id === "security.dsr",
      )?.execution,
    ).toBe("operator");
  });

  it("emits a deterministic removal-gate id only for complete passing evidence", () => {
    const manifest = buildCertificationManifest({
      releaseSha,
      environment: "certification",
      generatedAt: new Date("2026-07-10T00:00:00.000Z"),
    });
    const evidence: CertificationEvidenceBundle = {
      schemaVersion: manifest.schemaVersion,
      manifestId: manifest.manifestId,
      releaseSha: manifest.releaseSha,
      environment: manifest.environment,
      scenarios: manifest.scenarios.map((scenario) => ({
        scenarioId: scenario.id,
        status: "passed",
        startedAt: "2026-07-10T01:00:00.000Z",
        completedAt: "2026-07-10T01:01:00.000Z",
        artifacts: [
          artifact("result", `${scenario.id}-result.json`),
          artifact("logs", `${scenario.id}-logs.jsonl`),
        ],
      })),
    };
    const first = evaluateCertification(
      manifest,
      evidence,
      new Date("2026-07-10T02:00:00.000Z"),
    );
    const second = evaluateCertification(
      manifest,
      evidence,
      new Date("2026-07-10T03:00:00.000Z"),
    );
    expect(first.passed).toBe(true);
    expect(first.certificationId).toMatch(/^sfv4-[a-f0-9]{64}$/);
    expect(second.certificationId).toBe(first.certificationId);
  });

  it("fails closed for missing, failed, or release-mismatched evidence", () => {
    const manifest = buildCertificationManifest({
      releaseSha,
      environment: "certification",
    });
    const result = evaluateCertification(manifest, {
      schemaVersion: manifest.schemaVersion,
      manifestId: manifest.manifestId,
      releaseSha: "f".repeat(40),
      environment: "certification",
      scenarios: [],
    });
    expect(result).toMatchObject({
      passed: false,
      certificationId: null,
      missingScenarioIds: manifest.scenarios.map((scenario) => scenario.id),
      invalidEvidence: ["release_sha_mismatch"],
    });
  });

  it("rejects a shortened release SHA", () => {
    expect(() =>
      buildCertificationManifest({
        releaseSha: "abcdef1",
        environment: "certification",
      }),
    ).toThrow("certification_release_sha_invalid");
  });

  it("fails closed when the canonical manifest is edited", () => {
    const manifest = buildCertificationManifest({
      releaseSha,
      environment: "certification",
      generatedAt: new Date("2026-07-10T00:00:00.000Z"),
    });
    const editedManifest = { ...manifest, scenarios: [] };
    const result = evaluateCertification(editedManifest, {
      schemaVersion: editedManifest.schemaVersion,
      manifestId: editedManifest.manifestId,
      releaseSha: editedManifest.releaseSha,
      environment: editedManifest.environment,
      scenarios: [],
    });
    expect(result.passed).toBe(false);
    expect(result.invalidEvidence).toEqual(
      expect.arrayContaining([
        "manifest_scenarios_mismatch",
        "manifest_id_mismatch",
      ]),
    );
  });

  it("rejects duplicate, unknown, and unhashed evidence", () => {
    const manifest = buildCertificationManifest({
      releaseSha,
      environment: "certification",
      generatedAt: new Date("2026-07-10T00:00:00.000Z"),
    });
    const scenarioId = manifest.scenarios[0].id;
    const entry = {
      scenarioId,
      status: "passed" as const,
      startedAt: "2026-07-10T01:00:00.000Z",
      completedAt: "2026-07-10T01:01:00.000Z",
      artifacts: [
        { ...artifact("result", "result.json"), sha256: "not-a-digest" },
        artifact("logs", "logs.jsonl"),
      ],
    };
    const result = evaluateCertification(manifest, {
      schemaVersion: manifest.schemaVersion,
      manifestId: manifest.manifestId,
      releaseSha: manifest.releaseSha,
      environment: manifest.environment,
      scenarios: [
        entry,
        entry,
        { ...entry, scenarioId: "functional.not-real" },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.invalidEvidence).toEqual(
      expect.arrayContaining([
        `${scenarioId}:duplicate_evidence`,
        "functional.not-real:unknown_scenario",
        `${scenarioId}:artifact_sha256_invalid`,
      ]),
    );
  });
});
