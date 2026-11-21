/**
 * Contract of the dispatch strategy: one read-only router session per chat (per topic on topic-mode chats) that reads
 * every admitted message and routes it, the workers it starts through `ctx.imTasks`, JavaScript route rules, and the
 * tools both sides use.
 *
 * A router (`key: 'dispatch:chat:<chat key>'` or `'dispatch:topic:<chat key>:<thread>'`, owner `dispatch`) holds a
 * read-only binding to its chat and publishes nothing by itself: its output renderer is `none`, and it speaks only
 * through `router_reply`. Route rules are per task worker, evaluated against every admitted message of the chats that
 * worker reads; `copy` keeps the router's own delivery and `cut` withholds it.
 *
 * The owner name, the storage unit (`im_rules`), the tool names and the rule language are stable, so a deployment keeps
 * its routers, its chats and its rules across versions.
 *
 * @module dsh-im-dispatch/api
 */

import type { ChronicleConfig } from './chronicle/api.ts'
export type { ChronicleConfig } from './chronicle/api.ts'

/** Legacy global dispatcher key retained for backward compatibility in key checks. */
export const DISPATCHER_KEY = 'dispatch:main'
/** Session key prefix for per-chat (group / direct) router sessions. */
export const DISPATCHER_CHAT_PREFIX = 'dispatch:chat:'
/** Session key prefix for per-topic router sessions on topic-mode chats. */
export const DISPATCHER_TOPIC_PREFIX = 'dispatch:topic:'
/** Owner name of all dispatch router sessions. */
export const DISPATCHER_OWNER = 'dispatch'
/** Outcome attribution of a message this strategy routed. */
export const BY = DISPATCHER_OWNER

/**
 * Resolve the stable IM session key of the router serving one chat (or topic).
 * Regular groups and DMs share one router per chat (`dispatch:chat:<chatKey>`); topic-mode chats
 * isolate each topic (`dispatch:topic:<chatKey>:<threadId>`).
 */
export function routerKeyOf(chat: { key: string; ref: { type: string } }, threadId?: string): string {
  if (chat.ref.type === 'topic' && threadId !== undefined && threadId !== '') {
    return `${DISPATCHER_TOPIC_PREFIX}${chat.key}:${threadId}`
  }
  return `${DISPATCHER_CHAT_PREFIX}${chat.key}`
}

/** Whether a hosted session key belongs to any dispatch router (per-chat, per-topic, or legacy global). */
export function isRouterKey(key: string): boolean {
  return key === DISPATCHER_KEY
    || key.startsWith(DISPATCHER_CHAT_PREFIX)
    || key.startsWith(DISPATCHER_TOPIC_PREFIX)
}

/** Dispatcher-only tools denied to workers (workers receive direct replies via IM tools instead). */
export const ROUTER_ONLY_TOOLS = [
  'router_reply',
  'create_task',
  'route_messages_to_task',
  'steer_task',
  'list_tasks',
  'configure_chat',
] as const

/**
 * Tools each chat router keeps by default: direct router replies, task delegation/steering, per-chat
 * configuration, cross-chat Chronicle queries, route-rule oversight, history search and read-only IM tools. Every
 * name must exist in the preset.
 */
export const DISPATCHER_TOOLS = [
  'router_reply',
  'create_task',
  'route_messages_to_task',
  'steer_task',
  'list_tasks',
  'configure_chat',
  'query_chronicle',
  'list_route_rules',
  'remove_route_rule',
  'im_search',
  'im_read',
  'im_history',
  'im_members',
  'im_read_image',
]

/**
 * Tools registered for task workers by default: self-profile declaration (`task_describe`), cross-chat Chronicle
 * query, route-rule management, history search, and IM read tools.
 */
export const WORKER_TOOLS = [
  'task_describe',
  'query_chronicle',
  'add_route_rule',
  'update_route_rule',
  'list_route_rules',
  'remove_route_rule',
  'im_search',
  'im_read',
  'im_history',
  'im_members',
  'im_read_image',
]

/** The composition of one kind of dispatch session. */
export interface DispatchComposition {
  /** Preset mounted into the session. */
  agentPreset: string
  /** Explicit model-provider route. */
  provider: string
  /** Model ID on the configured provider route. */
  model: string
  /** Absolute working directory. */
  cwd: string
}

/**
 * Operator configuration of the strategy (the `dispatch` section of the plugin config).
 *
 * The prompt texts are preset configuration, not code: an operator replaces either guidance text here instead of
 * forking the plugin.
 */
export interface DispatchConfig {
  /** The dispatcher session: its composition and the only tools it keeps. */
  main: DispatchComposition
  /** The task workers the dispatcher starts. */
  worker: DispatchComposition
  /** Output renderer of task workers; `none` means a worker publishes only with the IM tools. */
  workerOutput: string
  /** System-prompt guidance of each side. */
  prompts: {
    /** Guidance shown to the dispatcher; omitted = the shipped text. */
    main?: string | undefined
    /** Guidance shown to task workers; omitted = the shipped text. */
    worker?: string | undefined
  }
  /** Which tools are registered for each role; `main` also restricts the dispatcher composition. */
  tools: {
    /** Tools the dispatcher may call. */
    main: string[]
    /** Tools a task worker may call. */
    worker: string[]
  }
  /** Wall-clock budget of one rule against one message, in milliseconds. */
  ruleTimeoutMs: number
  /** Heap limit of the QuickJS runtime that evaluates the rules of one message, in bytes. */
  ruleMemoryBytes: number
  /** Maximum characters of one rule expression or rule note. */
  maxRuleChars: number
  /** Maximum route rules one task holds. */
  maxRulesPerTask: number
  /** Maximum messages one task start hands over. */
  maxTaskMessages: number
  /** Messages of context read before and after the handed-over ones. */
  contextMessages: number
  /** Maximum history pages one `im_search` reads. */
  maxSearchPages: number
  /** Messages one history page of `im_search` holds. */
  searchPageSize: number
  /** Automatically confine new non-direct group tasks on main-timeline messages to reply threads. */
  autoThread: boolean
  /**
   * Platforms (the `platform` prefix of a bot id, `qq` in `qq:123`) whose chats have no reply threads: `autoThread`
   * never confines a task there. A bot whose `supports('message.thread')` answers `false` is treated the same way.
   */
  threadlessPlatforms: string[]
  /** Soft/hard per-turn step budget for group router sessions (default 5). */
  maxRouterSteps: number
  /** Maximum unread messages batched into one router wake delta. */
  maxRouterDeltaMessages: number
  /** Recent messages backfilled when a router wakes with no prior cursor (first run or post-reset). */
  freshContextMessages: number
  /** Optional display-name overrides keyed by global chat key (`bot|chatId`) or platform chat id. */
  chatNames: Record<string, string>
  /** Debounce window (ms) before ambient unaddressed chatter/alerts wake a `watch`/`auto` chat router. */
  ambientDebounceMs: number
  /** Maximum proactive `router_reply` sends allowed per hour on `ambient` wakes when `replyMode === 'proactive'`. */
  maxAutoRepliesPerHour: number
  /** Prefix-cached cross-chat Chronicle configuration. */
  chronicle: ChronicleConfig
}

/** When unaddressed group messages wake a chat's Router session. */
export type ChatWakeMode = 'mention' | 'watch' | 'auto'

/** Whether an ambient (unaddressed) wake may call `router_reply` to speak directly in the chat. */
export type ChatReplyMode = 'mention_only' | 'proactive'

/** Effective chat wake/watch/reply configuration returned by `configure_chat` and panel snapshots. */
export interface ChatConfigView {
  chat: string
  name?: string
  wakeMode: ChatWakeMode
  replyMode: ChatReplyMode
  watchTopics: string[]
  watchNote?: string
  replyPolicy?: string
}

/** Input accepted by `configure_chat`. */
export interface ConfigureChatRequest {
  chat?: string
  wakeMode?: ChatWakeMode
  replyMode?: ChatReplyMode
  watchTopics?: readonly string[]
  watchNote?: string
  replyPolicy?: string
}

/** Whether a matching message still reaches the dispatcher (`copy`) or only the task (`cut`). */
export type RouteRuleMode = 'copy' | 'cut'

/** One route rule as the tools report it. */
export interface RouteRuleView {
  /** Rule ID, unique within the deployment. */
  id: number
  /** Number of the task the rule delivers to. */
  task: number
  /** JavaScript expression over `im`. */
  match: string
  mode: RouteRuleMode
  note?: string
  /** Evaluations that failed since this process started. */
  errors?: number
  /** The latest of those failures. */
  lastError?: string
}

/** What a worker asks of one new rule. */
export interface RouteRuleRequest {
  /** JavaScript expression over `im`; omission matches every message of the task's chats. */
  match?: string
  mode: RouteRuleMode
  note?: string
}

/** A history search through one rule expression. */
export interface RuleSearchRequest {
  /** JavaScript expression over `im`. */
  match: string
  /** Chat key (`bot|chatId`) or bare platform chat id; omitted = the chat of the current turn. */
  chat?: string
  /** Opaque cursor returned as `next` by the previous search. */
  cursor?: string
  /** History pages to read, newest first. */
  pages: number
}

/** One message as the tools show it. */
export interface MessageView {
  /** Transcript number of the message inside its chat. */
  seq: number
  from: string
  time: number
  text: string
}

/** Matching history messages, with the evaluations that failed. */
export interface RuleSearch {
  messages: MessageView[]
  /** Messages whose evaluation ran. */
  scanned: number
  /** Cursor continuing the search further back. */
  next?: string
  /** Messages whose evaluation failed, and the first failure. */
  errors?: { count: number; first: string }
}

/** What a caller asks one new task to be (the `create_task` tool). */
export interface TaskRequest {
  title: string
  /** Chat key or bare platform chat id; omitted = the chat of the current turn. */
  chat?: string
  /** Message references in that chat: `#seq`, a platform message id, or a message key. */
  messages?: readonly string[]
  /** A contiguous run of that chat, both ends included, instead of listing many references. */
  range?: { from: string; to: string }
  signal?: AbortSignal
}

/** One message reference of `route_messages_to_task`. */
export interface MessageRefInput {
  /** Chat key or bare platform chat id; omitted = the chat of the current turn. */
  chat?: string
  /** `#seq`, a platform message id, or a message key. */
  message: string
}
