/**
 * StatusServer - HTTP/WebSocket server for real-time task monitoring
 * 
 * Provides:
 * - REST endpoints for task status queries
 * - WebSocket endpoint for live event streaming
 * - SSE (Server-Sent Events) for simpler real-time updates
 * - Webhook POST to external URLs on key events
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('StatusServer');

/**
 * Agent event types for status tracking (Claude SDK compatible)
 */
export interface AgentEvents {
    'agent:start': { taskId: string; agentType: string; timestamp: string };
    'agent:progress': { taskId: string; message: string; toolCalls: number; elapsed: number };
    'agent:tool': { taskId: string; tool: string; duration?: number };
    'agent:complete': { taskId: string; success: boolean; duration: number; tokensUsed?: { input: number; output: number }; cost?: number };
    'agent:error': { taskId: string; error: string };
}

/**
 * Task status snapshot
 */
export interface TaskStatus {
    taskId: string;
    jiraNumber?: string;
    agentName: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    toolCalls: number;
    phase: string;
    startTime: string;
    lastUpdate: string;
    toolsUsed: string[];
    metrics: {
        inputTokens: number;
        outputTokens: number;
        cost: number;
        durationMs: number;
    };
    currentTool?: string;
    lastMessage?: string;
    error?: string;
}

/**
 * Webhook configuration
 */
export interface WebhookConfig {
    url: string;
    events: (keyof AgentEvents | '*')[];
    secret?: string;
    headers?: Record<string, string>;
}

/**
 * StatusServer configuration
 */
export interface StatusServerConfig {
    port: number;
    host?: string;
    enableWebSocket?: boolean;
    enableSSE?: boolean;
    webhooks?: WebhookConfig[];
    corsOrigin?: string;
}

/**
 * WebSocket client with subscriptions
 */
interface WSClient {
    ws: WebSocket;
    subscriptions: Set<string>; // taskId or '*' for all
    connectedAt: Date;
}

/**
 * StatusServer - Real-time monitoring for agent tasks
 */
export class StatusServer {
    private config: StatusServerConfig;
    private server: Server | null = null;
    private wss: WebSocketServer | null = null;
    private clients: Map<string, WSClient> = new Map();
    private taskStatuses: Map<string, TaskStatus> = new Map();
    private sseClients: Set<ServerResponse> = new Set();
    private eventHistory: Array<{ timestamp: string; event: string; data: unknown }> = [];
    private readonly MAX_HISTORY = 1000;

    constructor(config: StatusServerConfig) {
        this.config = {
            host: '0.0.0.0',
            enableWebSocket: true,
            enableSSE: true,
            corsOrigin: '*',
            ...config,
        };
    }

    /**
     * Start the status server
     */
    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.server = createServer((req, res) => this.handleRequest(req, res));

                if (this.config.enableWebSocket) {
                    this.wss = new WebSocketServer({ server: this.server });
                    this.setupWebSocket();
                }

                this.server.listen(this.config.port, this.config.host!, () => {
                    logger.info({
                        port: this.config.port,
                        host: this.config.host,
                        websocket: this.config.enableWebSocket,
                        sse: this.config.enableSSE,
                    }, 'Status server started');
                    resolve();
                });

                this.server.on('error', (error) => {
                    logger.error({ error }, 'Status server error');
                    reject(error);
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Stop the status server
     */
    async stop(): Promise<void> {
        // Close all WebSocket connections
        for (const client of this.clients.values()) {
            client.ws.close(1001, 'Server shutting down');
        }
        this.clients.clear();

        // Close all SSE connections
        for (const res of this.sseClients) {
            res.end();
        }
        this.sseClients.clear();

        // Close WebSocket server
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }

        // Close HTTP server
        if (this.server) {
            return new Promise((resolve) => {
                this.server!.close(() => {
                    logger.info('Status server stopped');
                    resolve();
                });
            });
        }
    }

    /**
     * Create an event emitter that forwards events to the status server
     */
    createEventBridge(taskId: string, agentName: string, jiraNumber?: string): EventEmitter {
        const emitter = new EventEmitter();

        // Initialize task status
        this.taskStatuses.set(taskId, {
            taskId,
            jiraNumber,
            agentName,
            status: 'pending',
            toolCalls: 0,
            phase: 'initializing',
            startTime: new Date().toISOString(),
            lastUpdate: new Date().toISOString(),
            toolsUsed: [],
            metrics: {
                inputTokens: 0,
                outputTokens: 0,
                cost: 0,
                durationMs: 0,
            },
        });

        // Forward agent events (Claude SDK compatible)
        this.setupEventListeners(emitter, taskId);

        return emitter;
    }

    /**
     * Setup event listeners for Claude SDK agent events
     */
    private setupEventListeners(emitter: EventEmitter, taskId: string): void {
        // Agent start
        emitter.on('agent:start', (data: AgentEvents['agent:start']) => {
            this.updateTaskStatus(taskId, {
                status: 'in_progress',
                phase: 'starting',
            });
            this.broadcastEvent(taskId, 'agent:start', data);
        });

        // Agent progress
        emitter.on('agent:progress', (data: AgentEvents['agent:progress']) => {
            this.updateTaskStatus(taskId, {
                toolCalls: data.toolCalls,
                lastMessage: data.message,
                phase: 'processing',
            });
            this.broadcastEvent(taskId, 'agent:progress', data);
        });

        // Tool usage
        emitter.on('agent:tool', (data: AgentEvents['agent:tool']) => {
            const status = this.taskStatuses.get(taskId);
            if (status) {
                const toolsUsed = new Set([...status.toolsUsed, data.tool]);
                this.updateTaskStatus(taskId, {
                    currentTool: data.tool,
                    toolsUsed: Array.from(toolsUsed),
                    lastMessage: `Using tool: ${data.tool}`,
                });
            }
            this.broadcastEvent(taskId, 'agent:tool', data);
        });

        // Agent complete
        emitter.on('agent:complete', (data: AgentEvents['agent:complete']) => {
            this.updateTaskStatus(taskId, {
                status: data.success ? 'completed' : 'failed',
                phase: 'complete',
                currentTool: undefined,
                metrics: {
                    inputTokens: data.tokensUsed?.input || 0,
                    outputTokens: data.tokensUsed?.output || 0,
                    cost: data.cost || 0,
                    durationMs: data.duration,
                },
                lastMessage: data.success ? 'Task completed successfully' : 'Task failed',
            });
            this.broadcastEvent(taskId, 'agent:complete', data);
        });

        // Agent error
        emitter.on('agent:error', (data: AgentEvents['agent:error']) => {
            this.updateTaskStatus(taskId, {
                status: 'failed',
                error: data.error,
                lastMessage: `Error: ${data.error}`,
            });
            this.broadcastEvent(taskId, 'agent:error', data);
        });
    }

    /**
     * Update task status
     */
    private updateTaskStatus(taskId: string, updates: Partial<TaskStatus>): void {
        const status = this.taskStatuses.get(taskId);
        if (status) {
            Object.assign(status, updates, { lastUpdate: new Date().toISOString() });
        }
    }

    /**
     * Broadcast event to all subscribers
     */
    private broadcastEvent(taskId: string, event: string, data: unknown): void {
        const eventData = {
            taskId,
            event,
            data,
            timestamp: new Date().toISOString(),
        };

        // Store in history
        this.eventHistory.push({ timestamp: eventData.timestamp, event, data });
        if (this.eventHistory.length > this.MAX_HISTORY) {
            this.eventHistory.shift();
        }

        // Send to WebSocket clients
        for (const client of this.clients.values()) {
            if (client.subscriptions.has('*') || client.subscriptions.has(taskId)) {
                this.sendToClient(client, eventData);
            }
        }

        // Send to SSE clients
        for (const res of this.sseClients) {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(eventData)}\n\n`);
        }

        // Send to webhooks
        this.sendToWebhooks(event, eventData);

        logger.debug({ taskId, event }, 'Event broadcasted');
    }

    /**
     * Send event to webhooks
     */
    private async sendToWebhooks(event: string, data: unknown): Promise<void> {
        if (!this.config.webhooks?.length) return;

        for (const webhook of this.config.webhooks) {
            // Check if webhook is subscribed to this event
            if (!webhook.events.includes('*') && !webhook.events.includes(event as keyof AgentEvents)) {
                continue;
            }

            try {
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                    ...webhook.headers,
                };

                // Add signature if secret is configured
                if (webhook.secret) {
                    const crypto = await import('crypto');
                    const signature = crypto.createHmac('sha256', webhook.secret)
                        .update(JSON.stringify(data))
                        .digest('hex');
                    headers['X-Webhook-Signature'] = signature;
                }

                fetch(webhook.url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(data),
                }).catch(err => {
                    logger.warn({ url: webhook.url, error: err.message }, 'Webhook delivery failed');
                });
            } catch (error: any) {
                logger.warn({ url: webhook.url, error: error.message }, 'Webhook error');
            }
        }
    }

    /**
     * Send message to WebSocket client
     */
    private sendToClient(client: WSClient, data: unknown): void {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(data));
        }
    }

    /**
     * Setup WebSocket server
     */
    private setupWebSocket(): void {
        if (!this.wss) return;

        this.wss.on('connection', (ws, req) => {
            const clientId = `ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const client: WSClient = {
                ws,
                subscriptions: new Set(['*']), // Subscribe to all by default
                connectedAt: new Date(),
            };

            this.clients.set(clientId, client);
            logger.info({ clientId, ip: req.socket.remoteAddress }, 'WebSocket client connected');

            // Send welcome message
            this.sendToClient(client, {
                type: 'connected',
                clientId,
                timestamp: new Date().toISOString(),
                activeTasks: Array.from(this.taskStatuses.keys()),
            });

            ws.on('message', (message) => {
                try {
                    const msg = JSON.parse(message.toString());
                    this.handleWebSocketMessage(clientId, msg);
                } catch (error) {
                    logger.warn({ clientId, error }, 'Invalid WebSocket message');
                }
            });

            ws.on('close', () => {
                this.clients.delete(clientId);
                logger.info({ clientId }, 'WebSocket client disconnected');
            });

            ws.on('error', (error) => {
                logger.error({ clientId, error }, 'WebSocket client error');
            });
        });
    }

    /**
     * Handle WebSocket messages
     */
    private handleWebSocketMessage(clientId: string, msg: any): void {
        const client = this.clients.get(clientId);
        if (!client) return;

        switch (msg.type) {
            case 'subscribe':
                // Subscribe to specific tasks
                if (msg.taskIds && Array.isArray(msg.taskIds)) {
                    client.subscriptions.clear();
                    for (const taskId of msg.taskIds) {
                        client.subscriptions.add(taskId);
                    }
                }
                this.sendToClient(client, {
                    type: 'subscribed',
                    subscriptions: Array.from(client.subscriptions),
                });
                break;

            case 'subscribe_all':
                client.subscriptions.clear();
                client.subscriptions.add('*');
                this.sendToClient(client, {
                    type: 'subscribed',
                    subscriptions: ['*'],
                });
                break;

            case 'get_status':
                // Get status for specific task or all tasks
                if (msg.taskId) {
                    const status = this.taskStatuses.get(msg.taskId);
                    this.sendToClient(client, {
                        type: 'status',
                        taskId: msg.taskId,
                        status: status || null,
                    });
                } else {
                    const statuses: Record<string, TaskStatus> = {};
                    for (const [taskId, status] of this.taskStatuses) {
                        statuses[taskId] = status;
                    }
                    this.sendToClient(client, {
                        type: 'all_statuses',
                        statuses,
                    });
                }
                break;

            case 'get_history':
                // Get recent event history
                const count = Math.min(msg.count || 100, this.MAX_HISTORY);
                this.sendToClient(client, {
                    type: 'history',
                    events: this.eventHistory.slice(-count),
                });
                break;

            case 'ping':
                this.sendToClient(client, { type: 'pong', timestamp: new Date().toISOString() });
                break;

            default:
                logger.warn({ clientId, msgType: msg.type }, 'Unknown WebSocket message type');
        }
    }

    /**
     * Handle HTTP requests
     */
    private handleRequest(req: IncomingMessage, res: ServerResponse): void {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', this.config.corsOrigin!);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const path = url.pathname;

        try {
            // Route handling
            if (path === '/health') {
                this.handleHealth(res);
            } else if (path === '/status') {
                this.handleAllStatuses(res);
            } else if (path.startsWith('/status/')) {
                const taskId = path.split('/')[2];
                this.handleTaskStatus(res, taskId);
            } else if (path === '/events' && this.config.enableSSE) {
                this.handleSSE(req, res);
            } else if (path === '/history') {
                const count = parseInt(url.searchParams.get('count') || '100');
                this.handleHistory(res, count);
            } else if (path === '/metrics') {
                this.handleMetrics(res);
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
            }
        } catch (error: any) {
            logger.error({ path, error }, 'Request handler error');
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    /**
     * Health check endpoint
     */
    private handleHealth(res: ServerResponse): void {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            activeTasks: this.taskStatuses.size,
            connectedClients: this.clients.size,
            sseClients: this.sseClients.size,
        }));
    }

    /**
     * All task statuses endpoint
     */
    private handleAllStatuses(res: ServerResponse): void {
        const statuses: Record<string, TaskStatus> = {};
        for (const [taskId, status] of this.taskStatuses) {
            statuses[taskId] = status;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            count: this.taskStatuses.size,
            tasks: statuses,
            timestamp: new Date().toISOString(),
        }));
    }

    /**
     * Single task status endpoint
     */
    private handleTaskStatus(res: ServerResponse, taskId: string): void {
        const status = this.taskStatuses.get(taskId);

        if (!status) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Task not found', taskId }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
    }

    /**
     * Event history endpoint
     */
    private handleHistory(res: ServerResponse, count: number): void {
        const events = this.eventHistory.slice(-Math.min(count, this.MAX_HISTORY));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            count: events.length,
            events,
            timestamp: new Date().toISOString(),
        }));
    }

    /**
     * Metrics endpoint
     */
    private handleMetrics(res: ServerResponse): void {
        // Calculate aggregated metrics
        let totalTasks = 0;
        let completedTasks = 0;
        let failedTasks = 0;
        let inProgressTasks = 0;
        let totalCost = 0;
        let totalDuration = 0;
        let totalToolCalls = 0;

        for (const status of this.taskStatuses.values()) {
            totalTasks++;
            totalCost += status.metrics.cost;
            totalDuration += status.metrics.durationMs;
            totalToolCalls += status.toolCalls;

            switch (status.status) {
                case 'completed':
                    completedTasks++;
                    break;
                case 'failed':
                    failedTasks++;
                    break;
                case 'in_progress':
                    inProgressTasks++;
                    break;
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            totalTasks,
            completedTasks,
            failedTasks,
            inProgressTasks,
            pendingTasks: totalTasks - completedTasks - failedTasks - inProgressTasks,
            totalCost: parseFloat(totalCost.toFixed(4)),
            totalDurationMs: totalDuration,
            totalToolCalls,
            averageCostPerTask: totalTasks > 0 ? parseFloat((totalCost / totalTasks).toFixed(4)) : 0,
            averageDurationMs: totalTasks > 0 ? Math.round(totalDuration / totalTasks) : 0,
            connectedClients: this.clients.size,
            sseClients: this.sseClients.size,
            timestamp: new Date().toISOString(),
        }));
    }

    /**
     * Server-Sent Events endpoint
     */
    private handleSSE(req: IncomingMessage, res: ServerResponse): void {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no', // Disable nginx buffering
        });

        // Send initial connection event
        res.write('event: connected\n');
        res.write(`data: ${JSON.stringify({
            timestamp: new Date().toISOString(),
            activeTasks: Array.from(this.taskStatuses.keys()),
        })}\n\n`);

        // Add to SSE clients
        this.sseClients.add(res);

        // Keep-alive ping every 30 seconds
        const keepAlive = setInterval(() => {
            res.write(': keepalive\n\n');
        }, 30000);

        req.on('close', () => {
            clearInterval(keepAlive);
            this.sseClients.delete(res);
            logger.debug('SSE client disconnected');
        });

        logger.info('SSE client connected');
    }

    /**
     * Manually mark a task as complete (for cleanup)
     */
    markTaskComplete(taskId: string): void {
        const status = this.taskStatuses.get(taskId);
        if (status && status.status === 'in_progress') {
            this.updateTaskStatus(taskId, { status: 'completed' });
        }
    }

    /**
     * Remove a task from tracking
     */
    removeTask(taskId: string): void {
        this.taskStatuses.delete(taskId);
    }

    /**
     * Get server address
     */
    getAddress(): { host: string; port: number } | null {
        if (!this.server) return null;
        const addr = this.server.address();
        if (typeof addr === 'string' || !addr) return null;
        return { host: addr.address, port: addr.port };
    }
}

// Export singleton factory
let statusServerInstance: StatusServer | null = null;

export function getStatusServer(config?: StatusServerConfig): StatusServer {
    if (!statusServerInstance && config) {
        statusServerInstance = new StatusServer(config);
    }
    if (!statusServerInstance) {
        throw new Error('StatusServer not initialized. Call with config first.');
    }
    return statusServerInstance;
}

export function initStatusServer(config: StatusServerConfig): StatusServer {
    if (statusServerInstance) {
        logger.warn('StatusServer already initialized, returning existing instance');
        return statusServerInstance;
    }
    statusServerInstance = new StatusServer(config);
    return statusServerInstance;
}
