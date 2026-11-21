/**
 * Durable state of the sticker library (domain `im_stickers`): one record per sticker, plus the panel's per-chat
 * automatic-sticker switches. The bytes live in files under the data directory; the record names them.
 *
 * @module dsh-im-stickers/domain
 */
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'

/** Where a collected sticker was first seen. */
export interface StickerOrigin {
  chat: string
  message: string
  seq: number
  index: number
}

/** One sticker. */
export interface StickerRecord {
  id: number
  /** Stable identity: `sha1:<hex>` of the bytes, so one picture is stored once. */
  key: string
  /** `upload` (panel), `chat` (collected from a chat message). */
  source: 'upload' | 'chat'
  origin?: StickerOrigin
  /** File name or the alt text it came with. */
  title: string
  /** One sentence describing what the picture shows (classifier or operator). */
  desc: string
  /** Type ids from the configuration. */
  tags: string[]
  /** 0–100; higher is picked more often. */
  weight: number
  enabled: boolean
  format: 'static' | 'animated'
  mime: string
  width: number
  height: number
  size: number
  /** File name inside the data directory (original bytes). */
  file: string
  /** File name inside `<dataDir>/thumbs`, or `''` when no preview could be made. */
  thumb: string
  uses: number
  lastUsed: number
  created: number
  updated: number
  /** Last classification failure, for the panel. */
  error: string
}

/** The panel's automatic-sticker switch for one chat. */
export interface StickerChatOverride {
  chat: string
  enabled?: boolean
  percent?: number
  updatedAt: number
}

const recordSchema = z.looseObject({
  id: z.number().int().positive(),
  key: z.string(),
  source: z.enum(['upload', 'chat']),
  origin: z.exactOptional(z.object({ chat: z.string(), message: z.string(), seq: z.number(), index: z.number() })),
  title: z.string(),
  desc: z.string(),
  tags: z.array(z.string()),
  weight: z.number(),
  enabled: z.boolean(),
  format: z.enum(['static', 'animated']),
  mime: z.string(),
  width: z.number(),
  height: z.number(),
  size: z.number(),
  file: z.string(),
  thumb: z.string(),
  uses: z.number(),
  lastUsed: z.number(),
  created: z.number(),
  updated: z.number(),
  error: z.string(),
})

const overrideSchema = z.looseObject({
  chat: z.string(),
  enabled: z.exactOptional(z.boolean()),
  percent: z.exactOptional(z.number()),
  updatedAt: z.number(),
})

/** The `im_stickers` storage domain. */
export const imStickersDomain = defineDomain({
  name: 'im_stickers',
  version: 1,
  layout: 'per-record',
  tables: {
    stickers: domainTable<string, StickerRecord>(recordSchema as unknown as z.ZodType<StickerRecord>),
    chats: domainTable<string, StickerChatOverride>(overrideSchema as unknown as z.ZodType<StickerChatOverride>),
  },
})

/** Typed handle of the `im_stickers` domain. */
export type ImStickersDomain = Domain<typeof imStickersDomain>
