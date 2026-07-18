import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { createLogger } from '../utils/logger.js'
import type { QueueConsumerHealthSnapshot } from './consumer-base.js'

const logger = createLogger('oneshot-health')

export interface OneShotHealthReporter {
  getHealthSnapshot(): QueueConsumerHealthSnapshot
}

interface OneShotHealthServerConfig {
  role: string
  port?: number
  host?: string
  reporter: OneShotHealthReporter
}

export class OneShotHealthServer {
  private readonly role: string
  private readonly port: number
  private readonly host: string
  private readonly reporter: OneShotHealthReporter
  private readonly server = createServer((req, res) => this.handleRequest(req, res))
  private ready = false

  constructor(config: OneShotHealthServerConfig) {
    this.role = config.role
    this.port = config.port ?? parseInt((process.env.STATUS_PORT || '8080'), 10)
    this.host = (config.host ?? process.env.STATUS_HOST) || '0.0.0.0'
    this.reporter = config.reporter
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject)
        resolve()
      })
    })

    logger.info({
      role: this.role,
      host: this.host,
      port: this.port,
    }, 'Started OneShot health server')
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
  }

  getPort(): number {
    const address = this.server.address()
    if (!address || typeof address === 'string') {
      return this.port
    }
    return (address as AddressInfo).port
  }

  setReady(ready: boolean): void {
    this.ready = ready
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const snapshot = this.reporter.getHealthSnapshot()

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    const response = buildHealthResponse(url.pathname, this.role, this.ready, snapshot)
    if (response) {
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response.body))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  }
}

export function buildHealthResponse(
  pathname: string,
  role: string,
  ready: boolean,
  snapshot: QueueConsumerHealthSnapshot,
): { statusCode: number; body: Record<string, unknown> } | null {
  const basePayload = {
    role,
    ready,
    timestamp: new Date().toISOString(),
    consumer: snapshot,
  }

  if (pathname === '/health') {
    return {
      statusCode: snapshot.healthy ? 200 : 503,
      body: {
        ...basePayload,
        status: snapshot.healthy ? 'healthy' : 'unhealthy',
      },
    }
  }

  if (pathname === '/ready') {
    const isReady = ready && snapshot.healthy
    return {
      statusCode: isReady ? 200 : 503,
      body: {
        ...basePayload,
        status: isReady ? 'ready' : 'not_ready',
      },
    }
  }

  return null
}
