/**
 * Durable storage of the dispatch strategy (domain `im_rules`): every chat the dispatcher has seen (its read-only
 * grants survive a restart) and the route rules of its tasks, with the rule-id sequence in the domain global.
 *
 * The unit name is deliberately not `im_dispatch`: v3 published that name at version 1 with another record layout
 * (string task ids, source/app/chat fields), and a `single`-layout unit is exact-version only, so an existing v3 home
 * would fail every boot. v4 opened its own unit and left the old one untouched on the medium.
 *
 * The declaration is the plain descriptor `defineDomain` of `@deepseek-ai/dsh-storage-domain` would return (that
 * helper only checks the names and returns its argument): the facility reads `name`, `version`, `global` and each
 * table's `valueSchema.parse`, so the plugin needs no runtime import of the storage package.
 *
 * @module dsh-im-dispatch/domain
 */

import { z } from 'zod'
import type { DomainLike, KvTableLike } from './types.ts'

/** One chat (and its router delivery cursors) whose messages reached dispatch. */
export interface DispatchChat {
  /** Admitting source of the first message seen in the chat. */
  source: string
  /** Platform chat type (`direct` | `group` | `topic`). */
  type: string
  /** Cached human-readable display name of the chat (group title or DM contact name). */
  name?: string
  firstSeenAt: number
  /** Highest per-chat message seq delivered to this chat's regular router (`dispatch:chat:<chatKey>`). */
  deliveredSeq?: number
  /** Highest per-chat message seq delivered per topic thread on topic-mode chats. */
  topicCursors?: Record<string, number>
  /** Last seen `task.updatedAt` by task ID (`String(task.id)`) for this chat's regular router. */
  deliveredTasks?: Record<string, number>
  /** Inclusive lower-bound floor when pruning old entries from `deliveredTasks`. */
  deliveredTaskFloorId?: number
  /** Last seen `task.updatedAt` per topic thread on topic-mode chats. */
  topicTaskCursors?: Record<string, Record<string, number>>
  /** Per-thread pruning floors for `topicTaskCursors`. */
  topicTaskFloorIds?: Record<string, number>
  /** When unaddressed messages wake this chat's Router: `'mention'`, `'watch'` (default), or `'auto'`. */
  wakeMode?: 'mention' | 'watch' | 'auto'
  /** Whether ambient wakes may call `router_reply` (`'mention_only'` default vs `'proactive'`). */
  replyMode?: 'mention_only' | 'proactive'
  /** Group-level topics or alerts watched automatically in `'watch'` mode. */
  watchTopics?: string[]
  /** Instructions describing how matched `watchTopics` should be dispatched or handled. */
  watchNote?: string
  /** Guidelines governing proactive `router_reply` when `replyMode === 'proactive'`. */
  replyPolicy?: string
}

/** One route rule: the task worker it delivers to, its expression and how it treats the dispatcher's delivery. */
export interface RouteRule {
  id: number
  /** Task number the rule belongs to. */
  task: number
  match: string
  mode: 'copy' | 'cut'
  note?: string
  createdAt: number
  updatedAt: number
}

const chatSchema = z.object({
  source: z.string(),
  type: z.string(),
  name: z.exactOptional(z.string()),
  firstSeenAt: z.number(),
  deliveredSeq: z.exactOptional(z.number().int().nonnegative()),
  topicCursors: z.exactOptional(z.record(z.string(), z.number().int().nonnegative())),
  deliveredTasks: z.exactOptional(z.record(z.string(), z.number())),
  deliveredTaskFloorId: z.exactOptional(z.number().int().nonnegative()),
  topicTaskCursors: z.exactOptional(z.record(z.string(), z.record(z.string(), z.number()))),
  topicTaskFloorIds: z.exactOptional(z.record(z.string(), z.number().int().nonnegative())),
  wakeMode: z.exactOptional(z.enum(['mention', 'watch', 'auto'])),
  replyMode: z.exactOptional(z.enum(['mention_only', 'proactive'])),
  watchTopics: z.exactOptional(z.array(z.string())),
  watchNote: z.exactOptional(z.string()),
  replyPolicy: z.exactOptional(z.string()),
})

const ruleSchema = z.object({
  id: z.number().int().positive(),
  task: z.number().int().positive(),
  match: z.string(),
  mode: z.enum(['copy', 'cut']),
  note: z.exactOptional(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const globalSchema = z.object({ nextRule: z.number().int().positive() })

/** Dispatch storage: chats never expire and rules last until they are removed. */
export const dispatchDomain = {
  name: 'im_rules',
  version: 1,
  global: { schema: globalSchema, initial: { nextRule: 1 } },
  tables: {
    chats: { valueSchema: chatSchema },
    rules: { valueSchema: ruleSchema },
  },
} as const

/** The open dispatch store, typed. */
export interface DispatchStore {
  global: { get(): { nextRule: number }; set(value: { nextRule: number }): Promise<void> }
  chats: KvTableLike<DispatchChat>
  rules: KvTableLike<RouteRule>
  close(): Promise<void>
}

/**
 * View one open domain through the dispatch record types. The facility parsed every stored record with the schemas
 * above before it returned the handle, so the records already have these shapes.
 * @param domain - the domain the facility opened for {@link dispatchDomain}.
 * @returns the typed store.
 */
export function dispatchStore(domain: DomainLike): DispatchStore {
  return {
    global: domain.global as DispatchStore['global'],
    chats: domain.table('chats') as KvTableLike<DispatchChat>,
    rules: domain.table('rules') as KvTableLike<RouteRule>,
    close: () => domain.close(),
  }
}
