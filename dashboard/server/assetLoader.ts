import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

// PNG / Asset Parsing constants
const PNG_ALPHA_THRESHOLD = 128;
const WALL_PIECE_WIDTH = 16;
const WALL_PIECE_HEIGHT = 32;
const WALL_GRID_COLS = 4;
const WALL_BITMASK_COUNT = 16;
const FLOOR_PATTERN_COUNT = 7;
const FLOOR_TILE_SIZE = 16;
const CHARACTER_DIRECTIONS = ['down', 'up', 'right'] as const;
const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_FRAMES_PER_ROW = 7;
const CHAR_COUNT = 6;

export interface FurnitureAsset {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  partOfGroup?: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
}

export interface LoadedAssets {
  catalog: FurnitureAsset[];
  sprites: Record<string, string[][]>;
}

export interface LoadedWallTiles {
  sprites: string[][][];
}

export interface LoadedFloorTiles {
  sprites: string[][][];
}

export interface CharacterDirectionSprites {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface LoadedCharacterSprites {
  characters: CharacterDirectionSprites[];
}

function pixelToHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
}

function pngToSpriteData(pngBuffer: Buffer, width: number, height: number): string[][] {
  try {
    const png = PNG.sync.read(pngBuffer);
    const sprite: string[][] = [];
    const data = png.data;

    for (let y = 0; y < height; y++) {
      const row: string[] = [];
      for (let x = 0; x < width; x++) {
        const idx = (y * png.width + x) * 4;
        const a = data[idx + 3];
        if (a < PNG_ALPHA_THRESHOLD) {
          row.push('');
        } else {
          row.push(pixelToHex(data[idx], data[idx + 1], data[idx + 2]));
        }
      }
      sprite.push(row);
    }
    return sprite;
  } catch (err) {
    console.warn(`Failed to parse PNG: ${err instanceof Error ? err.message : err}`);
    const sprite: string[][] = [];
    for (let y = 0; y < height; y++) {
      sprite.push(new Array(width).fill(''));
    }
    return sprite;
  }
}

/**
 * Load pre-colored character sprites from assets/characters/ (6 PNGs, each 112x96).
 * Each PNG has 3 direction rows (down, up, right) x 7 frames (16x32 each).
 *
 * @param assetsDir - Path to the assets/ directory directly
 */
export function loadCharacterSprites(assetsDir: string): LoadedCharacterSprites | null {
  try {
    const charDir = path.join(assetsDir, 'characters');
    const characters: CharacterDirectionSprites[] = [];

    for (let ci = 0; ci < CHAR_COUNT; ci++) {
      const filePath = path.join(charDir, `char_${ci}.png`);
      if (!fs.existsSync(filePath)) {
        console.log(`[AssetLoader] No character sprite found at: ${filePath}`);
        return null;
      }

      const pngBuffer = fs.readFileSync(filePath);
      const png = PNG.sync.read(pngBuffer);
      const charData: CharacterDirectionSprites = { down: [], up: [], right: [] };

      for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
        const dir = CHARACTER_DIRECTIONS[dirIdx];
        const rowOffsetY = dirIdx * CHAR_FRAME_H;
        const frames: string[][][] = [];

        for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
          const sprite: string[][] = [];
          const frameOffsetX = f * CHAR_FRAME_W;
          for (let y = 0; y < CHAR_FRAME_H; y++) {
            const row: string[] = [];
            for (let x = 0; x < CHAR_FRAME_W; x++) {
              const idx = ((rowOffsetY + y) * png.width + (frameOffsetX + x)) * 4;
              const a = png.data[idx + 3];
              if (a < PNG_ALPHA_THRESHOLD) {
                row.push('');
              } else {
                row.push(pixelToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2]));
              }
            }
            sprite.push(row);
          }
          frames.push(sprite);
        }
        charData[dir] = frames;
      }
      characters.push(charData);
    }

    console.log(`[AssetLoader] Loaded ${characters.length} character sprites (${CHAR_FRAMES_PER_ROW} frames x 3 directions each)`);
    return { characters };
  } catch (err) {
    console.error(`[AssetLoader] Error loading character sprites: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Load floor tile patterns from floors.png (7 tiles, 16px each, horizontal strip)
 *
 * @param assetsDir - Path to the assets/ directory directly
 */
export function loadFloorTiles(assetsDir: string): LoadedFloorTiles | null {
  try {
    const floorPath = path.join(assetsDir, 'floors.png');
    if (!fs.existsSync(floorPath)) {
      console.log('[AssetLoader] No floors.png found — renderer will use fallback');
      return null;
    }

    const pngBuffer = fs.readFileSync(floorPath);
    const png = PNG.sync.read(pngBuffer);
    const sprites: string[][][] = [];

    for (let t = 0; t < FLOOR_PATTERN_COUNT; t++) {
      const sprite: string[][] = [];
      for (let y = 0; y < FLOOR_TILE_SIZE; y++) {
        const row: string[] = [];
        for (let x = 0; x < FLOOR_TILE_SIZE; x++) {
          const px = t * FLOOR_TILE_SIZE + x;
          const idx = (y * png.width + px) * 4;
          const a = png.data[idx + 3];
          if (a < PNG_ALPHA_THRESHOLD) {
            row.push('');
          } else {
            row.push(pixelToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2]));
          }
        }
        sprite.push(row);
      }
      sprites.push(sprite);
    }

    console.log(`[AssetLoader] Loaded ${sprites.length} floor tile patterns`);
    return { sprites };
  } catch (err) {
    console.error(`[AssetLoader] Error loading floor tiles: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Load wall tiles from walls.png (64x128, 4x4 grid of 16x32 pieces).
 *
 * @param assetsDir - Path to the assets/ directory directly
 */
export function loadWallTiles(assetsDir: string): LoadedWallTiles | null {
  try {
    const wallPath = path.join(assetsDir, 'walls.png');
    if (!fs.existsSync(wallPath)) {
      console.log('[AssetLoader] No walls.png found');
      return null;
    }

    const pngBuffer = fs.readFileSync(wallPath);
    const png = PNG.sync.read(pngBuffer);
    const sprites: string[][][] = [];

    for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
      const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
      const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
      const sprite: string[][] = [];
      for (let r = 0; r < WALL_PIECE_HEIGHT; r++) {
        const row: string[] = [];
        for (let c = 0; c < WALL_PIECE_WIDTH; c++) {
          const idx = ((oy + r) * png.width + (ox + c)) * 4;
          const a = png.data[idx + 3];
          if (a < PNG_ALPHA_THRESHOLD) {
            row.push('');
          } else {
            row.push(pixelToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2]));
          }
        }
        sprite.push(row);
      }
      sprites.push(sprite);
    }

    console.log(`[AssetLoader] Loaded ${sprites.length} wall tile pieces`);
    return { sprites };
  } catch (err) {
    console.error(`[AssetLoader] Error loading wall tiles: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Load furniture assets from furniture-catalog.json + individual PNGs
 *
 * @param assetsDir - Path to the assets/ directory directly
 */
export function loadFurnitureAssets(assetsDir: string): LoadedAssets | null {
  try {
    const catalogPath = path.join(assetsDir, 'furniture', 'furniture-catalog.json');
    if (!fs.existsSync(catalogPath)) {
      console.log('[AssetLoader] No furniture catalog found — renderer will use fallback');
      return null;
    }

    const catalogContent = fs.readFileSync(catalogPath, 'utf-8');
    const catalogData = JSON.parse(catalogContent);
    const catalog: FurnitureAsset[] = catalogData.assets || [];
    const sprites: Record<string, string[][]> = {};

    for (const asset of catalog) {
      try {
        const assetPath = path.join(assetsDir, asset.file);
        if (!fs.existsSync(assetPath)) {
          console.warn(`  Asset file not found: ${asset.file}`);
          continue;
        }
        const pngBuffer = fs.readFileSync(assetPath);
        sprites[asset.id] = pngToSpriteData(pngBuffer, asset.width, asset.height);
      } catch (err) {
        console.warn(`  Error loading ${asset.id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log(`[AssetLoader] Loaded ${Object.keys(sprites).length} / ${catalog.length} furniture assets`);
    return { catalog, sprites };
  } catch (err) {
    console.error(`[AssetLoader] Error loading furniture assets: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
