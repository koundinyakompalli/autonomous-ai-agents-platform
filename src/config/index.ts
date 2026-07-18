import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Load .env file
dotenvConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '../..');
export const DEFAULT_REPOSITORY_PATH = '/mnt/efs/repos';

export function resolveRepositoryPath(): string | undefined {
  return (
    process.env['REPOSITORY_PATH'] ??
    process.env['SHARED_REPOSITORY_PATH'] ??
    (process.env['EFS_MOUNT_PATH']
      ? `${process.env['EFS_MOUNT_PATH'].replace(/\/$/, '')}/repositories`
      : undefined)
  );
}

// MySQL configuration schema
const mysqlSchema = z.object({
  host: z.string().default('localhost'),
  port: z.coerce.number().default(3306),
  user: z.string().default('defectapp'),
  password: z.string().default('defectpassword'),
  database: z.string().default('jira'),
  connectionLimit: z.coerce.number().default(10),
  enabled: z.coerce.boolean().default(true),
});

// Configuration schema with validation
const configSchema = z.object({
  // Server
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  // AWS
  awsRegion: z.string().default('us-east-1'),

  // EFS Storage (shared across all agent workers)
  efsMountPath: z.string().default('/mnt/efs'),
  repositoryPath: z.string().default(DEFAULT_REPOSITORY_PATH),  // Code repositories
  documentsPath: z.string().default('/mnt/efs/documents'),  // Additional docs

  // Legacy Storage (for local development)
  repoStoragePath: z.string().default('./data/repos'),
  reportStoragePath: z.string().default('./data/reports'),

  // Repository Cache
  maxRepoCacheAgeDays: z.coerce.number().default(7),

  // Task Limits
  maxConcurrentTasks: z.coerce.number().default(5),
  taskTimeoutMinutes: z.coerce.number().default(60), // 60 minutes for unlimited iterations
  maxIterations: z.coerce.number().default(0), // 0 = unlimited iterations

  // LLM
  bedrockModelId: z.string().default('us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
  maxTokensPerRequest: z.coerce.number().default(128000),
  maxContextTokens: z.coerce.number().default(1000000),

  // API Authentication
  apiKey: z.string().optional(),

  // Logging
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // MySQL Database
  mysql: mysqlSchema,
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const rawConfig = {
    port: process.env['PORT'],
    host: process.env['HOST'],
    nodeEnv: process.env['NODE_ENV'],
    awsRegion: process.env['AWS_REGION'],
    // EFS Storage
    efsMountPath: process.env['EFS_MOUNT_PATH'],
    repositoryPath: resolveRepositoryPath(),
    documentsPath: process.env['DOCUMENTS_PATH'],
    // Legacy Storage
    repoStoragePath: process.env['REPO_STORAGE_PATH'],
    reportStoragePath: process.env['REPORT_STORAGE_PATH'],
    maxRepoCacheAgeDays: process.env['MAX_REPO_CACHE_AGE_DAYS'],
    maxConcurrentTasks: process.env['MAX_CONCURRENT_TASKS'],
    taskTimeoutMinutes: process.env['TASK_TIMEOUT_MINUTES'],
    maxIterations: process.env['MAX_ITERATIONS'],
    bedrockModelId: process.env['BEDROCK_MODEL_ID'],
    maxTokensPerRequest: process.env['MAX_TOKENS_PER_REQUEST'],
    maxContextTokens: process.env['MAX_CONTEXT_TOKENS'],
    apiKey: process.env['API_KEY'],
    logLevel: process.env['LOG_LEVEL'],
    // MySQL configuration
    mysql: {
      host: process.env['MYSQL_HOST'],
      port: process.env['MYSQL_PORT'],
      user: process.env['MYSQL_USER'],
      password: process.env['MYSQL_PASSWORD'],
      database: process.env['MYSQL_DATABASE'],
      connectionLimit: process.env['MYSQL_CONNECTION_LIMIT'],
      enabled: process.env['MYSQL_ENABLED'],
    },
  };

  const result = configSchema.safeParse(rawConfig);

  if (!result.success) {
    const errors = result.error.issues.map((e) => `  - ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  return result.data;
}

// Export singleton config
export const config = loadConfig();

// Helper to check if we're in production
export const isProduction = () => config.nodeEnv === 'production';

// Helper to check if we're in development
export const isDevelopment = () => config.nodeEnv === 'development';

// Helper to check if we're in test mode
export const isTest = () => config.nodeEnv === 'test';

// Export project root for path resolution
export { projectRoot };
