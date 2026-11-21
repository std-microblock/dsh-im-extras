/**
 * Chronicle service (`ChronicleService`): serialized monotonic `#id` compaction, sealed immutable
 * 32-entry chunks, bulk high-watermark eviction, and prefix-cache-friendly fork queries.
 *
 * @module dsh-im-dispatch/chronicle/service
 */

import type {
  ImStoredMessage, ImTaskLike, LlmServiceLike, Logger, StorageDomainLike,
} from '../types.ts'
import {
  EphemeralTracker, isEphemeralSelfMessage, type ChronicleChunk, type ChronicleConfig,
  type ChronicleEntry, type ChronicleEntryKind, type ChronicleQueryRequest, type ChronicleQueryResult,
  type ChronicleStatus,
} from './api.ts'
import { chronicleDomain, chronicleStore, entryKey, type ChronicleStore } from './domain.ts'
import {
  CHRONICLE_QUERY_SYSTEM_PROMPT, COMPACT_SYSTEM_PROMPT, compactEventInput, parseCompactedOutput, sanitizeOneLine,
} from './prompt.ts'

export interface ChronicleServiceOptions {
  storage: StorageDomainLike
  llm: () => LlmServiceLike | undefined
  defaultProvider: string
  /** Model used when `config.model` is omitted. */
  defaultModel: string
  config: ChronicleConfig
  logger: Logger
  ephemeral?: EphemeralTracker
  now?: () => number
}

interface PendingRecord {
  kind: ChronicleEntryKind
  chat: string
  taskId?: number
  subjectHint: string
  raw: string
  time: number
  dedupKey?: string
}

const MAX_SEEN_KEYS = 4000

/** Format timestamp `[YYYY-MM-DD HH:mm]` in local or UTC consistently. */
function formatMinute(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Combine an optional external AbortSignal with a bounded timeout. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const onAbort = () => { controller.abort(signal?.reason ?? new Error('aborted')) }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => { controller.abort(new Error(`chronicle request timed out after ${timeoutMs}ms`)) }, timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

export class ChronicleService {
  readonly ephemeral: EphemeralTracker
  private readonly config: ChronicleConfig
  private readonly defaultProvider: string
  private readonly defaultModel: string
  private readonly llm: () => LlmServiceLike | undefined
  private readonly logger: Logger
  private readonly now: () => number
  private readonly opened: Promise<ChronicleStore>
  private readonly seenKeys = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(options: ChronicleServiceOptions) {
    this.config = options.config
    this.defaultProvider = options.defaultProvider
    this.defaultModel = options.defaultModel
    this.llm = options.llm
    this.logger = options.logger
    this.ephemeral = options.ephemeral ?? new EphemeralTracker()
    this.now = options.now ?? (() => Date.now())
    this.opened = options.storage.open(chronicleDomain).then(chronicleStore)
    this.opened.catch(() => {})
  }

  /** Wait for pending compactions and close the storage domain. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.chain.catch(() => {})
    const store = await this.opened.catch(() => undefined)
    await store?.close()
  }

  /** Mark a message key as transient status/refusal so `onStored` skips it. */
  markEphemeral(key: string | undefined): void {
    this.ephemeral.mark(key)
  }

  /** Record a newly started task (triggered on `im/task/started`). */
  onTaskStarted(task: ImTaskLike): void {
    if (!this.config.enabled || this.disposed) return
    const summaryParts = [task.title]
    if (task.description) summaryParts.push(task.description)
    this.enqueue({
      kind: 'task_created',
      chat: task.chat,
      taskId: task.id,
      subjectHint: task.title,
      raw: summaryParts.join(' — '),
      time: task.createdAt || this.now(),
      dedupKey: `task_created:${task.id}`,
    })
  }

  /** Record a router-to-task handoff or steer. */
  recordTaskRouted(task: ImTaskLike, chat: string, detail: string, dedupKey?: string): void {
    if (!this.config.enabled || this.disposed) return
    this.enqueue({
      kind: 'task_routed',
      chat,
      taskId: task.id,
      subjectHint: `任务 #${task.id} ${task.title}`,
      raw: detail,
      time: this.now(),
      ...dedupKey === undefined ? {} : { dedupKey },
    })
  }

  /** Record a real bot outbound message observed in `im/stored` (skipping ephemeral cards/links/refusals). */
  onStored(message: ImStoredMessage): void {
    if (!this.config.enabled || this.disposed) return
    if (!message.sender.self) return
    if (isEphemeralSelfMessage(message, this.ephemeral)) return
    const text = message.text.trim()
    if (!text) return
    this.enqueue({
      kind: 'bot_reply',
      chat: message.chat.key,
      subjectHint: `Bot reply in ${message.chat.key}`,
      raw: text,
      time: message.time || this.now(),
      dedupKey: `bot_reply:${message.key}`,
    })
  }

  /** Flush all queued compactions (useful in tests and graceful handoffs). */
  async flush(): Promise<void> {
    await this.chain
  }

  /** Read a snapshot of Chronicle size and recent entries for the management panel. */
  async status(): Promise<ChronicleStatus> {
    const store = await this.opened
    const entries = [...store.entries.entries()].map(([, v]) => v).sort((a, b) => a.id - b.id)
    const latest = entries[entries.length - 1]
    return {
      entries: entries.length,
      chunks: store.chunks.size,
      latestId: latest?.id ?? 0,
      recent: entries.slice(-20).reverse(),
    }
  }

  /**
   * Browse the stored entries, newest first.
   * @param filter - optional chat key, an id cursor (`before`, exclusive), a case-insensitive text match and a page size.
   * @returns one page of entries, the cursor of the next page, and how many entries match in total.
   */
  async entries(filter: { chat?: string; before?: number; query?: string; limit?: number } = {}): Promise<{
    entries: ChronicleEntry[]
    total: number
    next?: number
  }> {
    const store = await this.opened
    const needle = filter.query?.trim().toLowerCase()
    const matching = [...store.entries.entries()].map(([, v]) => v)
      .filter(entry => filter.chat === undefined || entry.chat === filter.chat)
      .filter(entry => !needle || `${entry.subject} ${entry.summary}`.toLowerCase().includes(needle))
      .sort((a, b) => b.id - a.id)
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50))
    const page = matching.filter(entry => filter.before === undefined || entry.id < filter.before).slice(0, limit)
    const last = page[page.length - 1]
    const more = last !== undefined && matching.some(entry => entry.id < last.id)
    return { entries: page, total: matching.length, ...more ? { next: last.id } : {} }
  }

  /**
   * Fork-query the immutable Chronicle prefix without appending the query or answer into the durable store.
   *
   * Prefix-cache stability guarantees:
   * - constant `system: CHRONICLE_QUERY_SYSTEM_PROMPT`
   * - `tools: undefined`
   * - sticky `sessionId: store.global.get().sessionSalt`
   * - sealed immutable chunks as individual `user` messages in fixed ascending order
   * - trailing `<query>` appended only in memory for this single call
   */
  async query(req: ChronicleQueryRequest, externalSignal?: AbortSignal): Promise<ChronicleQueryResult> {
    if (!this.config.enabled) {
      return { answer: '工作日志（Chronicle）当前已关闭。', entriesScanned: 0, latestId: 0 }
    }
    const question = req.question.trim()
    if (!question) {
      return { answer: '请提供要查询的问题。', entriesScanned: 0, latestId: 0 }
    }
    await this.chain.catch(() => {})
    const store = await this.opened
    const allEntries = [...store.entries.entries()].map(([, v]) => v).sort((a, b) => a.id - b.id)
    if (allEntries.length === 0) {
      return { answer: '目前工作日志（Chronicle）中还没有任何记录。', entriesScanned: 0, latestId: 0 }
    }
    const latestId = allEntries[allEntries.length - 1]!.id
    const chunks = [...store.chunks.entries()].map(([, v]) => v).sort((a, b) => a.startId - b.startId)
    const sealedEndId = chunks.length === 0 ? 0 : chunks[chunks.length - 1]!.endId
    const tail = allEntries.filter(entry => entry.id > sealedEndId)

    const llm = this.llm()
    if (llm === undefined) {
      return {
        answer: this.fallbackSearch(allEntries, question, req.chat),
        entriesScanned: allEntries.length,
        latestId,
      }
    }

    const messages = [
      ...chunks.map(chunk => ({
        role: 'user' as const,
        content: [{ type: 'text', text: chunk.text }],
      })),
      ...tail.length === 0
        ? []
        : [{
            role: 'user' as const,
            content: [{ type: 'text', text: tail.map(entry => entry.line).join('\n') }],
          }],
      {
        role: 'user' as const,
        content: [{
          type: 'text',
          text: `<query${req.chat ? ` chat="${escapeAttr(req.chat)}"` : ''}>\n${question}\n</query>`,
        }],
      },
    ]

    const { signal, dispose } = withTimeout(externalSignal, this.config.timeoutMs)
    try {
      const prepared = await llm.prepareCall({
        provider: this.provider(),
        model: this.config.model ?? this.defaultModel,
        reasoningEffort: this.config.reasoningEffort,
        maxTokens: this.config.queryMaxTokens,
      }, signal)
      signal.throwIfAborted()
      let answer = ''
      for await (const chunk of prepared.stream({
        ...prepared.config,
        sessionId: store.global.get().sessionSalt,
        system: CHRONICLE_QUERY_SYSTEM_PROMPT,
        tools: undefined,
        messages,
        signal,
      })) {
        signal.throwIfAborted()
        if (chunk.type === 'text-delta' && typeof (chunk as { text?: unknown }).text === 'string') {
          answer += (chunk as { text: string }).text
        } else if (chunk.type === 'finish') {
          const reason = (chunk as { reason?: { kind: string; failure?: { message: string } } }).reason
          if (reason !== undefined && (reason.kind === 'error' || reason.kind === 'aborted')) {
            throw new Error(reason.failure?.message ?? `chronicle fork finished with ${reason.kind}`)
          }
        }
      }
      const trimmed = answer.trim()
      return {
        answer: trimmed || '未找到相关记录。',
        entriesScanned: allEntries.length,
        latestId,
      }
    } catch (error) {
      this.logger.warn('im-dispatch: chronicle fork query failed, falling back to local scan: %s', String(error))
      return {
        answer: this.fallbackSearch(allEntries, question, req.chat),
        entriesScanned: allEntries.length,
        latestId,
      }
    } finally {
      dispose()
    }
  }

  private provider(): string {
    return this.config.provider?.trim() || this.defaultProvider
  }

  private enqueue(item: PendingRecord): void {
    if (item.dedupKey !== undefined) {
      if (this.seenKeys.has(item.dedupKey)) return
      if (this.seenKeys.size >= MAX_SEEN_KEYS) {
        const oldest = this.seenKeys.values().next().value
        if (oldest !== undefined) this.seenKeys.delete(oldest)
      }
      this.seenKeys.add(item.dedupKey)
    }
    const next = this.chain.then(() => this.append(item))
    this.chain = next.then(() => {}, (err: unknown) => {
      this.logger.warn('im-dispatch: chronicle compaction failed: %s', String(err))
    })
  }

  private async append(item: PendingRecord): Promise<void> {
    if (this.disposed) return
    const store = await this.opened
    const compacted = await this.compact(item)
    const globalState = store.global.get()
    const id = globalState.nextId
    await store.global.set({ ...globalState, nextId: id + 1 })

    const taskTag = item.taskId === undefined ? '' : ` task:#${item.taskId}`
    const line = `#${id} [${formatMinute(item.time)}] [${item.kind}${taskTag}] [chat=${item.chat}] ${compacted.subject} — ${compacted.summary}`
    const entry: ChronicleEntry = {
      id,
      time: item.time,
      kind: item.kind,
      chat: item.chat,
      ...item.taskId === undefined ? {} : { taskId: item.taskId },
      subject: compacted.subject,
      summary: compacted.summary,
      line,
    }
    await store.entries.put(entryKey(id), entry)
    await this.sealAndEvict(store)
  }

  /** Seal full `chunkSize` chunks into immutable records; bulk-evict oldest ~25% chunks only at high watermark. */
  private async sealAndEvict(store: ChronicleStore): Promise<void> {
    const chunkSize = Math.max(1, this.config.chunkSize)
    const entries = [...store.entries.entries()].map(([, v]) => v).sort((a, b) => a.id - b.id)
    const chunks = [...store.chunks.entries()].map(([, v]) => v).sort((a, b) => a.startId - b.startId)
    let sealedEnd = chunks.length === 0 ? 0 : chunks[chunks.length - 1]!.endId
    let tail = entries.filter(entry => entry.id > sealedEnd)

    while (tail.length >= chunkSize) {
      const batch = tail.slice(0, chunkSize)
      const startId = batch[0]!.id
      const endId = batch[batch.length - 1]!.id
      const chunk: ChronicleChunk = {
        startId,
        endId,
        count: batch.length,
        text: batch.map(entry => entry.line).join('\n'),
      }
      await store.chunks.put(entryKey(startId), chunk)
      chunks.push(chunk)
      sealedEnd = endId
      tail = tail.slice(chunkSize)
    }

    if (entries.length > this.config.maxEntries && chunks.length > 0) {
      const targetEvict = Math.max(chunkSize, Math.floor(this.config.maxEntries * 0.25))
      let evictedCount = 0
      let evictedEndId = 0
      const dropChunks: ChronicleChunk[] = []
      for (const chunk of chunks) {
        if (evictedCount >= targetEvict && dropChunks.length > 0) break
        dropChunks.push(chunk)
        evictedCount += chunk.count
        evictedEndId = chunk.endId
      }
      for (const chunk of dropChunks) {
        await store.chunks.delete(entryKey(chunk.startId))
      }
      for (const entry of entries) {
        if (entry.id <= evictedEndId) await store.entries.delete(entryKey(entry.id))
      }
      const globalState = store.global.get()
      await store.global.set({
        ...globalState,
        sessionSalt: `im-chronicle-v1-${evictedEndId + 1}`,
      })
    }
  }

  private async compact(item: PendingRecord): Promise<{ subject: string; summary: string }> {
    const llm = this.llm()
    if (llm === undefined) {
      return {
        subject: sanitizeOneLine(item.subjectHint, 48),
        summary: sanitizeOneLine(item.raw, 220),
      }
    }
    const { signal, dispose } = withTimeout(undefined, this.config.timeoutMs)
    try {
      const prepared = await llm.prepareCall({
        provider: this.provider(),
        model: this.config.model ?? this.defaultModel,
        reasoningEffort: this.config.reasoningEffort,
        maxTokens: this.config.compactMaxTokens,
      }, signal)
      let text = ''
      for await (const chunk of prepared.stream({
        ...prepared.config,
        system: COMPACT_SYSTEM_PROMPT,
        tools: undefined,
        messages: [{ role: 'user', content: [{ type: 'text', text: compactEventInput(item) }] }],
        signal,
      })) {
        if (chunk.type === 'text-delta' && typeof (chunk as { text?: unknown }).text === 'string') {
          text += (chunk as { text: string }).text
        } else if (chunk.type === 'finish') {
          const reason = (chunk as { reason?: { kind: string; failure?: { message: string } } }).reason
          if (reason !== undefined && (reason.kind === 'error' || reason.kind === 'aborted')) {
            throw new Error(reason.failure?.message ?? `chronicle compact finished with ${reason.kind}`)
          }
        }
      }
      return parseCompactedOutput(text, item.subjectHint, item.raw)
    } catch (error) {
      this.logger.warn('im-dispatch: chronicle LLM compaction fallback (%s): %s', item.kind, String(error))
      return {
        subject: sanitizeOneLine(item.subjectHint, 48),
        summary: sanitizeOneLine(item.raw, 220),
      }
    } finally {
      dispose()
    }
  }

  private fallbackSearch(entries: readonly ChronicleEntry[], question: string, chat?: string): string {
    const tokens = question.toLowerCase().split(/\s+/).filter(token => token.length >= 2)
    const scoped = chat === undefined ? entries : entries.filter(entry => entry.chat === chat || entry.chat.endsWith(`|${chat}`))
    const pool = scoped.length > 0 ? scoped : entries
    const matches = pool.filter((entry) => {
      if (tokens.length === 0) return true
      const haystack = entry.line.toLowerCase()
      return tokens.some(token => haystack.includes(token))
    })
    const picked = (matches.length > 0 ? matches : pool).slice(-10)
    return picked.map(entry => entry.line).join('\n')
  }
}
