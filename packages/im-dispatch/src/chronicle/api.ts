/**
 * Public contract and ephemeral-message tracking for the prefix-cached cross-chat Chronicle (`im_chronicle`).
 *
 * Every real task creation, task route/steer, and settled outbound bot message is compacted into one concise
 * sentence by a small model, given a strictly monotonic numeric `#id`, and stored in append-only
 * sealed chunks. Queries run as non-persistent in-memory forks sharing the immutable prefix chunks and fixed
 * `sessionId` so KV prefix caches stay warm without polluting router histories or persisting query turns.
 *
 * @module dsh-im-dispatch/chronicle/api
 */

import type { ImStoredMessage } from '../types.ts'

/** Operator configuration of the cross-chat Chronicle. */
export interface ChronicleConfig {
  /** Whether Chronicle recording and `query_chronicle` are active. */
  enabled: boolean
  /** Provider route for compaction and fork queries; omitted = `dispatch.main.provider`. */
  provider?: string | undefined
  /** Model id for compaction and fork queries; omitted = `main.model`. */
  model?: string | undefined
  /** Reasoning effort for compaction and fork queries (default `'off'`). */
  reasoningEffort: string
  /** Max tokens for one compaction call. */
  compactMaxTokens: number
  /** Max tokens for one `query_chronicle` fork call. */
  queryMaxTokens: number
  /** Number of entries sealed into one immutable prefix chunk. */
  chunkSize: number
  /** High watermark of retained entries before oldest ~25% sealed chunks evict in one batch. */
  maxEntries: number
  /** Timeout for one compaction or query LLM call, in milliseconds. */
  timeoutMs: number
}

/** Category of one compacted Chronicle entry. */
export type ChronicleEntryKind = 'task_created' | 'task_routed' | 'bot_reply'

/** One compacted historical event stored in `im_chronicle`. */
export interface ChronicleEntry {
  id: number
  time: number
  kind: ChronicleEntryKind
  chat: string
  taskId?: number
  subject: string
  summary: string
  /** Pre-formatted immutable line serialized into chunk logs. */
  line: string
}

/** One immutable sealed chunk of `chunkSize` entries. */
export interface ChronicleChunk {
  startId: number
  endId: number
  count: number
  text: string
}

/** Query passed to `query_chronicle`. */
export interface ChronicleQueryRequest {
  question: string
  chat?: string
}

/** Answer returned by `query_chronicle`. */
export interface ChronicleQueryResult {
  answer: string
  entriesScanned: number
  latestId: number
}

/** Read-only summary of the Chronicle store for management panels and diagnostics. */
export interface ChronicleStatus {
  entries: number
  chunks: number
  latestId: number
  recent: ChronicleEntry[]
}

const MAX_EPHEMERAL_KEYS = 2000

/**
 * Bounded FIFO tracker of transient status / refusal / link message keys that must never enter Chronicle logs.
 */
export class EphemeralTracker {
  private readonly keys = new Set<string>()
  private readonly matchers = new Set<(text: string) => boolean>()

  /**
   * Treat every own message whose whitespace-collapsed text satisfies `matcher` as ephemeral.
   * @param matcher - test over the normalized text.
   * @returns the disposer removing the matcher.
   */
  match(matcher: (text: string) => boolean): () => void {
    this.matchers.add(matcher)
    return () => { this.matchers.delete(matcher) }
  }

  /** Whether one normalized text satisfies a registered matcher. */
  matches(text: string): boolean {
    for (const matcher of this.matchers) {
      try {
        if (matcher(text)) return true
      } catch { /* a failing matcher matches nothing */ }
    }
    return false
  }

  /** Mark a platform message key as ephemeral (safe no-op for `undefined`). */
  mark(key: string | undefined): void {
    if (key === undefined || !key.trim()) return
    this.keys.delete(key)
    if (this.keys.size >= MAX_EPHEMERAL_KEYS) {
      const oldest = this.keys.values().next().value
      if (oldest !== undefined) this.keys.delete(oldest)
    }
    this.keys.add(key)
  }

  /** Whether `key` was explicitly marked ephemeral in this process. */
  has(key: string): boolean {
    return this.keys.has(key)
  }
}

/**
 * Whether a stored self-authored message is a transient link, working status, collapsed stub, or ACL refusal that
 * should not pollute the durable Chronicle.
 *
 * Checks both {@link EphemeralTracker} and synchronous text patterns (important because `dsh-im` emits `im/stored`
 * before the `im.send()` promise resolves back to the caller).
 */
export function isEphemeralSelfMessage(message: ImStoredMessage, tracker?: EphemeralTracker): boolean {
  if (!message.sender.self) return false
  if (tracker?.has(message.key) === true) return true
  const normalized = message.text.replace(/\s+/g, ' ').trim()
  if (normalized === '') return true
  if (normalized.startsWith('⏹') || normalized.startsWith('⏳')) return true
  if (tracker?.matches(normalized) === true) return true
  if (normalized.startsWith('当前任务由 ') && normalized.includes('独占')) return true
  return false
}
