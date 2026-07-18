import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const contractsPath = fileURLToPath(
  new URL('../src/oneshot/contracts.ts', import.meta.url),
)
const contractsSource = readFileSync(contractsPath, 'utf8')
const sourceVersion =
  contractsSource.match(/ONESHOT_VERSION\s*=\s*["']([^"']+)["']/)?.[1] || ''
const appVersion = process.env.ONESHOT_VERSION || sourceVersion

const apiProxyTarget =
  process.env.VITE_API_PROXY_TARGET ||
  process.env.DASHBOARD_API_TARGET ||
  'http://localhost:3011'
const investigationApiProxyTarget =
  process.env.VITE_INVESTIGATION_API_PROXY_TARGET ||
  process.env.DASHBOARD_INVESTIGATION_API_TARGET ||
  process.env.VITE_API_PROXY_TARGET ||
  'http://localhost:3001'

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 5173,
    proxy: {
      '^/api/(?!investigation(?:/|$))': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      '/api/investigation': {
        target: investigationApiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
  },
})
