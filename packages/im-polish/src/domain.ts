/**
 * Durable state of the polish plugin (domain `im_polish`): one record per polished send, for the panel's
 * before/after view, and the panel's per-chat switches.
 *
 * @module dsh-im-polish/domain
 */
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'

/** One polished send as the panel shows it. */
export interface PolishRecord {
  /** Sortable id: time-ordered. */
  id: string
  /** When the decision was made (epoch ms). */
  at: number
  /** Chat key. */
  chat: string
  /** Admission source of the chat. */
  source?: string
  /** Session whose send it was. */
  session?: string
  /** `rewritten`, `kept` (the original went out) or `dropped` (nothing went out). */
  action: 'rewritten' | 'kept' | 'dropped'
  /** The text the agent wrote. */
  original: string
  /** What went out (the original when kept; the original as well when dropped). */
  result: string
  /** Why the original was kept or the send dropped. */
  reason?: string
  /** The sentence the agent read for a dropped send. */
  dropMessage?: string
  /** Sub-styles drawn. */
  subs: string[]
  /** Similarity to the closest of the bot's recent messages. */
  similarity?: number
  /** That message. */
  similarTo?: string
  /** Model answers and what became of them. */
  attempts: { raw: string; verdict: string }[]
  /** `provider/model` of the rewrite. */
  model?: string
  /** Time the decision took. */
  durationMs: number
}

/** The panel's switch for one chat. */
export interface ChatOverride {
  chat: string
  /** Polish on or off for this chat, overriding the configuration. */
  enabled?: boolean
  updatedAt: number
}

const recordSchema = z.looseObject({
  id: z.string(),
  at: z.number(),
  chat: z.string(),
  source: z.exactOptional(z.string()),
  session: z.exactOptional(z.string()),
  action: z.enum(['rewritten', 'kept', 'dropped']),
  original: z.string(),
  result: z.string(),
  reason: z.exactOptional(z.string()),
  dropMessage: z.exactOptional(z.string()),
  subs: z.array(z.string()),
  similarity: z.exactOptional(z.number()),
  similarTo: z.exactOptional(z.string()),
  attempts: z.array(z.object({ raw: z.string(), verdict: z.string() })),
  model: z.exactOptional(z.string()),
  durationMs: z.number(),
})

const overrideSchema = z.looseObject({
  chat: z.string(),
  enabled: z.exactOptional(z.boolean()),
  updatedAt: z.number(),
})

/** The `im_polish` storage domain. */
export const imPolishDomain = defineDomain({
  name: 'im_polish',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    records: domainTable<string, PolishRecord>(recordSchema as unknown as z.ZodType<PolishRecord>),
    chats: domainTable<string, ChatOverride>(overrideSchema as unknown as z.ZodType<ChatOverride>),
  },
})

/** Typed handle of the `im_polish` domain. */
export type ImPolishDomain = Domain<typeof imPolishDomain>
