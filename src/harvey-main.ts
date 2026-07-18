/**
 * Harvey Service Entry Point
 *
 * Uses Express + CloudAdapter — Express req/res matches botbuilder's
 * Request/Response interface exactly, avoiding the Zod validation crash
 * that occurs with raw Node.js http.IncomingMessage/ServerResponse.
 *
 * ## Environment Variables
 * - TEAMS_APP_ID         — Microsoft Bot App ID
 * - TEAMS_APP_PASSWORD   — Microsoft Bot App Password
 * - HARVEY_PORT          — HTTP port (default: 3978)
 * - HARVEY_HOST          — Bind host (default: 0.0.0.0)
 * - RESULT_POLL_INTERVAL — Result delivery poll interval in ms (default: 15000)
 * - AWS_REGION           — AWS region for Bedrock and S3
 * - BEDROCK_MODEL_ID     — Model ID for the intake agent
 */

import express from 'express';
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
} from 'botbuilder';
import { getDatabase } from './orchestrator/database.js';
import { IntakeAgent } from './harvey/IntakeAgent.js';
import { HarveyTeamsBot } from './harvey/TeamsBot.js';
import { ResultNotifier } from './harvey/ResultNotifier.js';
import { SessionStore } from './harvey/SessionStore.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('harvey-main');

const TEAMS_APP_ID = process.env.TEAMS_APP_ID || '';
const TEAMS_APP_PASSWORD = process.env.TEAMS_APP_PASSWORD || '';
const PORT = parseInt(process.env.HARVEY_PORT || '3978');
const HOST = process.env.HARVEY_HOST || '0.0.0.0';
const RESULT_POLL_INTERVAL = parseInt(process.env.RESULT_POLL_INTERVAL || '15000');
const SESSION_CLEANUP_INTERVAL = 5 * 60 * 1000;

async function main(): Promise<void> {
  logger.info({
    port: PORT,
    host: HOST,
    hasAppId: !!TEAMS_APP_ID,
    resultPollInterval: RESULT_POLL_INTERVAL,
  }, '[HARVEY_START] Starting Harvey service');

  // 1. Connect to database
  const db = getDatabase();
  await db.connect();
  logger.info('[HARVEY_DB] Database connected');

  // 2. CloudAdapter with ConfigurationBotFrameworkAuthentication
  const botAuth = new ConfigurationBotFrameworkAuthentication({
    MicrosoftAppId: TEAMS_APP_ID,
    MicrosoftAppPassword: TEAMS_APP_PASSWORD,
    MicrosoftAppType: 'SingleTenant',
    MicrosoftAppTenantId: process.env.TEAMS_TENANT_ID || 'a84894e7-87c5-40e3-9783-320d0334b3cc',
  });
  const adapter = new CloudAdapter(botAuth);

  adapter.onTurnError = async (context, error) => {
    logger.error({
      error: error.message,
      stack: error.stack,
      userId: context.activity?.from?.id,
    }, '[HARVEY_TURN_ERROR] Unhandled error in turn');
    try {
      await context.sendActivity('Sorry, something went wrong. Please try again.');
    } catch { /* ignore */ }
  };

  // 3. Core components
  const intakeAgent = new IntakeAgent();
  const bot = new HarveyTeamsBot(intakeAgent);
  const resultNotifier = new ResultNotifier(adapter, TEAMS_APP_ID, intakeAgent, RESULT_POLL_INTERVAL);
  const sessionStore = new SessionStore();

  resultNotifier.start();
  logger.info('[HARVEY_NOTIFIER] Result notifier started');

  const cleanupTimer = setInterval(async () => {
    try {
      await sessionStore.abandonStaleSessions();
    } catch (err: any) {
      logger.error({ error: err.message }, '[HARVEY_CLEANUP_ERROR] Session cleanup failed');
    }
  }, SESSION_CLEANUP_INTERVAL);

  // 4. Express server — Express req/res matches botbuilder Request/Response exactly
  const app = express();

  // Required: parse JSON bodies so botbuilder can read the incoming activity
  app.use(express.json());

  app.post('/api/messages', async (req, res) => {
    await adapter.process(req, res, async (context) => {
      await bot.run(context);
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'harvey', timestamp: new Date().toISOString() });
  });

  const server = app.listen(PORT, HOST, () => {
    logger.info({
      port: PORT,
      host: HOST,
      messagesEndpoint: `http://${HOST}:${PORT}/api/messages`,
      healthEndpoint: `http://${HOST}:${PORT}/health`,
    }, '[HARVEY_READY] Harvey service started');

    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                    HARVEY SERVICE STARTED                       ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  Bot Framework:  http://${HOST}:${PORT}/api/messages            ║
║  Health Check:   http://${HOST}:${PORT}/health                  ║
║                                                                ║
║  Teams App ID:   ${TEAMS_APP_ID ? TEAMS_APP_ID.substring(0, 20) + '...' : '(not set)'}                            ║
║  Result Poll:    ${RESULT_POLL_INTERVAL}ms                                     ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
    `);
  });

  // 5. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, '[HARVEY_SHUTDOWN] Shutdown signal received');
    clearInterval(cleanupTimer);
    resultNotifier.stop();
    server.close();
    await db.disconnect();
    logger.info('[HARVEY_SHUTDOWN] Harvey service stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error({
    error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
  }, '[HARVEY_FATAL] Startup failed');
  console.error('Harvey startup failed:', error);
  process.exit(1);
});
