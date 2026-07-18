/**
 * Orchestrator Service Entry Point
 *
 * Usage:
 *   node dist/orchestrator/index.js
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Orchestrator } from './Orchestrator.js';
import { initDatabase } from './database.js';
import { createLogger } from '../utils/logger.js';
import { parseJiraPollingEnabled } from './runtime-config.js';

const logger = createLogger('orchestrator');

const HEALTH_PORT = parseInt(process.env.STATUS_PORT || '8080');
const HEALTH_HOST = process.env.STATUS_HOST || '0.0.0.0';

async function main() {
  logger.info('Starting Specter Orchestrator Service');

  // Validate environment
  if (!process.env.JIRA_BASE_URL) {
    throw new Error('JIRA_BASE_URL environment variable is required');
  }
  if (!process.env.JIRA_TOKEN) {
    throw new Error('JIRA_TOKEN environment variable is required');
  }
  if (!process.env.JIRA_USERNAME) {
    throw new Error('JIRA_USERNAME environment variable is required');
  }

  // Start health check server for ECS container health checks
  const healthServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        service: 'orchestrator',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  healthServer.listen(HEALTH_PORT, HEALTH_HOST, () => {
    logger.info({ port: HEALTH_PORT, host: HEALTH_HOST }, '✅ Health check server started');
  });

  // Initialize database
  logger.info('Initializing database connection');
  await initDatabase();

  // Create orchestrator
  const orchestrator = new Orchestrator({
    jiraBaseUrl: process.env.JIRA_BASE_URL,
    jiraToken: process.env.JIRA_TOKEN,
    jiraUsername: process.env.JIRA_USERNAME,
    pollingIntervalMs: parseInt(process.env.JIRA_POLLING_INTERVAL_MS || '60000'),
    resultCheckIntervalMs: parseInt(process.env.RESULT_CHECK_INTERVAL_MS || '30000'),
    dashboardRunRequestIntervalMs: parseInt(
      process.env.DASHBOARD_RUN_REQUEST_INTERVAL_MS || '10000',
    ),
    jiraPollingEnabled: parseJiraPollingEnabled(process.env),
    awsRegion: process.env.AWS_REGION || 'us-east-1',
    autoReassignTickets: process.env.AUTO_REASSIGN_TICKETS !== 'false', // Default: true, set to 'false' to disable
  });

  // Start orchestrator
  await orchestrator.start();

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    await orchestrator.stop();
    healthServer.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('Orchestrator service is running');
}

main().catch((error) => {
  logger.error( { error },'Fatal error in orchestrator');
  process.exit(1);
});

export * from './Orchestrator.js';
export * from './database.js';
export * from './StatusServer.js';
export * from './JiraClient.js';
export * from './TaskDescriptionGenerator.js';
