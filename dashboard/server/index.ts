import express from 'express'
import { readFileSync } from 'node:fs'
import path from 'path'
import { fileURLToPath } from 'url'
import stateRouter from './routes/state.js'
import assetsRouter from './routes/assets.js'
import oneshotRouter from './routes/oneshot.js'
import oneshotDeploymentsRouter from './routes/oneshotDeployments.js'
import oneshotDeployRequestsRouter from './routes/oneshotDeployRequests.js'
import oneshotRunTerminationsRouter from './routes/oneshotRunTerminations.js'
import oneshotRunRequestsRouter from './routes/oneshotRunRequests.js'
import oneshotBlockedClientsRouter from './routes/oneshotBlockedClients.js'
import oneshotGithubRouter from './routes/oneshotGithub.js'
import productCatalogRouter from './routes/productCatalog.js'
import repoRouterRouter from './routes/repoRouter.js'
import deployAuthRouter from './routes/deployAuth.js'
import oneshotRunAuthRouter from './routes/oneshotRunAuth.js'
import repoRouterAuthRouter from './routes/repoRouterAuth.js'
import watchdogRouter from './routes/watchdog.js'
import investigationRouter from './routes/investigation.js'
import { getPool } from './db.js'
import { startWatchdogBackgroundJobs } from './services/watchdogRunner.js'
import { resolveDashboardRuntimePaths } from './runtimePaths.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT || '3001')
const IS_PROD = process.env.NODE_ENV === 'production'
const RUNTIME_PATHS = resolveDashboardRuntimePaths({
  serverDir: __dirname,
  requireStaticDir: IS_PROD,
})

const app = express()
app.use('/api/oneshot/github', oneshotGithubRouter)
app.use(express.json())

// Lightweight health check — ECS/ALB only needs the process to be alive.
// Always returns 200 so health checks pass even during transient DB issues.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// Deep health — DB connectivity check (for manual diagnostics, not ECS)
app.get('/health/db', async (_req, res) => {
  try {
    await getPool().execute('SELECT 1')
    res.json({ status: 'ok' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(503).json({ status: 'db_unavailable', error: msg })
  }
})

// API routes
app.use('/api/state', stateRouter)
app.use('/api/assets', assetsRouter)
app.use('/api/oneshot', oneshotRouter)
app.use('/api/oneshot/run-requests', oneshotRunRequestsRouter)
app.use('/api/oneshot/blocked-clients', oneshotBlockedClientsRouter)
app.use('/api/product-catalog', productCatalogRouter)
app.use('/api/oneshot/run-terminations', oneshotRunTerminationsRouter)
app.use('/api/oneshot/repo-router', repoRouterRouter)
app.use('/api/oneshot/deploy-requests', oneshotDeployRequestsRouter)
app.use('/api/oneshot/deployments', oneshotDeploymentsRouter)
app.use('/auth/deploy', deployAuthRouter)
app.use('/auth/oneshot-run', oneshotRunAuthRouter)
app.use('/auth/repo-router', repoRouterAuthRouter)
app.use('/api/watchdog/v1', watchdogRouter)
app.use('/api/investigation', investigationRouter)

// Serve static assets (furniture PNGs, sprites, default layout)
app.use('/assets', express.static(RUNTIME_PATHS.publicAssetsDir))
app.get('/default-layout.json', (_req, res) => {
  res.sendFile(RUNTIME_PATHS.defaultLayoutPath)
})

// In production: serve the built React app
if (IS_PROD) {
  const staticDir = RUNTIME_PATHS.staticDir
  const indexHtml = readFileSync(path.join(staticDir, 'index.html'), 'utf8')
  app.use(express.static(staticDir))
  app.get('/{*splat}', (_req, res) => {
    res.type('html').send(indexHtml)
  })
}

app.listen(PORT, () => {
  console.log(`[dashboard] Server running on port ${PORT} (${IS_PROD ? 'production' : 'development'})`)
})

startWatchdogBackgroundJobs()
