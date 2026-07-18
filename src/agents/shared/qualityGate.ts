export interface QualityGateRetryContextInput {
  agentName: "DARCI" | "HERMES";
  failureReason: string;
  previousOutput: string;
  contractLines: string[];
}

export function buildQualityGateRetryContext(
  input: QualityGateRetryContextInput,
): string {
  const previousOutput = input.previousOutput.trim();
  return [
    `## ${input.agentName} Quality Gate Retry`,
    "",
    `Previous output failed quality gate: ${input.failureReason}.`,
    "",
    "### Required Contract",
    ...input.contractLines.map((line) => `- ${line}`),
    "",
    "### Previous Output",
    previousOutput
      ? fenced(previousOutput.slice(0, 6_000))
      : "_Previous output was empty._",
    "",
    "Re-run only the missing verification steps. Do not restart broad discovery if the evidence pack already gives candidate files or config sources.",
  ].join("\n");
}

function fenced(value: string): string {
  return ["```text", value, "```"].join("\n");
}
