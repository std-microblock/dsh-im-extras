/**
 * Durable store of active streamed progress card handles (domain `im_output_summary`), keyed by session id.
 *
 * When a turn opens an `edit`-capable message stream (e.g. a Feishu card patched via `PATCH /im/v1/messages/:id`),
 * its minimal `MessageHandle` is saved here. Normal settlement clears the row; a crash or graceful shutdown
 * (`activity.disposed`) leaves it behind so the resumed turn can pass `resumeHandle` and keep streaming in place on
 * the original message instead of posting a fresh card.
 */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { h, type MessageHandle, type SentPart, type Target } from '@deepseek-ai/cordis-plugin-im-core'
import type { ImChatKey } from '@deepseek-ai/dsh-im'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'

/** Default maximum age (30 minutes) of a stored handle eligible for in-place resume. */
export const RESUME_HANDLE_MAX_AGE_MS = 30 * 60_000

/** Minimal serializable snapshot of one active streamed message handle. */
export interface StoredStreamHandle {
  chat: ImChatKey
  bot: string
  target: Target
  mode: string
  parts: Array<{
    id: string
    kind: string
    time: number
    thread?: { id: string; root?: string }
    referrer?: unknown
  }>
  createdAt: number
  edits: number
  state?: unknown
  updatedAt: number
}

const storedChatKey = z.string().transform((value): ImChatKey => value as ImChatKey)

const storedPartSchema = z.object({
  id: z.string(),
  kind: z.string(),
  time: z.number(),
  thread: z.exactOptional(z.object({
    id: z.string(),
    root: z.exactOptional(z.string()),
  })),
  referrer: z.unknown().optional(),
})

const storedTargetSchema = z.object({
  chat: z.object({
    id: z.string(),
    type: z.string().transform((value): Target['chat']['type'] => value as Target['chat']['type']),
    name: z.exactOptional(z.string()),
  }),
  thread: z.exactOptional(z.union([z.string(), z.literal(true)])),
  referrer: z.unknown().optional(),
})

const streamHandleSchema = z.object({
  chat: storedChatKey,
  bot: z.string(),
  target: storedTargetSchema,
  mode: z.string(),
  parts: z.array(storedPartSchema).min(1),
  createdAt: z.number(),
  edits: z.number().int().nonnegative(),
  state: z.unknown().optional(),
  updatedAt: z.number(),
})

/** The `im_output_summary` storage domain: one active stream handle per session id. */
export const imOutputSummaryDomain = defineDomain({
  name: 'im_output_summary',
  version: 1,
  tables: {
    streams: domainTable<string, StoredStreamHandle>(streamHandleSchema),
  },
})

export type ImOutputSummaryDomain = Domain<typeof imOutputSummaryDomain>

/** Synchronous lookup + durable persistence for resumable stream handles. */
export interface StreamHandleStore {
  /** Resumable handle for `sessionId` in `chat` (undefined if absent, wrong chat, or expired). */
  get(sessionId: SessionId, chat: ImChatKey): MessageHandle | undefined
  /** Persist or update the active handle for `sessionId`. */
  save(sessionId: SessionId, chat: ImChatKey, handle: MessageHandle): void
  /** Remove any stored handle for `sessionId`. */
  clear(sessionId: SessionId): void
}

/** Convert a live `MessageHandle` into a compact, JSON-serializable record (stripping `raw` and `content`). */
export function serializeHandle(chat: ImChatKey, handle: MessageHandle, now = Date.now()): StoredStreamHandle {
  return {
    chat,
    bot: handle.bot,
    target: {
      chat: {
        id: handle.target.chat.id,
        type: handle.target.chat.type,
        ...handle.target.chat.name === undefined ? {} : { name: handle.target.chat.name },
      },
      ...handle.target.thread === undefined ? {} : { thread: handle.target.thread },
      ...handle.target.referrer === undefined ? {} : { referrer: handle.target.referrer },
    },
    mode: handle.mode,
    parts: handle.parts.map(part => ({
      id: part.id,
      kind: part.kind,
      time: part.time,
      ...part.thread === undefined ? {} : { thread: { id: part.thread.id, ...part.thread.root === undefined ? {} : { root: part.thread.root } } },
      ...part.referrer === undefined ? {} : { referrer: part.referrer },
    })),
    createdAt: handle.createdAt,
    edits: handle.edits,
    ...handle.state === undefined ? {} : { state: handle.state },
    updatedAt: now,
  }
}

/** Reconstruct a `MessageHandle` suitable for `StreamOptions.resumeHandle` from a stored record. */
export function deserializeHandle(stored: StoredStreamHandle): MessageHandle {
  return {
    bot: stored.bot,
    target: stored.target,
    mode: stored.mode,
    parts: stored.parts.map((part): SentPart => ({
      id: part.id,
      kind: part.kind,
      time: part.time,
      ...part.thread === undefined ? {} : { thread: part.thread },
      ...part.referrer === undefined ? {} : { referrer: part.referrer },
    })),
    createdAt: stored.createdAt,
    edits: stored.edits,
    content: h('message'),
    ...stored.state === undefined ? {} : { state: stored.state },
  }
}

/** Durable `StreamHandleStore` backed by `ctx.storageDomain` with an in-memory read mirror. */
export class PersistentStreamHandleStore implements StreamHandleStore {
  private readonly cache = new Map<string, StoredStreamHandle>()
  private domain: ImOutputSummaryDomain | undefined
  private writes: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly ctx: Context,
    private readonly maxAgeMs = RESUME_HANDLE_MAX_AGE_MS,
    private readonly now = () => Date.now(),
  ) {}

  async start(): Promise<void> {
    const storage = this.ctx.get('storageDomain')
    if (storage === undefined) return
    const domain = await storage.open(imOutputSummaryDomain)
    if (this.closed) {
      await domain.close()
      return
    }
    this.domain = domain
    const cutoff = this.now() - this.maxAgeMs
    for (const [sessionId, record] of domain.table('streams').entries()) {
      if (record.updatedAt < cutoff) {
        this.enqueue(d => d.table('streams').delete(sessionId))
      } else {
        this.cache.set(sessionId, record)
      }
    }
  }

  get(sessionId: SessionId, chat: ImChatKey): MessageHandle | undefined {
    const record = this.cache.get(sessionId)
    if (record === undefined) return undefined
    if (record.chat !== chat) return undefined
    if (this.now() - record.updatedAt > this.maxAgeMs) {
      this.clear(sessionId)
      return undefined
    }
    return deserializeHandle(record)
  }

  save(sessionId: SessionId, chat: ImChatKey, handle: MessageHandle): void {
    if (handle.parts.length === 0) return
    const record = serializeHandle(chat, handle, this.now())
    this.cache.set(sessionId, record)
    this.enqueue(domain => domain.table('streams').put(sessionId, record))
  }

  clear(sessionId: SessionId): void {
    if (!this.cache.delete(sessionId)) return
    this.enqueue(domain => domain.table('streams').delete(sessionId))
  }

  async dispose(): Promise<void> {
    this.closed = true
    await this.writes
    const domain = this.domain
    this.domain = undefined
    this.cache.clear()
    await domain?.close()
  }

  private enqueue(op: (domain: ImOutputSummaryDomain) => Promise<unknown>): void {
    this.writes = this.writes.then(async () => {
      if (this.domain === undefined) return
      await op(this.domain)
    }).catch((error: unknown) => {
      this.ctx.logger.warn('IM output summary handle store write failed: %s', String(error))
    })
  }
}
