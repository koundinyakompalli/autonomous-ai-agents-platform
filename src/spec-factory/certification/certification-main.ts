import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCertificationManifest,
  evaluateCertification,
  type CertificationEvidenceBundle,
  type CertificationManifest,
} from "./certification-plan.js";
import { verifyCertificationArtifactFiles } from "./certification-evidence.js";

interface CliArgs {
  manifestPath: string;
  evidencePath: string | null;
  outputPath: string | null;
  releaseSha: string;
  environment: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.evidencePath) {
    const manifest = buildCertificationManifest({
      releaseSha: args.releaseSha,
      environment: args.environment,
    });
    await writeJson(args.manifestPath, manifest);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  const [manifest, evidence] = await Promise.all([
    readJson<CertificationManifest>(args.manifestPath),
    readJson<CertificationEvidenceBundle>(args.evidencePath),
  ]);
  const artifactIntegrityErrors = await verifyCertificationArtifactFiles(
    evidence,
    path.dirname(path.resolve(args.evidencePath)),
  );
  const evaluation = evaluateCertification(
    manifest,
    evidence,
    new Date(),
    artifactIntegrityErrors,
  );
  if (args.outputPath) await writeJson(args.outputPath, evaluation);
  process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
  if (!evaluation.passed) process.exitCode = 2;
}

function parseArgs(argv: string[]): CliArgs {
  const value = (name: string): string | null => {
    const prefix = `--${name}=`;
    return (
      argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
    );
  };
  const releaseSha =
    value("release-sha") ??
    process.env.GITHUB_SHA ??
    process.env.SPEC_FACTORY_RELEASE_SHA ??
    "0000000";
  return {
    manifestPath:
      value("manifest") ?? "artifacts/spec-factory-certification/manifest.json",
    evidencePath: value("evidence"),
    outputPath: value("output"),
    releaseSha,
    environment:
      value("environment") ??
      process.env.SPEC_FACTORY_CERTIFICATION_ENVIRONMENT ??
      "unassigned",
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
