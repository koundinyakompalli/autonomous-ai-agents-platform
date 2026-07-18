import { MERIDIANWorker } from "../src/orchestrator/workers/MERIDIANWorker.js";
import * as os from "node:os";
import * as path from "node:path";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const jiraKey = argValue("--jira")?.trim();
  if (!jiraKey) {
    throw new Error("--jira is required");
  }

  const outputDir = argValue("--output-dir")?.trim();
  const downloadsRequested = process.argv.includes("--downloads");
  if (outputDir) {
    process.env.MERIDIAN_LOCAL_SQL_OUTPUT_DIR = outputDir;
  } else if (downloadsRequested) {
    process.env.MERIDIAN_LOCAL_SQL_OUTPUT_DIR = path.join(os.homedir(), "Downloads");
  }

  const taskIdRaw = argValue("--task-id");
  const taskId = taskIdRaw ? Number.parseInt(taskIdRaw, 10) : undefined;
  const worker = new MERIDIANWorker(process.cwd(), false);
  const result = await worker.processJiraTicketDirect(jiraKey, {
    taskId: Number.isFinite(taskId) ? taskId : undefined,
  });

  if (!result.success) {
    throw new Error(result.error || result.output || "MERIDIAN direct run failed");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
