import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  certificationArtifactFromFile,
  createCertificationEvidenceBundle,
  recordCertificationScenarioEvidence,
  verifyCertificationArtifactFiles,
} from "./certification-evidence.js";
import { buildCertificationManifest } from "./certification-plan.js";

describe("Spec Factory certification evidence", () => {
  const manifest = () =>
    buildCertificationManifest({
      releaseSha: "abcdef1234567890abcdef1234567890abcdef12",
      environment: "certification",
      generatedAt: new Date("2026-07-10T00:00:00.000Z"),
    });

  it("binds an empty evidence bundle to one immutable manifest", () => {
    const current = manifest();
    expect(createCertificationEvidenceBundle(current)).toEqual({
      schemaVersion: current.schemaVersion,
      manifestId: current.manifestId,
      releaseSha: current.releaseSha,
      environment: current.environment,
      scenarios: [],
    });
  });

  it("hashes non-empty local evidence artifacts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sf-cert-"));
    const filePath = path.join(directory, "result.json");
    await writeFile(filePath, '{"passed":true}\n', "utf8");
    await expect(
      certificationArtifactFromFile({
        kind: "result",
        filePath,
        uri: "result.json",
      }),
    ).resolves.toMatchObject({
      kind: "result",
      uri: "result.json",
      bytes: 16,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects empty files and directories as evidence artifacts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sf-cert-"));
    const emptyFilePath = path.join(directory, "empty.json");
    const nestedDirectory = path.join(directory, "nested");
    await writeFile(emptyFilePath, "", "utf8");
    await mkdir(nestedDirectory);

    for (const filePath of [emptyFilePath, nestedDirectory]) {
      await expect(
        certificationArtifactFromFile({
          kind: "result",
          filePath,
          uri: path.basename(filePath),
        }),
      ).rejects.toThrow("certification_artifact_file_empty_or_invalid");
    }
  });

  it("re-hashes bundle-local artifacts during evaluation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sf-cert-"));
    const filePath = path.join(directory, "result.json");
    await writeFile(filePath, '{"passed":true}\n', "utf8");
    const artifact = await certificationArtifactFromFile({
      kind: "result",
      filePath,
      uri: "result.json",
    });
    const bundle = {
      ...createCertificationEvidenceBundle(manifest()),
      scenarios: [
        {
          scenarioId: "functional.idempotent-turn",
          status: "passed" as const,
          startedAt: "2026-07-10T01:00:00.000Z",
          completedAt: "2026-07-10T01:01:00.000Z",
          artifacts: [artifact],
        },
      ],
    };
    await expect(
      verifyCertificationArtifactFiles(bundle, directory),
    ).resolves.toEqual([]);
    await writeFile(filePath, '{"passed":false}\n', "utf8");
    await expect(
      verifyCertificationArtifactFiles(bundle, directory),
    ).resolves.toEqual(
      expect.arrayContaining([
        "functional.idempotent-turn:artifact_size_mismatch",
        "functional.idempotent-turn:artifact_checksum_mismatch",
      ]),
    );
  });

  it("records each scenario once and rejects a mismatched bundle", () => {
    const current = manifest();
    const bundle = createCertificationEvidenceBundle(current);
    const evidence = {
      scenarioId: current.scenarios[0].id,
      status: "passed" as const,
      startedAt: "2026-07-10T01:00:00.000Z",
      completedAt: "2026-07-10T01:01:00.000Z",
      artifacts: [],
    };
    const recorded = recordCertificationScenarioEvidence({
      manifest: current,
      bundle,
      evidence,
    });
    expect(recorded.scenarios).toEqual([evidence]);
    expect(() =>
      recordCertificationScenarioEvidence({
        manifest: current,
        bundle: recorded,
        evidence,
      }),
    ).toThrow(`certification_scenario_already_recorded:${evidence.scenarioId}`);
    expect(() =>
      recordCertificationScenarioEvidence({
        manifest: current,
        bundle: { ...bundle, releaseSha: "f".repeat(40) },
        evidence,
      }),
    ).toThrow("certification_evidence_manifest_mismatch");
  });
});
