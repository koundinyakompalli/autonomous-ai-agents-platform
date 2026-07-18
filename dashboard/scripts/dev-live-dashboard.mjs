import path from 'node:path'
import process from 'node:process'
import { createServer } from 'vite'

const DEFAULT_TARGET = 'https://productfactory.mhkdevsandbox.com'
const DEFAULT_INVESTIGATION_TARGET = 'http://127.0.0.1:3001'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 5174
const DEFAULT_OPERATOR_ID = 'local-dev'
const DEFAULT_OPERATOR_NAME = 'Local Developer'

function readArg(name) {
  const prefix = `--${name}=`
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : undefined
}

function readPort(value) {
  if (!value) return DEFAULT_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`)
  }
  return port
}

function normalizeTarget(value) {
  return (value || DEFAULT_TARGET).replace(/\/+$/, '')
}

const root = path.resolve(import.meta.dirname, '..')
const host = readArg('host') || process.env.DASHBOARD_LIVE_HOST || DEFAULT_HOST
const port = readPort(readArg('port') || process.env.DASHBOARD_LIVE_PORT)
const target = normalizeTarget(
  readArg('target') || process.env.DASHBOARD_LIVE_API_TARGET,
)
const investigationTarget = normalizeTarget(
  readArg('investigation-target') || process.env.DASHBOARD_LIVE_INVESTIGATION_TARGET || DEFAULT_INVESTIGATION_TARGET,
)
const investigationOperatorId =
  readArg('investigation-operator-id')
  || process.env.DASHBOARD_LIVE_INVESTIGATION_OPERATOR_ID
  || DEFAULT_OPERATOR_ID
const investigationOperatorName =
  readArg('investigation-operator-name')
  || process.env.DASHBOARD_LIVE_INVESTIGATION_OPERATOR_NAME
  || DEFAULT_OPERATOR_NAME

const server = await createServer({
  root,
  configFile: path.resolve(root, 'vite.config.ts'),
  server: {
    host,
    port,
    strictPort: true,
    proxy: {
      '/api/investigation': {
        target: investigationTarget,
        changeOrigin: true,
        secure: false,
        headers: {
          'x-operator-id': investigationOperatorId,
          'x-operator-name': investigationOperatorName,
        },
      },
      '^/api/(?!investigation(?:/|$))': {
        target,
        changeOrigin: true,
        secure: false,
      },
    },
  },
})

async function shutdown(signal) {
  console.log(`\n[dashboard-live] ${signal} received, shutting down`)
  await server.close()
  process.exit(0)
}

process.once('SIGINT', () => {
  void shutdown('SIGINT')
})
process.once('SIGTERM', () => {
  void shutdown('SIGTERM')
})

await server.listen()
server.printUrls()
console.log(`[dashboard-live] API proxy target: ${target}`)
console.log(`[dashboard-live] Investigation proxy target: ${investigationTarget}`)
console.log(
  `[dashboard-live] Investigation operator headers: ${investigationOperatorId} / ${investigationOperatorName}`,
)
console.log(`[dashboard-live] OneShot: http://${host}:${port}/oneshot`)
