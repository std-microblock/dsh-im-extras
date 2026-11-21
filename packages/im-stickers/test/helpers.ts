import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StickerRecord, StickersConfig } from '../src/index.ts'
import { DEFAULT_RULES, DEFAULT_STICKER_TYPES } from '../src/index.ts'

/** A 1×1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/** A different valid-looking PNG (same header, other bytes). */
export function png(variant: number): Buffer {
  return Buffer.concat([PNG, Buffer.from([variant])])
}

export function config(patch: Partial<StickersConfig> = {}): StickersConfig {
  return {
    dataDir: '',
    types: DEFAULT_STICKER_TYPES,
    minWeight: 0,
    auto: { enabled: true, percent: 50, gapMs: 7000, tag: 'general' },
    rules: DEFAULT_RULES,
    classify: { enabled: true, provider: 'p', model: 'm', maxTokens: 100, timeoutMs: 1000, concurrency: 2 },
    magick: 'magick-not-installed',
    maxBytes: 1024 * 1024,
    tools: ['send_sticker', 'sticker_search', 'sticker_collect'],
    prompt: true,
    ...patch,
  }
}

export function row(id: number, patch: Partial<StickerRecord> = {}): StickerRecord {
  return {
    id, key: `sha1:${id}`, source: 'upload', title: '', desc: '', tags: [], weight: 50, enabled: true, format: 'static',
    mime: 'image/png', width: 1, height: 1, size: 10, file: `${id}.png`, thumb: '', uses: 0, lastUsed: 0, created: 0,
    updated: 0, error: '', ...patch,
  }
}

/** An in-memory storage facility. */
export function memoryStorage() {
  const tables = new Map<string, Map<string, unknown>>()
  const domain = {
    table: (name: string) => {
      const store = tables.get(name) ?? new Map<string, unknown>()
      tables.set(name, store)
      return {
        get: (key: string) => store.get(key),
        keys: () => new Map(store).keys(),
        entries: () => new Map(store).entries(),
        put: async (key: string, value: unknown) => { store.set(key, value) },
        delete: async (key: string) => store.delete(key),
      }
    },
    close: async () => {},
  }
  return { storage: { open: async () => domain } as never, tables }
}

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'im-stickers-test-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** A deterministic die. */
export function seeded(seed = 1): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

export const quiet = { info() {}, warn() {}, debug() {} }
