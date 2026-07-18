/**
 * Agent Workers Entry Point
 *
 * Each agent runs as its own ECS service, polling the database for tasks.
 *
 * Usage:
 *   node dist/orchestrator/workers/index.js DARCI
 *   node dist/orchestrator/workers/index.js SCRIBE
 *   node dist/orchestrator/workers/index.js PRISM
 *   node dist/orchestrator/workers/index.js QUALIFIER
 *   node dist/orchestrator/workers/index.js HERMES
 *   node dist/orchestrator/workers/index.js SENTRY
 *   node dist/orchestrator/workers/index.js MERIDIAN
 *
 * Architecture:
 *
 *   ┌──────────────────────────────────────────────────────────────────────────┐
 *   │                           Database (MySQL)                               │
 *   │  ┌──────────────────────────────────────────────────────────────────┐   │
 *   │  │ task_management: jira_number, agent_id, status, ...              │   │
 *   │  └──────────────────────────────────────────────────────────────────┘   │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *              │              │              │              │              │
 *              │ polls        │ polls        │ polls        │ polls        │ polls
 *              ▼              ▼              ▼              ▼              ▼
 *        ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
 *        │  DARCI  │   │ SCRIBE  │   │  PRISM  │   │ HERMES  │   │ SENTRY  │   │ BEACON  │
 *        │ Worker  │   │ Worker  │   │ Worker  │   │ Worker  │   │ Worker  │   │ Worker  │
 *        └────┬────┘   └────┬────┘   └────┬────┘   └────┬────┘   └────┬────┘   └────┬────┘
 *             │              │              │              │              │
 *             └──────────────┼──────────────┼──────────────┼──────────────┘
 *                            │              │              │
 *                            ▼              ▼              ▼
 *                      ┌─────────┐   ┌─────────┐
 *                      │   EFS   │   │   S3    │
 *                      │ (repos) │   │(results)│
 *                      └─────────┘   └─────────┘
 *
 * NO direct communication between Orchestrator and Workers!
 * Communication is purely through Database and S3.
 */

import { initDatabase } from "../database.js";
import { createLogger } from "../../utils/logger.js";
import {
  createWorker,
  getBuiltInWorkerTypes,
  getWorkerDescription,
} from "./runtime.js";

const logger = createLogger("orchestrator");

async function main() {
  const agentName = process.argv[2];

  if (!agentName) {
    console.error("Usage: node index.js <agent-name>");
    console.error("Available agents:");
    for (const workerType of getBuiltInWorkerTypes()) {
      console.error(`  ${workerType} - ${getWorkerDescription(workerType)}`);
    }
    console.error(
      "Custom workers may also be started if a matching worker module exists.",
    );
    process.exit(1);
  }

  logger.info( { agent: agentName },"Starting agent worker");

  // Get repository path from EFS mount
  const repositoryPath =
    process.env.REPOSITORY_PATH ||
    process.env.SHARED_REPOSITORY_PATH ||
    (process.env.EFS_MOUNT_PATH
      ? `${process.env.EFS_MOUNT_PATH.replace(/\/$/, "")}/repositories`
      : undefined) ||
    "/mnt/efs/repos";
  logger.info( { path: repositoryPath },"Using repository path (EFS)");

  // Initialize database
  await initDatabase();

  // Create and start worker
  const worker = await createWorker(agentName, repositoryPath);

  await worker.start();

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    await worker.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info( {
    agent: agentName,
    description: getAgentDescription(agentName),
  },"Agent worker is running");
}

function getAgentDescription(name: string): string {
  return getWorkerDescription(name);
}

main().catch((error) => {
  logger.error( { error },"Fatal error in agent worker");
  process.exit(1);
});

// Export workers for programmatic use
export { DARCIWorker } from "./DARCIWorker.js";
export { SCRIBEWorker } from "./SCRIBEWorker.js";
export { PRISMWorker } from "./PRISMWorker.js";
export { QualifierWorker } from "./QualifierWorker.js";
export { HERMESWorker } from "./HERMESWorker.js";
export { SENTRYWorker } from "./SENTRYWorker.js";
export { BEACONWorker } from "./BEACONWorker.js";
export { MERIDIANWorker } from "./MERIDIANWorker.js";
export { BCIntakeWorker } from "./BCIntakeWorker.js";
export { BCATplannerWorker } from "./BCATplannerWorker.js";
export { BCATExecutorWorker } from "./BCATExecutorWorker.js";
export { VERITASWorker } from "./VERITASWorker.js";
export { ANVILWorker } from "./ANVILWorker.js";
export { NOTARYWorker } from "./NOTARYWorker.js";
export { SRLOGWorker } from "./SRLOGWorker.js";
export { FORGEWorker } from "./FORGEWorker.js";
export { LEDGERWorker } from "./LEDGERWorker.js";
export { RIFTWorker } from "./RIFTWorker.js";
