/**
 * Worker Entry Point with Status Server
 *
 * Starts the status server and agent worker together for real-time monitoring
 */

import { config } from './config/index.js';
import { getDatabase, initDatabase } from './orchestrator/database.js';
import { initStatusServer, type StatusServerConfig } from './orchestrator/StatusServer.js';
import type { AgentWorker } from './orchestrator/AgentWorker.js';
import { createWorker, getBuiltInWorkerTypes } from './orchestrator/workers/runtime.js';
import { getOneShotSharedConfig } from './oneshot/config.js';
import { validateQualifierRuntime } from './oneshot/runtime-validation.js';
import { initTelemetry, shutdownTelemetry } from './oneshot/telemetry/init.js';
import { applyAgentModelToProcessEnv } from './utils/agentModel.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger("worker-main");

// Get worker configuration from environment
const WORKER_TYPE = process.env.WORKER_TYPE || "DARCI";
const STATUS_PORT = parseInt(process.env.STATUS_PORT || "8080");
const STATUS_HOST = process.env.STATUS_HOST || "0.0.0.0";
const ENABLE_WEBHOOKS = process.env.ENABLE_WEBHOOKS === "true";
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
// OneShot consumers (PLANNER, REVIEWER, IMPLEMENTER, CODE_REVIEWER, TESTER)
// initialize telemetry in src/oneshot/main.ts. This init only covers the
// QUALIFIER worker, which runs through worker-main.ts.
const ENABLE_ONESHOT_TELEMETRY = WORKER_TYPE === "QUALIFIER";

async function main(): Promise<void> {
  if (ENABLE_ONESHOT_TELEMETRY) {
    initTelemetry(WORKER_TYPE);
  }

  logger.info(
    {
      workerType: WORKER_TYPE,
      statusPort: STATUS_PORT,
      statusHost: STATUS_HOST,
      webhooksEnabled: ENABLE_WEBHOOKS,
    },
    "Starting worker with status server",
  );

  const repoPath = config.repositoryPath || '/mnt/efs/specter-repo/repositories';
  if (WORKER_TYPE === "QUALIFIER") {
    await initDatabase();
    const db = getDatabase();
    const agent = await db.getAgentByName(WORKER_TYPE);
    if (!agent) {
      throw new Error(`Agent not found in database: ${WORKER_TYPE}`);
    }
    applyAgentModelToProcessEnv(agent.model, {
      agentName: WORKER_TYPE,
    });
    const oneShotConfig = getOneShotSharedConfig();
    await validateQualifierRuntime({
      db,
      artifactBucket: oneShotConfig.artifactBucket,
      planningQueueUrl: process.env.ONESHOT_PLANNING_QUEUE_URL || '',
      repoBasePath: repoPath,
      repoAdminBasePath: oneShotConfig.repoAdminBasePath,
    });
  }

  // Initialize status server
  const statusConfig: StatusServerConfig = {
    port: STATUS_PORT,
    host: STATUS_HOST,
    enableWebSocket: true,
    enableSSE: true,
    corsOrigin: "*",
    webhooks: [],
  };

  // Add webhook if configured
  if (ENABLE_WEBHOOKS && WEBHOOK_URL) {
    statusConfig.webhooks!.push({
      url: WEBHOOK_URL,
      events: ["*"], // All events
      secret: WEBHOOK_SECRET,
    });
    logger.info({ url: WEBHOOK_URL }, "Webhook configured");
  }

  // Start status server
  const statusServer = initStatusServer(statusConfig);
  await statusServer.start();

  logger.info(
    {
      port: STATUS_PORT,
      host: STATUS_HOST,
    },
    "✅ Status server started",
  );

  // Create and start worker based on type
  let worker: AgentWorker;
  worker = await createWorker(WORKER_TYPE, repoPath, true);

  // Start the worker
  await worker.start();

  logger.info(
    {
      worker: WORKER_TYPE,
      statusEndpoint: `http://${STATUS_HOST}:${STATUS_PORT}`,
      wsEndpoint: `ws://${STATUS_HOST}:${STATUS_PORT}`,
      sseEndpoint: `http://${STATUS_HOST}:${STATUS_PORT}/events`,
    },
    "✅ Worker started successfully",
  );

  // Print available endpoints
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                    SPECTER WORKER STARTED                      ║
╠════════════════════════════════════════════════════════════════╣
║  Worker Type: ${WORKER_TYPE.padEnd(48)}║
║                                                                ║
║  Status Endpoints:                                             ║
║  • Health:     http://${STATUS_HOST}:${STATUS_PORT}/health              ║
║  • All Tasks:  http://${STATUS_HOST}:${STATUS_PORT}/status              ║
║  • Task:       http://${STATUS_HOST}:${STATUS_PORT}/status/:taskId      ║
║  • History:    http://${STATUS_HOST}:${STATUS_PORT}/history             ║
║  • Metrics:    http://${STATUS_HOST}:${STATUS_PORT}/metrics             ║
║                                                                ║
║  Real-time Streaming:                                          ║
║  • WebSocket:  ws://${STATUS_HOST}:${STATUS_PORT}                       ║
║  • SSE:        http://${STATUS_HOST}:${STATUS_PORT}/events              ║
╚════════════════════════════════════════════════════════════════╝
  `);

  // Handle shutdown signals
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");

    if (worker) {
      await worker.stop();
    }
    await statusServer.stop();
    if (ENABLE_ONESHOT_TELEMETRY) {
      await shutdownTelemetry();
    }

    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Run
main().catch((error) => {
    const validTypes = getBuiltInWorkerTypes().join(', ');
    logger.error({
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        validTypes,
    }, 'Worker startup failed');
    console.error('Worker startup failed:', error);
    process.exit(1);
});
