import { Router } from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  loadFurnitureAssets,
  loadCharacterSprites,
  loadFloorTiles,
  loadWallTiles,
} from '../assetLoader.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.resolve(__dirname, '../../public/assets')

const router = Router()

// Preload at module init so the first request is instant
let cachedPayload: string | null = null

function buildPayload(): string {
  if (cachedPayload) return cachedPayload

  const furniture = loadFurnitureAssets(ASSETS_DIR)
  const characters = loadCharacterSprites(ASSETS_DIR)
  const floor = loadFloorTiles(ASSETS_DIR)
  const walls = loadWallTiles(ASSETS_DIR)

  cachedPayload = JSON.stringify({
    catalog: furniture?.catalog ?? [],
    sprites: furniture?.sprites ?? {},
    characterSprites: characters?.characters ?? [],
    floorSprites: floor?.sprites ?? [],
    wallSprites: walls?.sprites ?? [],
  })

  return cachedPayload
}

// GET /api/assets
router.get('/', (_req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.send(buildPayload())
  } catch (err) {
    console.error('[assets] Error:', err)
    res.status(500).json({ error: 'Asset load failed' })
  }
})

export default router
