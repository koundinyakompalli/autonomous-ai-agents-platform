/**
 * Client Database Service — Read-Only Access to Client Lower Environments
 *
 * Connects to client CareProminence/medhok databases via AWS Secrets Manager
 * credentials. Enforced read-only, non-PROD only.
 *
 * Secrets Manager path: /${division}/${client}/${envId}/database/core
 * Keys: host, username, password
 * Default database: medhok
 * Default port: 3306
 */

import * as mysql from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { createLogger } from '../../utils/index.js';

const logger = createLogger('client-db');

const BLOCKED_ENVIRONMENTS = ['prod', 'production', 'prd'];
const QUERY_TIMEOUT_MS = 30_000;
const MAX_ROWS = 500;
const CONNECTION_TIMEOUT_MS = 10_000;

const BLOCKED_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE',
    'REPLACE', 'GRANT', 'REVOKE', 'CALL', 'EXEC', 'EXECUTE',
    'LOAD', 'LOCK', 'UNLOCK', 'RENAME', 'SET', 'FLUSH',
];

export interface ClientEnvironment {
    client: string;
    envId: string;
    division?: string;
}

export interface ClientDbCredentials {
    host: string;
    username: string;
    password: string;
    port?: number;
    database?: string;
}

export interface QueryResult {
    success: boolean;
    rows: Record<string, unknown>[];
    rowCount: number;
    truncated: boolean;
    executionTimeMs: number;
    error?: string;
}

/**
 * Validates that a SQL string is read-only.
 * Returns an error message if blocked, or null if safe.
 */
function validateReadOnly(sql: string): string | null {
    const normalized = sql.trim().replace(/\s+/g, ' ').toUpperCase();

    for (const keyword of BLOCKED_KEYWORDS) {
        const pattern = new RegExp(`(^|\\s|;)${keyword}(\\s|$|;)`, 'i');
        if (pattern.test(normalized)) {
            return `Blocked: "${keyword}" statements are not allowed. Read-only access only.`;
        }
    }

    if (!normalized.startsWith('SELECT') && !normalized.startsWith('SHOW') &&
        !normalized.startsWith('DESCRIBE') && !normalized.startsWith('DESC') &&
        !normalized.startsWith('EXPLAIN') && !normalized.startsWith('WITH')) {
        return 'Only SELECT, SHOW, DESCRIBE, EXPLAIN, and WITH (CTE) statements are allowed.';
    }

    return null;
}

/**
 * Validates the environment is not production.
 */
function validateEnvironment(envId: string): string | null {
    const normalized = envId.toLowerCase().trim();
    if (BLOCKED_ENVIRONMENTS.includes(normalized)) {
        return `Blocked: Cannot connect to ${envId} environment. Only non-production environments are allowed.`;
    }
    return null;
}

export class ClientDatabaseService {
    private pools: Map<string, Pool> = new Map();

    /**
     * Execute a read-only query against a client's lower environment database.
     *
     * @param env - Client and environment identifier
     * @param sql - SELECT query to execute
     * @param params - Optional query parameters (for parameterized queries)
     * @param credentials - Required pre-resolved credentials. RIFT does not
     * resolve DB secrets itself in this rollout.
     */
    async query(
        env: ClientEnvironment,
        sql: string,
        params?: unknown[],
        credentials?: ClientDbCredentials
    ): Promise<QueryResult> {
        const startTime = Date.now();
        const poolKey = `${env.division || 'CP'}/${env.client}/${env.envId}`;

        const logContext = {
            client: env.client,
            envId: env.envId,
            division: env.division || 'CP',
            sqlPreview: sql.substring(0, 100),
        };

        // Gate 1: Block production environments
        const envError = validateEnvironment(env.envId);
        if (envError) {
            logger.warn(logContext, `[CLIENT_DB_BLOCKED] ${envError}`);
            return {
                success: false,
                rows: [],
                rowCount: 0,
                truncated: false,
                executionTimeMs: Date.now() - startTime,
                error: envError,
            };
        }

        // Gate 2: Block non-read-only queries
        const readOnlyError = validateReadOnly(sql);
        if (readOnlyError) {
            logger.warn(logContext, `[CLIENT_DB_BLOCKED] ${readOnlyError}`);
            return {
                success: false,
                rows: [],
                rowCount: 0,
                truncated: false,
                executionTimeMs: Date.now() - startTime,
                error: readOnlyError,
            };
        }

        try {
            // Get or create connection pool
            let pool = this.pools.get(poolKey);
            if (!pool) {
                if (!credentials) {
                    return {
                        success: false,
                        rows: [],
                        rowCount: 0,
                        truncated: false,
                        executionTimeMs: Date.now() - startTime,
                        error: 'Client DB credentials were not provided. Secrets Manager lookup is not wired in this rollout.',
                    };
                }

                const creds = credentials;

                logger.info(
                    { ...logContext, host: creds.host, port: creds.port, database: creds.database },
                    '[CLIENT_DB_CONNECT] Creating connection pool'
                );

                pool = mysql.createPool({
                    host: creds.host,
                    port: creds.port || 3306,
                    user: creds.username,
                    password: creds.password,
                    database: creds.database || 'medhok',
                    connectionLimit: 2,
                    connectTimeout: CONNECTION_TIMEOUT_MS,
                    waitForConnections: true,
                    queueLimit: 5,
                    enableKeepAlive: true,
                });

                this.pools.set(poolKey, pool);
            }

            // Enforce row limit
            const limitedSql = sql.trim().replace(/;+\s*$/, '');
            const hasLimit = /\bLIMIT\s+\d+/i.test(limitedSql);
            const finalSql = hasLimit ? limitedSql : `${limitedSql} LIMIT ${MAX_ROWS}`;

            logger.info(logContext, '[CLIENT_DB_QUERY] Executing query');

            const connection = await pool.getConnection();
            try {
                // Set session to read-only as defense in depth
                await connection.query('SET SESSION TRANSACTION READ ONLY');

                const [rows] = await connection.query<RowDataPacket[]>(
                    { sql: finalSql, timeout: QUERY_TIMEOUT_MS },
                    params
                );

                const truncated = rows.length >= MAX_ROWS;
                const executionTimeMs = Date.now() - startTime;

                logger.info(
                    { ...logContext, rowCount: rows.length, truncated, executionTimeMs },
                    '[CLIENT_DB_RESULT] Query completed'
                );

                return {
                    success: true,
                    rows: rows as Record<string, unknown>[],
                    rowCount: rows.length,
                    truncated,
                    executionTimeMs,
                };
            } finally {
                connection.release();
            }
        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            logger.error(
                { ...logContext, errorMessage, executionTimeMs },
                '[CLIENT_DB_ERROR] Query failed'
            );

            return {
                success: false,
                rows: [],
                rowCount: 0,
                truncated: false,
                executionTimeMs,
                error: errorMessage,
            };
        }
    }

    /**
     * Close all connection pools.
     */
    async close(): Promise<void> {
        const entries = Array.from(this.pools.entries());
        for (const [key, pool] of entries) {
            logger.info({ poolKey: key }, '[CLIENT_DB_CLOSE] Closing pool');
            await pool.end();
        }
        this.pools.clear();
    }
}

export default ClientDatabaseService;
