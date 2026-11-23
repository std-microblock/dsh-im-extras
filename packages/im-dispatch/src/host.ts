/**
 * The dispatch host: per-chat / per-topic read-only router sessions, 3-tier inbound routing (QuickJS RouteRules ->
 * Hybrid automatic thread follow-up -> Per-chat full-context delta router), dynamic thread-id learning, cross-chat
 * worker continuity, 5-step router guardrail, and prefix-cached Chronicle integration.
 *
 * @module dsh-im-dispatch/host
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { newQuickJSWASMModule, type QuickJSWASMModule } from '@tootallnate/quickjs-emscripten'
import { EphemeralTracker, isEphemeralSelfMessage, type ChronicleQueryResult, type ChronicleService, type ChronicleStatus } from './chronicle/index.ts'
import type {
  AgentLike, ChatRefLike, ContentBlockLike, DispatchIm, ImBindingLike, ImChatLike, ImCompositionLike, ImHostedRecord,
  ImMessageEventLike, ImOutcomeLike, ImReactionEventLike, ImSessionSpecLike, ImStoredMessage, ImTaskLike,
  ImTaskStartLike, ImTasksLike, Logger, PreStepDecisionLike, PreStepMessageLike, SessionAclLike, SessionAuthLike,
  SkillRegistryLike, StorageDomainLike,
} from './types.ts'
import {
  BY, DISPATCHER_CHAT_PREFIX, DISPATCHER_KEY, DISPATCHER_OWNER, DISPATCHER_TOPIC_PREFIX, isRouterKey, routerKeyOf,
  type ChatConfigView, type ChatReplyMode, type ChatWakeMode, type ConfigureChatRequest, type DispatchConfig,
  type MessageRefInput, type MessageView, type RouteRuleMode, type RouteRuleRequest, type RouteRuleView,
  type RuleSearch, type RuleSearchRequest, type TaskRequest,
} from './api.ts'
import { dispatchDomain, dispatchStore, type DispatchChat, type DispatchStore, type RouteRule } from './domain.ts'
import { ImError, messageKey, operationId, splitKey } from './im.ts'
import { DEFAULT_DISPATCHER_PROMPT, workerPrompt } from './prompt.ts'
import { RuleEngine, ruleInput, type RuleInput, type RuleOutcome } from './rules.ts'
import { SkillCommandResolver, parseSlashInvocation, renderSkillContentBlock, type SlashSkillView } from './skills.ts'
import { formatRouterSessionTitle, formatTaskSessionTitle, type ChatTitleInfo } from './titles.ts'

/** Why one message was delivered to a task session. */
export type DeliveryCause =
  | { kind: 'rule'; rules: { id: number; mode: RouteRuleMode; match: string; note?: string; taskId: number }[] }
  | { kind: 'dispatch'; taskId: number }
  | { kind: 'thread'; taskId: number }

const MAX_DELIVERY_CAUSES = 2000
const MAX_REFUSAL_TIMESTAMPS = 1000
const REFUSAL_THROTTLE_MS = 15_000
const MAX_ACTIVE_TASK_SUMMARY = 15
const MAX_TASK_DELTA = 30
const MAX_TRACKED_TASK_VERSIONS = 1000
const MAX_CHAT_TOPICS = 20
const MAX_CHAT_TEXT_CHARS = 500
const PROACTIVE_WINDOW_MS = 3_600_000
const CHAT_NAME_PROBE_INTERVAL_MS = 10 * 60_000
const CHAT_NAME_PROBE_TIMEOUT_MS = 3000

/**
 * Source of the guardrail notice injected into a router step. `source` is not optional in practice: a later
 * `agent/pre-step` listener reads `message.source.kind` on every claimed message, so a bare `{ role, content }`
 * takes the whole turn — and the messages it was carrying — down with a `Cannot read properties of undefined`
 * error. `form: 'notice'` matches the harness vocabulary for a one-line account of what happened.
 */
const GUARDRAIL_SOURCE = 'im-dispatch'

/**
 * The step-limit notice as a message the loop and every later listener can consume: an identity, and the source
 * kind above.
 * @param text - the notice text.
 * @returns the user-role notice message to append to the step's decision.
 */
function guardrailNotice(text: string): PreStepMessageLike {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { kind: GUARDRAIL_SOURCE, form: 'notice', summary: 'Router 步数上限提醒' },
  }
}
const MAX_PENDING_REACTIONS = 100
const MAX_USER_NAMES = 4000
const REACTION_PREVIEW_CHARS = 80

const ROUTER_REACTION_NOTICE = '<reaction-notice>本批上下文包含他人对机器人消息的表情回应（reaction）。如仅为普通点赞/已阅/认可（如 THUMBSUP、OK、DONE、SMILE 等）且上下文无需进一步处理，请不调用任何工具直接结束本轮保持沉默，避免客套刷屏；若表情表达了疑问、否定、催促或命中前文约定的确认信号，请按需用 router_reply 或派发任务跟进。</reaction-notice>'
const WORKER_REACTION_NOTICE = '<reaction-notice>以下为他人对你发出消息的表情回应（reaction）。如仅为普通点赞/已阅且无需进一步动作，请调用 no_output 保持静默；若包含疑问、否定或需要跟进的确认信号，再按需处理或回复。</reaction-notice>'

type RouterWakeKind = 'direct' | 'ambient' | 'reaction'

interface PendingReaction {
  id: string
  action: 'added' | 'removed'
  emoji: string
  userId: string
  userName?: string
  message: ImStoredMessage
  time: number
}

interface Candidate {
  rule: RouteRule
  task: ImTaskLike
}

type Role =
  | { kind: 'dispatcher'; record: ImHostedRecord }
  | { kind: 'worker'; record: ImHostedRecord; task: ImTaskLike }

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function clock(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function previewText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(collapsed)
  return chars.length > REACTION_PREVIEW_CHARS ? `${chars.slice(0, REACTION_PREVIEW_CHARS - 1).join('')}…` : collapsed
}

function pushPendingReaction(list: PendingReaction[], entry: PendingReaction): void {
  if (list.some(item => item.id === entry.id)) return
  for (let i = list.length - 1; i >= 0; i--) {
    const existing = list[i]!
    if (
      existing.userId === entry.userId
      && existing.message.key === entry.message.key
      && existing.emoji === entry.emoji
      && existing.action !== entry.action
    ) {
      list.splice(i, 1)
      return
    }
  }
  if (list.length >= MAX_PENDING_REACTIONS) list.shift()
  list.push(entry)
}

function senderName(message: ImStoredMessage): string {
  return message.sender.name?.trim() || message.sender.id
}

function dropRecordKey<V>(map: Record<string, V> | undefined, key: string): Record<string, V> | undefined {
  if (map === undefined || !(key in map)) return map
  const next = { ...map }
  delete next[key]
  return Object.keys(next).length === 0 ? undefined : next
}


function isDirectType(type: string): boolean {
  return type === 'direct' || type === 'private'
}

/** Whether a message carries a thread or root reference matching `binding.thread`. */
function matchesBindingThread(binding: ImBindingLike, message: ImStoredMessage): boolean {
  if (binding.thread === undefined) return false
  if (message.thread?.id === binding.thread) return true
  if (message.thread?.root === binding.thread) return true
  if (message.quote !== undefined && splitKey(message.quote.key).id === binding.thread) return true
  return false
}

/**
 * Compute updated worker bindings so the chats (and desired threads) of `messages` are writable,
 * granting chat-wide read-only access alongside thread-confined writes on newly added non-topic group chats.
 */
function computeWritableBindings(
  bindings: readonly ImBindingLike[],
  messages: readonly ImStoredMessage[],
  resolveThread: (msg: ImStoredMessage) => string | undefined,
  confines: (msg: ImStoredMessage) => boolean,
): ImBindingLike[] | undefined {
  let next = bindings.map(b => ({ ...b }))
  let changed = false

  for (const msg of messages) {
    const chat = msg.chat.key
    const desiredThread = resolveThread(msg)
    const chatBindings = next.filter(b => b.chat === chat)

    if (chatBindings.length === 0) {
      // Brand new chat (e.g., cross-chat routing): allow reading the entire new group when thread-confining writes.
      if (desiredThread !== undefined && msg.chat.ref.type !== 'topic') {
        next.push({ chat, writable: false })
        next.push({ chat, writable: true, thread: desiredThread })
      } else {
        next.push({ chat, writable: true, ...desiredThread === undefined ? {} : { thread: desiredThread } })
      }
      changed = true
      continue
    }

    if (chatBindings.some(b => b.writable && b.thread === undefined)) {
      continue
    }

    if (desiredThread === undefined) {
      const roOpen = next.find(b => b.chat === chat && !b.writable && b.thread === undefined)
      if (roOpen !== undefined) {
        roOpen.writable = true
      } else {
        next.push({ chat, writable: true })
      }
      changed = true
      continue
    }

    // Desired thread specified: check existing thread bindings first.
    const exactMatch = next.find(b => b.chat === chat && b.thread === desiredThread)
    if (exactMatch !== undefined) {
      if (!exactMatch.writable) {
        exactMatch.writable = true
        changed = true
      }
      continue
    }

    // Did we already bind the root message ID (or quote target) for this thread?
    const rootMatch = next.find(b => b.chat === chat && (
      (msg.thread?.root !== undefined && b.thread === msg.thread.root)
      || (msg.quote !== undefined && b.thread === splitKey(msg.quote.key).id)
    ))
    if (rootMatch !== undefined) {
      if (!rootMatch.writable) {
        rootMatch.writable = true
        changed = true
      }
      next.push({ chat, writable: true, thread: desiredThread })
      changed = true
      continue
    }

    const roOpen = next.find(b => b.chat === chat && !b.writable && b.thread === undefined)
    if (roOpen !== undefined && !confines(msg)) {
      roOpen.writable = true
      changed = true
      continue
    }

    next.push({ chat, writable: true, thread: desiredThread })
    changed = true
  }

  return changed ? next : undefined
}

export function messageView(message: ImStoredMessage): MessageView {
  return { seq: message.seq, from: senderName(message), time: message.time, text: message.text }
}

/** Session spec of one per-chat or per-topic router. */
function routerSpec(
  key: string,
  config: DispatchConfig,
  chatKey: string,
  threadId?: string,
): ImSessionSpecLike {
  return {
    key,
    owner: DISPATCHER_OWNER,
    composition: {
      agentPreset: config.main.agentPreset,
      provider: config.main.provider,
      model: config.main.model,
      cwd: config.main.cwd,
      restrict: { allow: [...config.tools.main] },
    },
    bindings: [{
      chat: chatKey,
      writable: false,
      home: true,
      ...threadId === undefined ? {} : { thread: threadId },
    }],
    output: 'none',
  }
}

const TASK_OWNER_TOOLS = ['task_start', 'task_list', 'task_message']

function workerComposition(config: DispatchConfig): ImCompositionLike {
  const { agentPreset, provider, model, cwd } = config.worker
  const deny = [
    ...config.tools.main.filter(name => !config.tools.worker.includes(name)),
    ...TASK_OWNER_TOOLS.filter(name => !config.tools.worker.includes(name)),
  ]
  return {
    agentPreset,
    provider,
    model,
    cwd,
    ...deny.length === 0 ? {} : { restrict: { deny } },
  }
}

interface Opened {
  store: DispatchStore
  engine: RuleEngine
}

function refusalContent(owner?: { id: string; name?: string }): unknown {
  return {
    type: 'p',
    attrs: {},
    children: [
      { type: 'text', attrs: { content: '当前任务由 ' }, children: [] },
      owner?.id
        ? { type: 'at', attrs: { type: 'user', id: owner.id, ...owner.name ? { name: owner.name } : {} }, children: [] }
        : { type: 'text', attrs: { content: owner?.name || '其他成员' }, children: [] },
      { type: 'text', attrs: { content: ' 独占，如需协作请让其 @bot 授权给你，或另开新消息 @bot。' }, children: [] },
    ],
  }
}

/** Observers of the host's decisions and contributors to its guidance, wired by the plugin entry. */
export interface DispatchHostHooks {
  /** One message was delivered to a task worker, and why. */
  delivered?(sessionId: string, messageKey: string, cause: DeliveryCause): void
  /** A route rule was added, changed or removed (by a worker, a router or an operator). */
  ruleChanged?(change: 'added' | 'changed' | 'removed', rule: RouteRuleView): void
  /** A chat's wake/reply configuration changed. */
  chatConfigured?(view: ChatConfigView): void
  /** Extra guidance appended to the shipped (or configured) prompt of one role. */
  prompts?(role: 'router' | 'worker'): readonly string[]
}

export interface DispatchHostOptions {
  im: DispatchIm
  tasks: ImTasksLike
  storage: StorageDomainLike
  logger: Logger
  config: DispatchConfig
  auth?: () => SessionAuthLike | undefined
  skills?: () => SkillRegistryLike | undefined
  chronicle?: ChronicleService
  ephemeral?: EphemeralTracker
  onChatUpdated?: (chatKey: string) => void
  /** Observers and contributions the plugin's public service relays (events, extension prompts). */
  hooks?: DispatchHostHooks
  now?: () => number
  quickjs?: () => Promise<QuickJSWASMModule>
}

export class DispatchHost {
  readonly im: DispatchIm
  readonly tasks: ImTasksLike
  readonly config: DispatchConfig
  readonly ephemeral: EphemeralTracker
  private readonly logger: Logger
  private readonly storage: StorageDomainLike
  private readonly auth: (() => SessionAuthLike | undefined) | undefined
  private readonly skillResolver: SkillCommandResolver
  private readonly chronicle: ChronicleService | undefined
  private readonly onChatUpdated: ((chatKey: string) => void) | undefined
  private readonly hooks: DispatchHostHooks
  private readonly now: () => number
  private readonly opened: Promise<Opened>
  private readonly chats = new Map<string, DispatchChat>()
  private readonly routerKeys = new Set<string>()
  private readonly failures = new Map<number, { count: number; last: string }>()
  private readonly granting = new Map<string, Promise<unknown>>()
  private readonly deliveries = new Map<string, DeliveryCause>()
  private readonly refusalAt = new Map<string, number>()
  private readonly stepCounts = new Map<string, { turn: number; steps: number }>()
  private readonly chatNameProbedAt = new Map<string, number>()
  private readonly ambientTimers = new Map<string, {
    timer: ReturnType<typeof setTimeout>
    message?: ImStoredMessage
    router: ImHostedRecord
  }>()
  private readonly pendingRouterReactions = new Map<string, PendingReaction[]>()
  private readonly taskReactionTimers = new Map<number, {
    timer: ReturnType<typeof setTimeout>
    task: ImTaskLike
    items: PendingReaction[]
  }>()
  private readonly userNames = new Map<string, string>()
  private readonly routerWakeKind = new Map<string, RouterWakeKind>()
  private readonly routerLastBatchLastMsg = new Map<string, ImStoredMessage>()
  private readonly proactiveReplies = new Map<string, number[]>()
  private lastRouterKey: string | undefined
  private disposed = false
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: DispatchHostOptions) {
    this.im = options.im
    this.tasks = options.tasks
    this.config = options.config
    this.logger = options.logger
    this.storage = options.storage
    this.auth = options.auth
    this.skillResolver = new SkillCommandResolver(options.skills ?? (() => undefined), options.logger)
    this.chronicle = options.chronicle
    this.ephemeral = options.ephemeral ?? options.chronicle?.ephemeral ?? new EphemeralTracker()
    this.onChatUpdated = options.onChatUpdated
    this.hooks = options.hooks ?? {}
    this.now = options.now ?? (() => Date.now())
    for (const entry of [this.config.main, this.config.worker]) {
      if (!entry.agentPreset.trim() || !entry.provider.trim() || !entry.model.trim() || !isAbsolute(entry.cwd)) {
        throw new ImError('configuration', 'IM dispatch sessions require a preset, a model route, and an absolute cwd.')
      }
    }
    this.opened = this.load(options.quickjs ?? newQuickJSWASMModule)
    this.opened.catch(() => {})
  }

  /** Lookup the router serving one chat (and optional topic thread). */
  routerFor(chatKey: string, threadId?: string): ImHostedRecord | undefined {
    const chat = this.chats.get(chatKey)
    if (chat !== undefined && chat.type === 'topic' && threadId !== undefined) {
      return this.im.sessions.get(`${DISPATCHER_TOPIC_PREFIX}${chatKey}:${threadId}`)
    }
    if (threadId !== undefined) {
      const topicMatch = this.im.sessions.get(`${DISPATCHER_TOPIC_PREFIX}${chatKey}:${threadId}`)
      if (topicMatch !== undefined) return topicMatch
    }
    return this.im.sessions.get(`${DISPATCHER_CHAT_PREFIX}${chatKey}`)
  }

  /** All live router session records created or seen by this host. */
  routers(): ImHostedRecord[] {
    const found = new Map<string, ImHostedRecord>()
    for (const key of this.routerKeys) {
      const record = this.im.sessions.get(key)
      if (record !== undefined) found.set(record.sessionId, record)
    }
    for (const chatKey of this.chats.keys()) {
      const record = this.im.sessions.get(`${DISPATCHER_CHAT_PREFIX}${chatKey}`)
      if (record !== undefined) found.set(record.sessionId, record)
    }
    return [...found.values()]
  }

  /** Most recently active router session (kept for diagnostics/compatibility). */
  get dispatcher(): ImHostedRecord | undefined {
    if (this.lastRouterKey !== undefined) {
      const rec = this.im.sessions.get(this.lastRouterKey)
      if (rec !== undefined) return rec
    }
    return this.routers()[0]
  }

  /** Wait until durable dispatch stores and router registrations finish loading. */
  async whenReady(): Promise<void> {
    await this.opened
  }

  /** Clear cached slash-skill index after a skill catalog change. */
  invalidateSkillCache(): void {
    this.skillResolver.invalidate()
  }

  /** User-invocable skills reachable as `/<name>` or an alias, read for the workers' working directory. */
  slashSkills(): Promise<SlashSkillView[]> {
    return this.skillResolver.list(this.config.worker.cwd)
  }

  /** Known display metadata (name + platform chat type) for one admitted chat. */
  chatInfo(chatKey: string): ChatTitleInfo | undefined {
    const stored = this.chats.get(chatKey)
    const configured = this.config.chatNames[chatKey]?.trim() || this.config.chatNames[splitKey(chatKey).id]?.trim()
    const name = configured || stored?.name
    if (name === undefined && stored === undefined) return undefined
    return {
      ...name === undefined ? {} : { name },
      ...stored === undefined ? {} : { type: stored.type },
    }
  }

  /** Desired automatic Web GUI title for a router or dispatch task worker session. */
  desiredSessionTitle(sessionId: string, recordOverride?: { key: string }): string | undefined {
    const task = this.tasks.of(sessionId)
    if (task !== undefined && this.isDispatchTask(task)) {
      return formatTaskSessionTitle(task, key => this.chatInfo(key))
    }
    const record = recordOverride ?? this.im.sessions.get(sessionId)
    if (record !== undefined && isRouterKey(record.key)) {
      return formatRouterSessionTitle(record.key, key => this.chatInfo(key))
    }
    return undefined
  }

  /** Collect every known router and task worker session id belonging to `chatKey`. */
  sessionIdsForChat(chatKey: string): string[] {
    const ids = new Set<string>()
    for (const record of this.im.sessions.list?.() ?? this.routers()) {
      if (record.key === `${DISPATCHER_CHAT_PREFIX}${chatKey}`
        || record.key.startsWith(`${DISPATCHER_TOPIC_PREFIX}${chatKey}:`)
        || record.key === DISPATCHER_KEY) {
        ids.add(record.sessionId)
      }
    }
    for (const task of this.tasks.list()) {
      if (this.isDispatchTask(task) && task.chat === chatKey) ids.add(task.session)
    }
    return [...ids]
  }

  /** Finish in-flight serialized writes, wait for grants, and close stores. */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const entry of this.ambientTimers.values()) clearTimeout(entry.timer)
    this.ambientTimers.clear()
    this.pendingRouterReactions.clear()
    for (const entry of this.taskReactionTimers.values()) clearTimeout(entry.timer)
    this.taskReactionTimers.clear()
    this.userNames.clear()
    await this.chain
    await Promise.allSettled([...this.granting.values()])
    await this.chronicle?.dispose()
    this.chats.clear()
    this.routerKeys.clear()
    this.failures.clear()
    this.deliveries.clear()
    this.refusalAt.clear()
    this.stepCounts.clear()
    this.chatNameProbedAt.clear()
    this.routerWakeKind.clear()
    this.routerLastBatchLastMsg.clear()
    this.proactiveReplies.clear()
    const { store } = await this.opened
    await store.close()
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Lifecycle hooks: im/stored, im/session/reset, agent/pre-step

  /**
   * Learn platform thread ids dynamically: a platform that assigns its own thread id to a reply thread (distinct from
   * the root message id the task was bound to) reports it on the first stored message of that thread, and every task
   * bound to the root (or the quoted message) gains a binding to it.
   */
  onStored(message: ImStoredMessage): void {
    this.rememberUserName(message.sender.id, message.sender.name)
    const threadId = message.thread?.id
    if (threadId === undefined || threadId === '') return
    const chat = message.chat.key
    const rootId = message.thread?.root
    const quotedId = message.quote === undefined ? undefined : splitKey(message.quote.key).id
    if (rootId === undefined && quotedId === undefined) return

    for (const task of this.tasks.list()) {
      const worker = this.im.sessions.get(task.session)
      if (worker === undefined) continue
      const chatBindings = worker.bindings.filter(b => b.chat === chat && b.writable && b.thread !== undefined)
      if (chatBindings.length === 0) continue
      if (chatBindings.some(b => b.thread === threadId)) continue
      const matchesRoot = (rootId !== undefined && chatBindings.some(b => b.thread === rootId))
        || (quotedId !== undefined && chatBindings.some(b => b.thread === quotedId))
      if (!matchesRoot) continue
      void this.bindWorkerThread(task.session, chat, threadId).catch((err: unknown) => {
        this.logger.warn('im-dispatch: failed dynamic thread bind %s -> %s: %s', task.session, threadId, String(err))
      })
    }
  }

  /** Clear router delivery cursor when a router session is `/clear` or `/new` reset. */
  async onSessionReset(record: ImHostedRecord): Promise<void> {
    if (!isRouterKey(record.key)) return
    const pendingTimer = this.ambientTimers.get(record.key)
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer.timer)
      this.ambientTimers.delete(record.key)
    }
    this.pendingRouterReactions.delete(record.key)
    this.routerWakeKind.delete(record.sessionId)
    this.routerLastBatchLastMsg.delete(record.sessionId)
    const { store } = await this.opened
    if (record.key.startsWith(DISPATCHER_CHAT_PREFIX)) {
      const chatKey = record.key.slice(DISPATCHER_CHAT_PREFIX.length)
      await this.serial(async () => {
        const current = store.chats.get(chatKey) ?? this.chats.get(chatKey)
        if (current === undefined) return
        const {
          deliveredSeq: _droppedSeq,
          deliveredTasks: _droppedTasks,
          deliveredTaskFloorId: _droppedFloor,
          ...rest
        } = current
        await store.chats.put(chatKey, rest)
        this.chats.set(chatKey, rest)
      })
      return
    }
    if (record.key.startsWith(DISPATCHER_TOPIC_PREFIX)) {
      const body = record.key.slice(DISPATCHER_TOPIC_PREFIX.length)
      const lastColon = body.lastIndexOf(':')
      if (lastColon <= 0) return
      const chatKey = body.slice(0, lastColon)
      const threadId = body.slice(lastColon + 1)
      await this.serial(async () => {
        const current = store.chats.get(chatKey) ?? this.chats.get(chatKey)
        if (current === undefined) return
        const nextCursors = dropRecordKey(current.topicCursors, threadId)
        const nextTaskCursors = dropRecordKey(current.topicTaskCursors, threadId)
        const nextTaskFloors = dropRecordKey(current.topicTaskFloorIds, threadId)
        if (
          nextCursors === current.topicCursors
          && nextTaskCursors === current.topicTaskCursors
          && nextTaskFloors === current.topicTaskFloorIds
        ) {
          return
        }
        const {
          topicCursors: _dropCursors,
          topicTaskCursors: _dropTaskCursors,
          topicTaskFloorIds: _dropTaskFloors,
          ...rest
        } = current
        const nextChat: DispatchChat = {
          ...rest,
          ...nextCursors === undefined ? {} : { topicCursors: nextCursors },
          ...nextTaskCursors === undefined ? {} : { topicTaskCursors: nextTaskCursors },
          ...nextTaskFloors === undefined ? {} : { topicTaskFloorIds: nextTaskFloors },
        }
        await store.chats.put(chatKey, nextChat)
        this.chats.set(chatKey, nextChat)
      })
    }
  }

  /**
   * 5-round router guardrail (`agent/pre-step`): warns on step `maxRouterSteps`, injects final stop order on
   * `maxRouterSteps + 1`, and rejects runaway loops beyond `maxRouterSteps + 1`.
   */
  async beforeStep(
    payload: { agent: AgentLike; messages: PreStepMessageLike[]; turn: number; step: number; signal: AbortSignal },
    next: () => Promise<PreStepDecisionLike>,
  ): Promise<PreStepDecisionLike> {
    if (this.peek(payload.agent)?.kind !== 'dispatcher') return await next()

    const sid = payload.agent.session.id
    const prev = this.stepCounts.get(sid)
    const steps = prev !== undefined && prev.turn === payload.turn ? prev.steps + 1 : 1
    this.stepCounts.set(sid, { turn: payload.turn, steps })

    const limit = this.config.maxRouterSteps
    if (steps < limit) return await next()
    if (steps > limit + 1) {
      this.logger.warn('im-dispatch: router %s exceeded hard step guardrail (%d/%d); rejecting step', sid, steps, limit)
      return { kind: 'reject' }
    }

    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const notice = steps === limit
      ? `⚠️ [Router 步数上限提醒] 当前已是本轮第 ${steps}/${limit} 步。请在当前步骤立即收口：能直接答复的用 router_reply 简短回答，需要调查/写代码/查文档/耗时处理的立刻用 create_task / route_messages_to_task / steer_task 派发给后台 Worker，不要继续调用只读搜索工具。`
      : `⛔ [Router 步数已达硬上限 ${steps}] 禁止继续发起新的调研/搜索工具，请立即结束本轮！`
    return { ...decision, messages: [...decision.messages, guardrailNotice(notice)] }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The im/message 3-tier waterfall listener

  async handle(event: ImMessageEventLike, next: () => Promise<ImOutcomeLike>): Promise<ImOutcomeLike> {
    const opened = await this.opened
    const message = event.message
    this.rememberUserName(message.sender.id, message.sender.name)
    const router = await this.learn(message)
    const addressed = await this.isAddressed(message)
    const auth = this.auth?.()
    const senderId = message.sender?.id ?? ''

    // Tier 0: Direct `/skill` (or `/alias`) invocation when addressed -> immediately open a dedicated worker
    // with the skill loaded and auto-request any capabilities declared in its metadata.
    if (addressed && !message.sender.self) {
      const slashSession = await this.tryHandleSlashSkill(router, message, auth)
      if (slashSession !== undefined) {
        return { kind: 'handled', by: BY, sessions: [slashSession] }
      }
    }

    // Tier 1: Explicit QuickJS RouteRules across all live dispatch tasks bound to this chat.
    const candidates = this.candidates(opened.store, message.chat.key)
    const outcomes = this.evaluate(opened.engine, candidates, ruleInput(message, addressed))
    const matched = candidates.filter(({ rule }) => outcomes.get(rule.id)?.matched === true)
    const rulesByTask = new Map<number, { task: ImTaskLike; rules: RouteRule[] }>()
    for (const { task, rule } of matched) {
      const entry = rulesByTask.get(task.id)
      if (entry === undefined) rulesByTask.set(task.id, { task, rules: [rule] })
      else entry.rules.push(rule)
    }

    const allowedTier1: Array<{ task: ImTaskLike; rules: RouteRule[] }> = []
    const blockedEntries: Array<{ task: ImTaskLike; rules: RouteRule[] }> = []
    for (const entry of rulesByTask.values()) {
      if (auth === undefined || auth.canInteract(entry.task.session, senderId)) allowedTier1.push(entry)
      else blockedEntries.push(entry)
    }

    const deliveredTaskSessions: string[] = []
    const matchedTaskIds = new Set<number>()
    for (const { task, rules } of allowedTier1) {
      matchedTaskIds.add(task.id)
      this.recordDelivery(task.session, message.key, {
        kind: 'rule',
        rules: rules.map(rule => ({
          id: rule.id,
          mode: rule.mode,
          match: rule.match,
          ...rule.note === undefined ? {} : { note: rule.note },
          taskId: task.id,
        })),
      })
      await this.grant(task.session, [message])
      await this.deliverMessagesToTask(task, [message])
      deliveredTaskSessions.push(task.session)
    }

    // Tier 2: Opt-in automatic thread follow-up for unaddressed messages inside a bound task thread.
    const tier2Blocked: ImTaskLike[] = []
    if (!addressed && !message.sender.self && message.thread !== undefined) {
      const threadTasks = this.findThreadTasks(message).filter(task => !matchedTaskIds.has(task.id))
      for (const task of threadTasks) {
        if (task.followThread !== true) continue
        if (auth !== undefined && !auth.canInteract(task.session, senderId)) {
          tier2Blocked.push(task)
          continue
        }
        if (message.thread.id !== undefined) {
          await this.bindWorkerThread(task.session, message.chat.key, message.thread.id)
        }
        this.recordDelivery(task.session, message.key, { kind: 'thread', taskId: task.id })
        await this.deliverMessagesToTask(task, [message], this.threadFollowupNotice(message))
        deliveredTaskSessions.push(task.session)
      }
    }

    // Tier 3: Per-chat / per-topic full-context router wake when addressed and not cut,
    // or debounced ambient wake when chat wakeMode allows it.
    const cut = matched.some(({ rule }) => rule.mode === 'cut')
    const main = addressed && !cut
    let ambientScheduled = false
    if (main) {
      const pendingAmbient = this.ambientTimers.get(router.key)
      if (pendingAmbient !== undefined) {
        clearTimeout(pendingAmbient.timer)
        this.ambientTimers.delete(router.key)
      }
      this.routerWakeKind.set(router.sessionId, 'direct')
      this.routerLastBatchLastMsg.set(router.sessionId, message)
      const { content } = await this.buildRouterWakeContent(opened.store, router, message, 'direct', true)
      await event.deliver(router.sessionId, {
        id: message.key,
        mode: 'steer',
        content,
        trigger: message,
      })
    } else if (
      !addressed
      && !message.sender.self
      && !cut
      && deliveredTaskSessions.length === 0
      && blockedEntries.length === 0
      && tier2Blocked.length === 0
      && this.shouldAmbientWake(message.chat.key)
    ) {
      this.scheduleAmbientWake(router, message)
      ambientScheduled = true
    }

    if (addressed && allowedTier1.length === 0) {
      const blockedCut = blockedEntries.find(entry => entry.rules.some(rule => rule.mode === 'cut'))
      if (blockedCut !== undefined) {
        await this.maybeNotifyExclusive(message, blockedCut.task.session, senderId, auth)
        return { kind: 'handled', by: BY, sessions: [] }
      }
    }

    const sessions = [...main ? [router.sessionId] : [], ...deliveredTaskSessions]
    if (sessions.length === 0) {
      if (blockedEntries.length > 0 || tier2Blocked.length > 0 || ambientScheduled) {
        return { kind: 'handled', by: BY, sessions: [] }
      }
      return await next()
    }
    return { kind: 'handled', by: BY, sessions }
  }

  /**
   * Handle direct `/<skill>` or `/<alias>` invocation: bypass the Router, spawn a fresh task worker with the
   * skill's `<skill_content>` pre-injected, and proactively request any capabilities declared in its metadata.
   */
  private async tryHandleSlashSkill(
    router: ImHostedRecord,
    message: ImStoredMessage,
    auth: SessionAuthLike | undefined,
  ): Promise<string | undefined> {
    const parsed = parseSlashInvocation(message)
    if (parsed === undefined) return undefined
    const resolved = await this.skillResolver.resolve(parsed.token, parsed.args, this.config.worker.cwd)
    if (resolved === undefined) return undefined

    const snippet = parsed.args.replace(/\s+/g, ' ').trim()
    const title = snippet.length > 0
      ? `/${parsed.token} ${Array.from(snippet).slice(0, 32).join('')}`
      : `/${parsed.token}`

    const capabilities = resolved.extensions.capabilities
    const canAutoAuth = capabilities.length > 0 && auth?.requestCapabilities !== undefined
    const extraBlocks: ContentBlockLike[] = [
      { type: 'text', text: renderSkillContentBlock(resolved.skill) },
    ]
    if (capabilities.length > 0 && !canAutoAuth) {
      const capList = capabilities.join('、')
      extraBlocks.push({
        type: 'text',
        text: `<im-auth-required capabilities="${attr(capabilities.join(','))}" />\n本 skill 声明需要能力授权（${capList}），如当前会话尚未授权请先在回复中输出 \`<AuthRequest capabilities={${JSON.stringify(capabilities)}} />\` 申请授权。`,
      })
    }

    const thread = this.desiredWorkerThread(message)
    const start: ImTaskStartLike = {
      owner: router.sessionId,
      title,
      messages: [message],
      extraContent: extraBlocks,
      deliveryMode: canAutoAuth ? 'inject' : 'steer',
      worker: workerComposition(this.config),
      output: this.config.workerOutput,
      placement: {
        bindings: [{
          chat: message.chat.key,
          writable: true,
          home: true,
          ...thread === undefined ? {} : { thread },
        }],
        trigger: message,
      },
      id: operationId(router.sessionId, `slash-skill:${message.key}`),
      meta: {
        by: DISPATCHER_OWNER,
        triggerText: message.text.slice(0, 400),
        skill: resolved.skill.name,
        command: parsed.token,
      },
    }

    const task = await this.tasks.start(start)
    this.recordDelivery(task.session, message.key, { kind: 'dispatch', taskId: task.id })

    if (canAutoAuth) {
      const reason = resolved.extensions.authReason ?? `使用 /${parsed.token} 需要以上能力授权`
      const reqResult = await auth.requestCapabilities!({
        sessionId: task.session,
        chat: message.chat.key,
        capabilities,
        reason,
        ...resolved.extensions.authTitle === undefined ? {} : { title: resolved.extensions.authTitle },
        quote: message.key,
        ...thread === undefined ? {} : { thread },
        operationId: operationId(task.session, `auto-auth:${message.key}`),
        ...message.sender.id
          ? { requester: { id: message.sender.id, ...message.sender.name === undefined ? {} : { name: message.sender.name } } }
          : {},
      })
      if (!reqResult.ok) {
        this.logger.warn('im-dispatch: auto-auth card failed for /%s (%s): %s', parsed.token, task.session, reqResult.error)
        await this.im.sessions.deliver(task.session, {
          id: `slash-skill-auth-fallback:${message.key}`,
          mode: 'steer',
          content: [{
            type: 'text',
            text: `自动发送授权卡片失败（${reqResult.error}），请自行在回复中输出 \`<AuthRequest capabilities={${JSON.stringify(capabilities)}} />\` 申请授权，或按需直接处理用户请求。`,
          }],
          trigger: message,
        })
      } else if (reqResult.alreadyActive) {
        const grantedTitles = reqResult.autoGranted && reqResult.autoGranted.length > 0
          ? reqResult.autoGranted.map(item => item.title).join('、')
          : capabilities.join('、')
        await this.im.sessions.deliver(task.session, {
          id: `slash-skill-auth-ready:${message.key}`,
          mode: 'steer',
          content: [{
            type: 'text',
            text: `<im-auth status="auto-granted" capabilities="${attr(capabilities.join(','))}" />\n已自动授权「${grantedTitles}」，请直接使用已授权能力处理用户任务。`,
          }],
          trigger: message,
        })
      } else {
        const capList = capabilities.join('、')
        await this.im.sessions.deliver(task.session, {
          id: `slash-skill-auth-pending:${message.key}`,
          mode: 'inject',
          content: [{
            type: 'text',
            text: `<im-auth-auto capabilities="${attr(capabilities.join(','))}" />\n系统已为 \`/${parsed.token}\` 自动向当前会话发送「${capList}」授权卡片，等待任意成员点击授权。请等待授权完成后的唤醒消息再执行依赖该能力的操作，切勿重复发送 \`<AuthRequest />\` 卡片。`,
          }],
          trigger: message,
        })
      }
    }

    return task.session
  }

  /**
   * Handle one platform reaction event (`im/reaction`).
   *
   * Only reactions placed/removed by someone else on the bot's own messages produce an event, and they are debounced
   * and batched together with concurrent normal messages for the owning task worker or chat router.
   */
  async onReaction(event: ImReactionEventLike): Promise<void> {
    if (this.disposed) return
    if (!event.user.id) return
    let botSelfId = event.bot?.selfId
    if (!botSelfId) {
      try {
        botSelfId = this.im.bot?.(event.chat.key)?.selfId
      } catch {
        botSelfId = undefined
      }
    }
    if (botSelfId && event.user.id === botSelfId) return
    if (!event.message.sender.self) return

    await this.opened
    if (this.disposed) return

    const userName = event.user.name?.trim() || this.resolveUserName(event.message.chat.key, event.user.id)
    if (userName !== undefined) this.rememberUserName(event.user.id, userName)
    const entry: PendingReaction = {
      id: event.id?.trim() || `${event.message.key}:${event.user.id}:${event.emoji}:${event.action}:${event.time}`,
      action: event.action,
      emoji: event.emoji,
      userId: event.user.id,
      ...userName === undefined ? {} : { userName },
      message: event.message,
      time: event.time,
    }

    // If the reacted bot message belongs to an active dispatch task (by session attribution or thread binding)
    // that explicitly opted into `followThread: true`, batch and deliver the reaction directly to that worker.
    const candidates: ImTaskLike[] = []
    if (event.session !== undefined) {
      const ownerTask = this.tasks.of(event.session)
      if (ownerTask !== undefined && this.isDispatchTask(ownerTask) && ownerTask.followThread === true) {
        candidates.push(ownerTask)
      }
    }
    if (candidates.length === 0 && event.message.thread !== undefined) {
      for (const task of this.findThreadTasks(event.message)) {
        if (task.followThread === true) candidates.push(task)
      }
    }

    if (candidates.length > 0) {
      const auth = this.auth?.()
      const allowed = candidates.filter(task => auth === undefined || auth.canInteract(task.session, event.user.id))
      // Every owning task is exclusive to another user: drop silently without leaking into the router.
      if (allowed.length === 0) return
      for (const task of allowed) this.scheduleTaskReaction(task, entry)
      return
    }

    if (this.effectiveWakeMode(this.chats.get(event.chat.key)) === 'mention') return

    const router = await this.learn(event.message)
    if (this.disposed) return
    const list = this.pendingRouterReactions.get(router.key) ?? []
    pushPendingReaction(list, entry)
    if (list.length === 0) {
      this.pendingRouterReactions.delete(router.key)
      const pendingTimer = this.ambientTimers.get(router.key)
      if (pendingTimer !== undefined && pendingTimer.message === undefined) {
        clearTimeout(pendingTimer.timer)
        this.ambientTimers.delete(router.key)
      }
      return
    }
    this.pendingRouterReactions.set(router.key, list)
    const existingTimer = this.ambientTimers.get(router.key)
    this.scheduleRouterDebounce(router, existingTimer?.message)
  }

  private async isAddressed(message: ImStoredMessage): Promise<boolean> {
    if (message.sender.self) return false
    if (message.addressed) return true
    if (message.quote === undefined) return false
    const stored = this.im.history.get(message.quote.key)
    if (stored !== undefined) return stored.sender.self
    const botId = splitKey(message.chat.key).bot
    let bot: ReturnType<NonNullable<DispatchIm['bot']>> | undefined
    try {
      bot = this.im.bot?.(message.chat.key)
    } catch {
      bot = undefined
    }
    const matchesSelf = (sender: { id: string; isBot?: boolean; self?: boolean } | undefined): boolean => {
      if (sender === undefined) return false
      if (sender.self === true) return true
      if (Boolean(bot?.selfId) && sender.id === bot?.selfId) return true
      return sender.isBot === true && Boolean(sender.id) && botId.endsWith(`:${sender.id}`)
    }
    if (message.quote.sender !== undefined) return matchesSelf(message.quote.sender)
    if (bot?.getMessage === undefined) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const lookup = bot.getMessage(message.chat.ref, splitKey(message.quote.key).id)
      void lookup.catch(() => {})
      const read = await Promise.race([
        lookup,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('quote lookup timed out')), 5000)
          timer.unref?.()
        }),
      ])
      return matchesSelf(read.sender)
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  private async maybeNotifyExclusive(
    message: ImStoredMessage,
    sessionId: string,
    senderId: string,
    auth: SessionAuthLike | undefined,
  ): Promise<void> {
    if (this.im.send === undefined) return
    const key = `${message.chat.key}\0${sessionId}\0${senderId}`
    const now = this.now()
    const prev = this.refusalAt.get(key)
    if (prev !== undefined && now - prev < REFUSAL_THROTTLE_MS) return
    this.refusalAt.delete(key)
    if (this.refusalAt.size >= MAX_REFUSAL_TIMESTAMPS) {
      const oldest = this.refusalAt.keys().next().value
      if (oldest !== undefined) this.refusalAt.delete(oldest)
    }
    this.refusalAt.set(key, now)

    const owner = auth?.aclOf(sessionId)?.owner
    try {
      const receipt = await this.im.send(message.chat.key, refusalContent(owner), {
        quote: message.key,
        ...message.thread === undefined ? {} : { thread: message.thread.id },
      })
      this.ephemeral.mark(receipt.message?.key)
    } catch (error) {
      this.logger.warn('im-dispatch: failed to send exclusivity refusal reply: %s', String(error))
    }
  }

  prompt(agent?: AgentLike): string {
    const role = this.peek(agent)
    if (role === undefined) return ''
    const base = role.kind === 'dispatcher'
      ? this.config.prompts.main ?? DEFAULT_DISPATCHER_PROMPT
      : this.config.prompts.worker ?? workerPrompt(this.config.workerOutput !== 'none')
    const extra = this.hooks.prompts?.(role.kind === 'dispatcher' ? 'router' : 'worker') ?? []
    return [base, ...extra.filter(text => text.trim() !== '')].join('\n\n')
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Router-only tools: router_reply, create_task, route_messages_to_task, steer_task, list_tasks

  /** Send one direct markdown answer from a Router without opening a streaming task turn. */
  async routerReply(
    caller: AgentLike,
    request: { text: string; quote?: string; chat?: string; thread?: boolean },
    callId: string,
    signal?: AbortSignal,
  ): Promise<{ status: string; messageKey?: string }> {
    await this.opened
    const role = this.dispatcherOf(caller)
    if (this.im.send === undefined) {
      throw new ImError('unavailable', 'The IM host cannot send direct router replies in this environment.')
    }
    const text = request.text.trim()
    if (!text) throw new ImError('capacity', 'router_reply text must not be empty.')
    const chat = this.chatOf(role.record, request.chat)
    const wakeKind = this.routerWakeKind.get(role.record.sessionId) ?? 'direct'
    const chatRecord = this.chats.get(chat)
    const replyMode = this.effectiveReplyMode(chatRecord)
    let proactiveHistory: number[] | undefined
    if (wakeKind === 'ambient') {
      if (replyMode === 'mention_only') {
        throw new ImError(
          'access',
          '当前群处于 replyMode="mention_only" 模式，未 @ 机器人时禁止调用 router_reply 主动发言。请改用 create_task / route_messages_to_task / steer_task 派发任务（由 Worker 在 Thread 回复），或直接结束本轮保持沉默。',
        )
      }
      const cutoff = this.now() - PROACTIVE_WINDOW_MS
      proactiveHistory = (this.proactiveReplies.get(chat) ?? []).filter(ts => ts > cutoff)
      this.proactiveReplies.set(chat, proactiveHistory)
      if (proactiveHistory.length >= this.config.maxAutoRepliesPerHour) {
        throw new ImError(
          'capacity',
          `当前群过去 1 小时内主动发言已达上限（${this.config.maxAutoRepliesPerHour} 次/小时），本次请保持沉默。`,
        )
      }
    }

    const trigger = this.activeTriggerOf(role.record.sessionId)
    const quoted = request.quote !== undefined
      ? this.lookup(chat, request.quote)
      : (trigger?.chat.key === chat ? trigger : undefined)
    const thread = request.thread === true
      ? (quoted?.thread?.id ?? (quoted !== undefined ? splitKey(quoted.key).id : true))
      : request.thread === false
        ? undefined
        : quoted?.thread?.id

    const receipt = await this.im.send(
      chat,
      { type: 'markdown', attrs: { content: request.text }, children: [] },
      {
        ...quoted === undefined ? {} : { quote: quoted.key },
        ...thread === undefined ? {} : { thread },
        operationId: operationId(role.record.sessionId, callId),
        ...signal === undefined ? {} : { signal },
      },
    )
    if (receipt.status === 'failed') {
      throw new ImError('unavailable', receipt.error ?? 'Failed to publish router reply.')
    }
    if (wakeKind === 'ambient' && proactiveHistory !== undefined) {
      proactiveHistory.push(this.now())
      this.proactiveReplies.set(chat, proactiveHistory)
    }
    return {
      status: receipt.status,
      ...receipt.message?.key === undefined ? {} : { messageKey: receipt.message.key },
    }
  }

  /** Start a background task, automatically confining writes to a reply thread where {@link autoThreads} allows. */
  async startTask(caller: AgentLike, request: TaskRequest, callId: string): Promise<ImTaskLike> {
    await this.opened
    const role = this.dispatcherOf(caller)
    const chat = this.chatOf(role.record, request.chat)
    const all: ImStoredMessage[] = []
    for (const token of request.messages ?? []) all.push(this.lookup(chat, token))
    if (request.range !== undefined) for (const message of this.span(chat, request.range)) all.push(message)
    const bind: ImStoredMessage | undefined = all.find(message => message.addressed)
      ?? all[0] ?? this.activeTriggerOf(role.record.sessionId)
    if (bind === undefined) {
      throw new ImError('capacity', 'Name the messages that carry the request, with messages or range.')
    }
    if (all.length === 0) {
      if (bind.chat.key !== chat) throw new ImError('access', `No message ${bind.key} is stored in chat ${chat}.`)
      all.push(bind)
    }
    if (all.length > this.config.maxTaskMessages) {
      throw new ImError('capacity', `Name at most ${this.config.maxTaskMessages} messages in one task start.`)
    }
    const thread = this.desiredWorkerThread(bind)
    const start: ImTaskStartLike = {
      owner: role.record.sessionId,
      title: request.title,
      messages: this.handoff(chat, all),
      worker: workerComposition(this.config),
      output: this.config.workerOutput,
      placement: {
        bindings: [{
          chat: bind.chat.key,
          writable: true,
          home: true,
          ...thread === undefined ? {} : { thread },
        }],
        trigger: bind,
      },
      id: operationId(role.record.sessionId, callId),
      meta: { by: DISPATCHER_OWNER, triggerText: bind.text.slice(0, 400) },
      ...request.signal === undefined ? {} : { signal: request.signal },
    }
    const task = await this.tasks.start(start)
    for (const msg of all) this.recordDelivery(task.session, msg.key, { kind: 'dispatch', taskId: task.id })
    return task
  }

  /** Route messages (local or cross-chat) to any active dispatch task. */
  async routeToTask(
    caller: AgentLike, id: number, refs: readonly MessageRefInput[],
  ): Promise<{ task: ImTaskLike; messages: ImStoredMessage[] }> {
    await this.opened
    const role = this.dispatcherOf(caller)
    if (refs.length === 0) throw new ImError('capacity', 'Route at least one message to a task.')
    const owned = this.tasks.get(id)
    if (owned === undefined || !this.isDispatchTask(owned)) {
      throw new ImError('access', `This session has no task #${id}.`)
    }
    const messages = refs.map(ref => this.lookup(this.chatOf(role.record, ref.chat), ref.message))
    const auth = this.auth?.()
    if (auth !== undefined) {
      const blocked = messages.find(msg => !auth.canInteract(owned.session, msg.sender?.id ?? ''))
      if (blocked !== undefined) {
        const owner = auth.aclOf(owned.session)?.owner
        const ownerLabel = owner?.name ? `${owner.name} (${owner.id})` : (owner?.id ?? 'its exclusive owner')
        throw new ImError('access', `Task #${id} is exclusive to ${ownerLabel}; start a new task with create_task instead.`)
      }
    }
    for (const msg of messages) this.recordDelivery(owned.session, msg.key, { kind: 'dispatch', taskId: owned.id })
    await this.grant(owned.session, messages)
    const delivered = await this.deliverMessagesToTask(owned, messages)
    this.chronicle?.recordTaskRouted(
      delivered,
      messages[0]!.chat.key,
      messages.map(m => `[${senderName(m)}] ${m.text}`).join(' | '),
      `route:${owned.id}:${messages.map(m => m.key).join(',')}`,
    )
    return { task: delivered, messages }
  }

  /** Send synthesized router instructions directly to an existing task (supports cross-chat steering). */
  async steerTask(
    caller: AgentLike,
    id: number,
    text: string,
    chatToken: string | undefined,
    callId: string,
  ): Promise<ImTaskLike> {
    await this.opened
    const role = this.dispatcherOf(caller)
    const body = text.trim()
    if (!body) throw new ImError('capacity', 'steer_task text must not be empty.')
    const task = this.tasks.get(id)
    if (task === undefined || !this.isDispatchTask(task)) {
      throw new ImError('access', `This session has no task #${id}.`)
    }
    const trigger = this.activeTriggerOf(role.record.sessionId)
    const auth = this.auth?.()
    if (auth !== undefined && trigger !== undefined && !auth.canInteract(task.session, trigger.sender?.id ?? '')) {
      const owner = auth.aclOf(task.session)?.owner
      const ownerLabel = owner?.name ? `${owner.name} (${owner.id})` : (owner?.id ?? 'its exclusive owner')
      throw new ImError('access', `Task #${id} is exclusive to ${ownerLabel}; start a new task with create_task instead.`)
    }

    const targetChat = chatToken === undefined ? trigger?.chat.key : this.chatOf(role.record, chatToken)
    if (trigger !== undefined && (targetChat === undefined || trigger.chat.key === targetChat)) {
      await this.grant(task.session, [trigger])
    } else if (targetChat !== undefined) {
      await this.grantChatFallback(task.session, targetChat)
    }

    const prefix = trigger === undefined ? '' : `[来自会话 ${trigger.chat.key} / #${trigger.seq} ${senderName(trigger)}] `
    const opKey = operationId(role.record.sessionId, callId)
    const updated = await this.tasks.message(role.record.sessionId, id, `${prefix}${body}`, { id: opKey })
    this.chronicle?.recordTaskRouted(updated, targetChat ?? updated.chat, body, `steer:${opKey}`)
    return updated
  }

  /** Query the global prefix-cached Chronicle from either a router or a task worker. */
  async queryChronicle(
    caller: AgentLike,
    request: { question: string; chat?: string },
    signal: AbortSignal,
  ): Promise<ChronicleQueryResult> {
    this.roleOf(caller)
    if (this.chronicle === undefined) {
      return { answer: '工作日志（Chronicle）服务未挂载。', entriesScanned: 0, latestId: 0 }
    }
    return await this.chronicle.query(request, signal)
  }

  /** Chronicle summary for management panel inspection. */
  chronicleStatus(): Promise<ChronicleStatus> | undefined {
    return this.chronicle?.status()
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Route rules & history search

  async addRule(caller: AgentLike, request: RouteRuleRequest): Promise<RouteRuleView> {
    return await this.addRuleFor(this.workerOf(caller).task, request)
  }

  async panelAddRule(taskId: number, request: RouteRuleRequest): Promise<RouteRuleView> {
    return await this.addRuleFor(this.taskOf(taskId), request)
  }

  private async addRuleFor(task: ImTaskLike, request: RouteRuleRequest): Promise<RouteRuleView> {
    const { store, engine } = await this.opened
    const match = this.expression(engine, request.match ?? 'true')
    const note = this.note(request.note)
    const rule = await this.serial(async () => {
      if (this.rulesOf(store, task.id).length >= this.config.maxRulesPerTask) {
        throw new ImError('capacity',
          `Task #${task.id} already holds ${this.config.maxRulesPerTask} route rules; update or remove one.`)
      }
      const id = store.global.get().nextRule
      await store.global.set({ nextRule: id + 1 })
      const now = Date.now()
      const rule: RouteRule = {
        id, task: task.id, match, mode: request.mode, ...note === undefined ? {} : { note }, createdAt: now, updatedAt: now,
      }
      await store.rules.put(String(id), rule)
      return rule
    })
    await this.announce(task.owner, `Task #${task.id} (${task.title}) added ${this.describe(rule)}`,
      `rule #${rule.id} added`, rule, 'added')
    return this.view(rule, task)
  }

  async updateRule(caller: AgentLike, id: number, patch: Partial<RouteRuleRequest>): Promise<RouteRuleView> {
    return await this.updateRuleFor(this.workerOf(caller).task, id, patch)
  }

  async panelUpdateRule(taskId: number, id: number, patch: Partial<RouteRuleRequest>): Promise<RouteRuleView> {
    return await this.updateRuleFor(this.taskOf(taskId), id, patch)
  }

  private async updateRuleFor(task: ImTaskLike, id: number, patch: Partial<RouteRuleRequest>): Promise<RouteRuleView> {
    const { store, engine } = await this.opened
    const match = patch.match === undefined ? undefined : this.expression(engine, patch.match)
    const note = this.note(patch.note)
    const rule = await this.serial(async () => {
      const current = this.ownedRule(store, task, id)
      const next: RouteRule = {
        ...current,
        ...match === undefined ? {} : { match },
        ...patch.mode === undefined ? {} : { mode: patch.mode },
        updatedAt: Date.now(),
      }
      if (patch.note !== undefined) {
        if (note === undefined) delete next.note
        else next.note = note
      }
      await store.rules.put(String(id), next)
      this.failures.delete(id)
      return next
    })
    await this.announce(task.owner, `Task #${task.id} (${task.title}) changed ${this.describe(rule)}`,
      `rule #${rule.id} changed`, rule, 'changed')
    return this.view(rule, task)
  }

  async removeRule(caller: AgentLike, id: number): Promise<RouteRuleView> {
    const role = this.roleOf(caller)
    return await this.removeRuleFor(role.kind === 'worker' ? role.task : undefined, id)
  }

  async panelRemoveRule(id: number): Promise<RouteRuleView> {
    return await this.removeRuleFor(undefined, id)
  }

  private async removeRuleFor(own: ImTaskLike | undefined, id: number): Promise<RouteRuleView> {
    const { store } = await this.opened
    const { rule, task } = await this.serial(async () => {
      const rule = own === undefined ? store.rules.get(String(id)) : this.ownedRule(store, own, id)
      const task = rule === undefined ? undefined : this.tasks.get(rule.task)
      if (rule === undefined || task === undefined) throw new ImError('access', `No route rule #${id} exists.`)
      await store.rules.delete(String(id))
      this.failures.delete(id)
      return { rule, task }
    })
    const text = `route rule #${rule.id} (${rule.mode}) of task #${task.id} was removed: ${rule.match}`
    if (own === undefined) {
      await this.announce(task.session, `The router removed your ${text}`, `rule #${rule.id} removed`, rule, 'removed')
    } else {
      await this.announce(task.owner, `Task #${task.id} (${task.title}) removed its ${text}`,
        `rule #${rule.id} removed`, rule, 'removed')
    }
    return this.view(rule, task)
  }

  async listRules(caller: AgentLike): Promise<RouteRuleView[]> {
    const { store } = await this.opened
    const role = this.roleOf(caller)
    const tasks = role.kind === 'worker'
      ? [role.task]
      : this.tasks.list().filter(task => this.isDispatchTask(task))
    return tasks.flatMap(task => this.rulesOf(store, task.id).map(rule => this.view(rule, task)))
      .sort((left, right) => left.id - right.id)
  }

  async panelRules(): Promise<RouteRuleView[]> {
    const { store } = await this.opened
    const tasks = this.tasks.list().filter(task => this.isDispatchTask(task))
    return tasks.flatMap(task => this.rulesOf(store, task.id).map(rule => this.view(rule, task)))
      .sort((left, right) => left.id - right.id)
  }

  async search(caller: AgentLike, request: RuleSearchRequest, signal: AbortSignal): Promise<RuleSearch> {
    const { engine } = await this.opened
    const role = this.roleOf(caller)
    const match = this.expression(engine, request.match)
    if (!Number.isInteger(request.pages) || request.pages < 1 || request.pages > this.config.maxSearchPages) {
      throw new ImError('capacity', `Search pages must be 1–${this.config.maxSearchPages}.`)
    }
    const cursor = request.cursor === undefined ? undefined : Number(request.cursor)
    if (cursor !== undefined && !Number.isInteger(cursor)) {
      throw new ImError('capacity', 'The search cursor is not one an earlier search returned.')
    }
    signal.throwIfAborted()
    const chat = this.chatOf(role.record, request.chat)
    const limit = request.pages * this.config.searchPageSize
    const window = this.im.history.before(chat, cursor ?? Number.MAX_SAFE_INTEGER, limit)
    let errors: { count: number; first: string } | undefined
    const messages: MessageView[] = []
    for (const message of [...window].reverse()) {
      const outcome = engine.evaluate(new Map([[0, match]]), ruleInput(message)).get(0)
      if (outcome?.error !== undefined) {
        errors = errors === undefined ? { count: 1, first: outcome.error } : { count: errors.count + 1, first: errors.first }
      }
      if (outcome?.matched === true) messages.push(messageView(message))
    }
    const oldest = window[0]
    return {
      messages,
      scanned: window.length,
      ...window.length < limit || oldest === undefined ? {} : { next: String(oldest.seq) },
      ...errors === undefined ? {} : { errors },
    }
  }

  deliveryCause(sessionId: string, key: string): DeliveryCause | undefined {
    return this.deliveries.get(`${sessionId}\0${key}`)
  }

  private recordDelivery(sessionId: string, key: string, cause: DeliveryCause): void {
    const mapKey = `${sessionId}\0${key}`
    this.deliveries.delete(mapKey)
    if (this.deliveries.size >= MAX_DELIVERY_CAUSES) {
      const oldest = this.deliveries.keys().next().value
      if (oldest !== undefined) this.deliveries.delete(oldest)
    }
    this.deliveries.set(mapKey, cause)
    try {
      this.hooks.delivered?.(sessionId, key, cause)
    } catch (error: unknown) {
      this.logger.warn('im-dispatch: a delivery observer failed: %s', String(error))
    }
  }

  async listTasks(caller: AgentLike): Promise<ImTaskLike[]> {
    await this.opened
    this.dispatcherOf(caller)
    return this.tasks.list().filter(task => this.isDispatchTask(task))
  }

  /** Update persistent per-chat wake/reply policy and ambient watch topics from a Router. */
  async configureChat(caller: AgentLike, request: ConfigureChatRequest): Promise<ChatConfigView> {
    await this.opened
    const role = this.dispatcherOf(caller)
    return await this.configureChatFor(this.chatOf(role.record, request.chat), request)
  }

  /**
   * Operator change of one chat's wake/reply configuration (the panel, or another plugin through the service).
   * @param chat - chat key, or a bare platform chat id of a chat that reached dispatch.
   * @param request - the fields to change; omitted fields keep their value.
   * @returns the effective configuration.
   */
  async panelConfigureChat(chat: string, request: ConfigureChatRequest): Promise<ChatConfigView> {
    await this.opened
    const wanted = chat.trim()
    const chatKey = [...this.chats.keys()].find(key => key === wanted || splitKey(key).id === wanted)
    if (chatKey === undefined) throw new ImError('access', `No chat ${wanted} has reached dispatch.`)
    return await this.configureChatFor(chatKey, request)
  }

  private async configureChatFor(chatKey: string, request: ConfigureChatRequest): Promise<ChatConfigView> {
    const { store } = await this.opened

    let normalizedTopics: string[] | undefined
    if (request.watchTopics !== undefined) {
      const seen = new Set<string>()
      const cleaned: string[] = []
      for (const raw of request.watchTopics) {
        const item = raw.trim()
        if (!item || seen.has(item)) continue
        seen.add(item)
        cleaned.push(item)
      }
      if (cleaned.length > MAX_CHAT_TOPICS) {
        throw new ImError('capacity', `watchTopics 最多支持 ${MAX_CHAT_TOPICS} 条关键词。`)
      }
      normalizedTopics = cleaned
    }

    const normalizeText = (value: string | undefined, field: string): string | undefined => {
      if (value === undefined) return undefined
      const trimmed = value.trim()
      if (trimmed.length > MAX_CHAT_TEXT_CHARS) {
        throw new ImError('capacity', `${field} 最多支持 ${MAX_CHAT_TEXT_CHARS} 个字符。`)
      }
      return trimmed
    }
    const normalizedWatchNote = normalizeText(request.watchNote, 'watchNote')
    const normalizedReplyPolicy = normalizeText(request.replyPolicy, 'replyPolicy')

    const updated = await this.serial(async () => {
      const current = store.chats.get(chatKey) ?? this.chats.get(chatKey)
      if (current === undefined) {
        throw new ImError('access', `No chat ${chatKey} has reached dispatch.`)
      }
      const next: DispatchChat = {
        source: current.source,
        type: current.type,
        firstSeenAt: current.firstSeenAt,
        ...current.name === undefined ? {} : { name: current.name },
        ...current.deliveredSeq === undefined ? {} : { deliveredSeq: current.deliveredSeq },
        ...current.topicCursors === undefined ? {} : { topicCursors: current.topicCursors },
        ...current.deliveredTasks === undefined ? {} : { deliveredTasks: current.deliveredTasks },
        ...current.deliveredTaskFloorId === undefined ? {} : { deliveredTaskFloorId: current.deliveredTaskFloorId },
        ...current.topicTaskCursors === undefined ? {} : { topicTaskCursors: current.topicTaskCursors },
        ...current.topicTaskFloorIds === undefined ? {} : { topicTaskFloorIds: current.topicTaskFloorIds },
      }
      const wakeMode = request.wakeMode ?? current.wakeMode
      if (wakeMode !== undefined) next.wakeMode = wakeMode
      const replyMode = request.replyMode ?? current.replyMode
      if (replyMode !== undefined) next.replyMode = replyMode

      const watchTopics = normalizedTopics !== undefined
        ? (normalizedTopics.length > 0 ? normalizedTopics : undefined)
        : current.watchTopics
      if (watchTopics !== undefined && watchTopics.length > 0) next.watchTopics = watchTopics

      const watchNote = normalizedWatchNote !== undefined
        ? (normalizedWatchNote || undefined)
        : current.watchNote
      if (watchNote !== undefined) next.watchNote = watchNote

      const replyPolicy = normalizedReplyPolicy !== undefined
        ? (normalizedReplyPolicy || undefined)
        : current.replyPolicy
      if (replyPolicy !== undefined) next.replyPolicy = replyPolicy

      await store.chats.put(chatKey, next)
      this.chats.set(chatKey, next)
      return next
    })

    if (this.effectiveWakeMode(updated) === 'mention') {
      for (const [key, entry] of this.ambientTimers) {
        if (entry.message?.chat.key === chatKey) {
          if ((this.pendingRouterReactions.get(key)?.length ?? 0) > 0) {
            delete entry.message
          } else {
            clearTimeout(entry.timer)
            this.ambientTimers.delete(key)
          }
        }
      }
    }
    this.onChatUpdated?.(chatKey)
    const view = this.chatConfigView(chatKey, updated)
    try {
      this.hooks.chatConfigured?.(view)
    } catch (error: unknown) {
      this.logger.warn('im-dispatch: a chat observer failed: %s', String(error))
    }
    return view
  }

  /** Every chat that reached dispatch, with its display name, type and effective configuration. */
  async panelChats(): Promise<(ChatConfigView & { type: string; source: string; firstSeenAt: number })[]> {
    await this.opened
    return [...this.chats].map(([chatKey, chat]) => {
      const name = this.chatInfo(chatKey)?.name
      return {
        ...this.chatConfigView(chatKey, chat),
        ...name === undefined ? {} : { name },
        type: chat.type,
        source: chat.source,
        firstSeenAt: chat.firstSeenAt,
      }
    })
  }

  /** Return all chats with non-default wake/reply or ambient watch configuration for the Panel. */
  async panelChatConfigs(): Promise<ChatConfigView[]> {
    await this.opened
    const out: ChatConfigView[] = []
    for (const [chatKey, chat] of this.chats) {
      if (
        chat.wakeMode !== undefined
        || chat.replyMode !== undefined
        || (chat.watchTopics !== undefined && chat.watchTopics.length > 0)
        || chat.watchNote !== undefined
        || chat.replyPolicy !== undefined
      ) {
        out.push(this.chatConfigView(chatKey, chat))
      }
    }
    return out
  }

  private effectiveWakeMode(chat: DispatchChat | undefined): ChatWakeMode {
    return chat?.wakeMode ?? 'mention'
  }

  private effectiveReplyMode(chat: DispatchChat | undefined): ChatReplyMode {
    return chat?.replyMode ?? 'mention_only'
  }

  private chatConfigView(chatKey: string, chat: DispatchChat | undefined): ChatConfigView {
    return {
      chat: chatKey,
      ...chat?.name === undefined ? {} : { name: chat.name },
      wakeMode: this.effectiveWakeMode(chat),
      replyMode: this.effectiveReplyMode(chat),
      watchTopics: chat?.watchTopics === undefined ? [] : [...chat.watchTopics],
      ...chat?.watchNote === undefined ? {} : { watchNote: chat.watchNote },
      ...chat?.replyPolicy === undefined ? {} : { replyPolicy: chat.replyPolicy },
    }
  }

  private activeTriggerOf(routerSessionId: string): ImStoredMessage | undefined {
    const kind = this.routerWakeKind.get(routerSessionId)
    if (kind === 'ambient' || kind === 'reaction') {
      return this.routerLastBatchLastMsg.get(routerSessionId)
    }
    return this.triggerOf(routerSessionId)
  }

  private hasWatchedTasks(chatKey: string): boolean {
    return this.tasks.list().some(task => {
      if (!this.isDispatchTask(task)) return false
      if (!task.wantedTopics || task.wantedTopics.length === 0) return false
      if (task.topicScope === 'all') return true
      const worker = this.im.sessions.get(task.session)
      return task.chat === chatKey || worker?.bindings.some(b => b.chat === chatKey) === true
    })
  }

  private shouldAmbientWake(chatKey: string): boolean {
    const chat = this.chats.get(chatKey)
    const mode = this.effectiveWakeMode(chat)
    if (mode === 'mention') return false
    if (mode === 'auto') return true
    if (this.effectiveReplyMode(chat) === 'proactive') return true
    if ((chat?.watchTopics?.length ?? 0) > 0 || Boolean(chat?.watchNote) || Boolean(chat?.replyPolicy)) return true
    return this.hasWatchedTasks(chatKey)
  }

  private scheduleAmbientWake(router: ImHostedRecord, message: ImStoredMessage): void {
    this.scheduleRouterDebounce(router, message)
  }

  private scheduleRouterDebounce(router: ImHostedRecord, message: ImStoredMessage | undefined): void {
    const prev = this.ambientTimers.get(router.key)
    if (prev !== undefined) clearTimeout(prev.timer)
    const carriedMessage = message ?? prev?.message
    const delay = this.config.ambientDebounceMs
    const timer = setTimeout(() => {
      this.ambientTimers.delete(router.key)
      void this.flushRouterWake(router, carriedMessage).catch(error => {
        this.logger.error('im-dispatch: debounced router wake failed for %s: %s', router.key, String(error))
      })
    }, delay)
    timer.unref?.()
    this.ambientTimers.set(router.key, {
      timer,
      ...carriedMessage === undefined ? {} : { message: carriedMessage },
      router,
    })
  }

  private async flushRouterWake(router: ImHostedRecord, message: ImStoredMessage | undefined): Promise<void> {
    if (this.disposed) return
    const { store } = await this.opened
    if (this.disposed) return

    const queuedReactions = this.pendingRouterReactions.get(router.key) ?? []
    const hasReactions = queuedReactions.length > 0
    if (!hasReactions) {
      if (message === undefined) return
      if (!this.shouldAmbientWake(message.chat.key)) return
    }

    const anchor = message ?? queuedReactions[queuedReactions.length - 1]!.message
    const chatKey = anchor.chat.key
    const isTopicRouter = anchor.chat.ref.type === 'topic' && anchor.thread?.id !== undefined
    const topicThreadId = isTopicRouter ? anchor.thread!.id : undefined
    const include = (candidate: ImStoredMessage): boolean => {
      if (isEphemeralSelfMessage(candidate, this.ephemeral)) return false
      if (topicThreadId !== undefined) {
        return candidate.thread?.id === topicThreadId || candidate.thread?.root === topicThreadId
      }
      return true
    }

    const current = store.chats.get(chatKey) ?? this.chats.get(chatKey)
    const prevSeq = topicThreadId === undefined ? current?.deliveredSeq : current?.topicCursors?.[topicThreadId]
    let latestNonSelf: ImStoredMessage | undefined
    if (message !== undefined) {
      if (prevSeq === undefined || message.seq > prevSeq) {
        const unread = prevSeq === undefined
          ? [message]
          : this.im.history.after(chatKey, prevSeq, this.config.maxRouterDeltaMessages + 1, include)
            .filter(item => item.seq <= message.seq)
        const nonSelf = unread.filter(item => !item.sender.self)
        latestNonSelf = nonSelf[nonSelf.length - 1]
      }
      if (!hasReactions && latestNonSelf === undefined) return
    } else if (prevSeq !== undefined) {
      const unread = this.im.history.after(chatKey, prevSeq, this.config.maxRouterDeltaMessages + 1, include)
      const nonSelf = unread.filter(item => !item.sender.self)
      latestNonSelf = nonSelf[nonSelf.length - 1]
    }

    const wakeKind: RouterWakeKind = hasReactions ? 'reaction' : 'ambient'
    const built = await this.buildRouterWakeContent(store, router, anchor, wakeKind, message !== undefined)
    if (built.empty || this.disposed) return
    this.routerWakeKind.set(router.sessionId, wakeKind)
    this.routerLastBatchLastMsg.set(router.sessionId, latestNonSelf ?? anchor)
    const deliveryId = built.reactionIds.length > 0
      ? `reaction:${built.reactionIds.join(',')}`
      : `ambient:${anchor.key}`
    await this.im.sessions.deliver(router.sessionId, {
      id: deliveryId,
      mode: 'steer',
      content: built.content,
    })
  }

  private scheduleTaskReaction(task: ImTaskLike, entry: PendingReaction): void {
    const existing = this.taskReactionTimers.get(task.id)
    const items = existing?.items ?? []
    if (existing !== undefined) clearTimeout(existing.timer)
    pushPendingReaction(items, entry)
    if (items.length === 0) {
      this.taskReactionTimers.delete(task.id)
      return
    }
    const delay = this.config.ambientDebounceMs
    const timer = setTimeout(() => {
      void this.flushTaskReactions(task.id).catch(error => {
        this.logger.error('im-dispatch: task reaction delivery failed for task #%d: %s', task.id, String(error))
      })
    }, delay)
    timer.unref?.()
    this.taskReactionTimers.set(task.id, { timer, task, items })
  }

  private takeTaskReactions(taskId: number): PendingReaction[] {
    const existing = this.taskReactionTimers.get(taskId)
    if (existing === undefined) return []
    clearTimeout(existing.timer)
    this.taskReactionTimers.delete(taskId)
    return existing.items
  }

  private async flushTaskReactions(taskId: number): Promise<void> {
    if (this.disposed) return
    const existing = this.taskReactionTimers.get(taskId)
    if (existing === undefined) return
    this.taskReactionTimers.delete(taskId)
    const { task, items } = existing
    if (items.length === 0) return
    const liveTask = this.tasks.get(taskId) ?? task
    const lines = [
      `<im-reactions chat="${attr(items[0]!.message.chat.key)}" task="#${liveTask.id}">`,
      WORKER_REACTION_NOTICE,
      ...items.map(item => this.formatReactionLine(item)),
      '</im-reactions>',
    ]
    await this.im.sessions.deliver(liveTask.session, {
      id: `reaction:${items.map(item => item.id).join(',')}`,
      mode: 'steer',
      content: [{ type: 'text', text: lines.join('\n') }],
    })
  }

  /**
   * The line a worker reads before a message its thread auto-delivered, so overhearing is not mistaken for a request.
   * @param message - the delivered message, which addressed someone else or nobody.
   * @returns the `<im-thread-followup>` header placed before the formatted message.
   */
  private threadFollowupNotice(message: ImStoredMessage): string {
    const others = message.mentions.users.map(user => user.name ?? user.id)
    const attrs = [
      `chat="${attr(message.chat.key)}"`,
      `message="#${message.seq}"`,
      ...others.length === 0 ? [] : [`mentioned="${attr(others.join('、'))}"`],
      ...message.sender.isBot === true ? ['from-bot="true"'] : [],
    ]
    const target = others.length === 0 ? '它没有 @ 任何人' : `它 @ 的是 ${others.join('、')}`
    return `<im-thread-followup ${attrs.join(' ')}>这条消息没有 @ 你，也不是对你的回复（${target}）：`
      + '大概率是群友之间或别的机器人的对话。除非它明确要你处理，否则当上下文读，不要回复、不要动手。</im-thread-followup>'
  }

  private async deliverMessagesToTask(
    task: ImTaskLike, messages: readonly ImStoredMessage[], header?: string,
  ): Promise<ImTaskLike> {
    const reactions = this.takeTaskReactions(task.id)
    if (reactions.length === 0 || messages.length === 0) {
      return await this.tasks.deliver(task.id, messages, header === undefined ? undefined : { header })
    }
    const leading = messages.slice(0, -1)
    if (leading.length > 0) {
      await this.tasks.deliver(task.id, leading, header === undefined ? undefined : { header })
    }
    const last = messages[messages.length - 1]!
    const formatted = await this.im.format([last], {
      style: 'xml',
      media: true,
      ...header === undefined ? {} : { header },
    })
    const content = this.appendReactionsToContent(formatted, reactions, WORKER_REACTION_NOTICE)
    await this.im.sessions.deliver(task.session, {
      id: `message:${last.key}`,
      mode: 'steer',
      content,
      trigger: last,
    })
    return this.tasks.get(task.id) ?? task
  }

  private rememberUserName(userId: string | undefined, name: string | undefined): void {
    const id = userId?.trim()
    const clean = name?.trim()
    if (!id || !clean) return
    this.userNames.delete(id)
    if (this.userNames.size >= MAX_USER_NAMES) {
      const oldest = this.userNames.keys().next().value
      if (oldest !== undefined) this.userNames.delete(oldest)
    }
    this.userNames.set(id, clean)
  }

  private resolveUserName(chatKey: string, userId: string): string | undefined {
    const cached = this.userNames.get(userId)
    if (cached !== undefined) return cached
    const recent = this.im.history.before(chatKey, Number.MAX_SAFE_INTEGER, 50)
    for (let i = recent.length - 1; i >= 0; i--) {
      const sender = recent[i]!.sender
      if (sender.id === userId && sender.name?.trim()) {
        const clean = sender.name.trim()
        this.rememberUserName(userId, clean)
        return clean
      }
    }
    return undefined
  }

  private formatReactionLine(entry: PendingReaction): string {
    const from = entry.userName ?? this.resolveUserName(entry.message.chat.key, entry.userId) ?? entry.userId
    const attrs = [
      `action="${entry.action}"`,
      `message="#${entry.message.seq}"`,
      `from="${attr(from)}"`,
      `user-id="${attr(entry.userId)}"`,
      `emoji="${attr(entry.emoji)}"`,
      `time="${clock(entry.time)}"`,
    ]
    if (entry.message.thread?.id) attrs.push(`thread="${attr(entry.message.thread.id)}"`)
    const preview = previewText(entry.message.text)
    if (preview) attrs.push(`preview="${attr(preview)}"`)
    return `<im-reaction ${attrs.join(' ')} />`
  }

  private appendReactionsToContent(
    content: ContentBlockLike[],
    reactions: readonly PendingReaction[],
    notice?: string,
  ): ContentBlockLike[] {
    if (reactions.length === 0) return content
    const lines = [
      ...notice === undefined ? [] : [notice],
      ...reactions.map(item => this.formatReactionLine(item)),
    ].join('\n')
    const out = [...content]
    const textIndex = out.findIndex(block => block.type === 'text' && typeof block.text === 'string')
    if (textIndex >= 0) {
      const block = out[textIndex]!
      const prev = String(block.text)
      out[textIndex] = { ...block, text: prev ? `${prev}\n${lines}` : lines }
    } else {
      out.unshift({ type: 'text', text: lines })
    }
    return out
  }

  private takeRouterReactions(routerKey: string): PendingReaction[] {
    const items = this.pendingRouterReactions.get(routerKey)
    if (items === undefined || items.length === 0) return []
    this.pendingRouterReactions.delete(routerKey)
    return items
  }

  aclOfSession(sessionId: string): SessionAclLike | undefined {
    return this.auth?.()?.aclOf(sessionId)
  }

  async taskOfRule(id: number): Promise<ImTaskLike | undefined> {
    const { store } = await this.opened
    const rule = store.rules.get(String(id))
    return rule === undefined ? undefined : this.tasks.get(rule.task)
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals

  private async load(quickjs: () => Promise<QuickJSWASMModule>): Promise<Opened> {
    const engine = new RuleEngine(await quickjs(),
      { timeoutMs: this.config.ruleTimeoutMs, memoryBytes: this.config.ruleMemoryBytes })
    const store = dispatchStore(await this.storage.open(dispatchDomain))
    for (const [chat, record] of store.chats.entries()) {
      this.chats.set(chat, record)
      if (record.type !== 'topic') {
        const key = `${DISPATCHER_CHAT_PREFIX}${chat}`
        this.routerKeys.add(key)
        if (this.im.sessions.get(key) === undefined) {
          await this.im.sessions.ensure(routerSpec(key, this.config, chat))
        }
      }
      if (record.topicCursors !== undefined) {
        for (const threadId of Object.keys(record.topicCursors)) {
          const topicKey = `${DISPATCHER_TOPIC_PREFIX}${chat}:${threadId}`
          this.routerKeys.add(topicKey)
          if (this.im.sessions.get(topicKey) === undefined) {
            await this.im.sessions.ensure(routerSpec(topicKey, this.config, chat, threadId))
          }
        }
      }
    }
    return { store, engine }
  }

  private async learn(message: ImStoredMessage): Promise<ImHostedRecord> {
    const { store } = await this.opened
    const chatKey = message.chat.key
    const directName = isDirectType(message.chat.ref.type) && !message.sender.self
      ? message.sender.name?.trim() || undefined
      : undefined
    const existingChat = this.chats.get(chatKey)

    if (existingChat === undefined || (directName !== undefined && existingChat.name !== directName)) {
      const updated = await this.serial(async () => {
        if (this.disposed) return false
        const current = store.chats.get(chatKey) ?? this.chats.get(chatKey)
        if (current === undefined) {
          const chat: DispatchChat = {
            source: message.chat.source,
            type: message.chat.ref.type,
            firstSeenAt: Date.now(),
            ...directName === undefined ? {} : { name: directName },
          }
          await store.chats.put(chatKey, chat)
          this.chats.set(chatKey, chat)
          return true
        }
        if (directName !== undefined && current.name !== directName) {
          const next: DispatchChat = { ...current, name: directName }
          await store.chats.put(chatKey, next)
          this.chats.set(chatKey, next)
          return true
        }
        return false
      })
      if (updated && existingChat !== undefined) this.onChatUpdated?.(chatKey)
    }

    if (!isDirectType(message.chat.ref.type) && this.chatInfo(chatKey)?.name === undefined) {
      const now = this.now()
      const last = this.chatNameProbedAt.get(chatKey)
      if (last === undefined || now - last >= CHAT_NAME_PROBE_INTERVAL_MS) {
        this.chatNameProbedAt.set(chatKey, now)
        void this.probeChatName(chatKey, message.chat.ref)
      }
    }

    const topicThread = message.chat.ref.type === 'topic' ? message.thread?.id : undefined
    const key = routerKeyOf(message.chat, topicThread)
    this.routerKeys.add(key)
    this.lastRouterKey = key
    const existing = this.im.sessions.get(key)
    if (existing !== undefined) return existing
    return await this.im.sessions.ensure(routerSpec(key, this.config, chatKey, topicThread))
  }

  private async probeChatName(chatKey: string, ref: ChatRefLike): Promise<void> {
    if (this.disposed) return
    let bot: ReturnType<NonNullable<DispatchIm['bot']>> | undefined
    try {
      bot = this.im.bot?.(chatKey)
    } catch {
      return
    }
    if (bot === undefined || (bot.getChat === undefined && bot.api?.getChat === undefined)) return

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const lookup = bot.getChat !== undefined
        ? bot.getChat(ref)
        : bot.api!.getChat!(ref.id, {}, controller.signal)
      void lookup.catch(() => {})
      const info = await Promise.race([
        lookup,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('chat name lookup timed out'))
          }, CHAT_NAME_PROBE_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
      const name = info?.name?.trim()
      if (!name || this.disposed) return
      const changed = await this.serial(async () => {
        if (this.disposed) return false
        const { store } = await this.opened
        const current = store.chats.get(chatKey) ?? this.chats.get(chatKey)
        if (current === undefined || current.name === name) return false
        const next: DispatchChat = { ...current, name }
        await store.chats.put(chatKey, next)
        this.chats.set(chatKey, next)
        return true
      })
      if (changed && !this.disposed) this.onChatUpdated?.(chatKey)
    } catch {
      // Missing im:chat:readonly scope or transient API errors leave short chat ID fallback intact.
    } finally {
      clearTimeout(timer)
    }
  }

  /** Build delta chat transcript + thread context + per-router incremental task delta, advancing persisted cursors. */
  private async buildRouterWakeContent(
    store: DispatchStore,
    router: ImHostedRecord,
    message: ImStoredMessage,
    wakeKind: RouterWakeKind,
    hasMessageAnchor = true,
  ): Promise<{ content: ContentBlockLike[]; empty?: boolean; reactionIds: string[] }> {
    const chatKey = message.chat.key
    const isTopicRouter = message.chat.ref.type === 'topic' && message.thread?.id !== undefined
    const topicThreadId = isTopicRouter ? message.thread!.id : undefined

    const include = (candidate: ImStoredMessage): boolean => {
      if (isEphemeralSelfMessage(candidate, this.ephemeral)) return false
      if (topicThreadId !== undefined) {
        return candidate.thread?.id === topicThreadId || candidate.thread?.root === topicThreadId
      }
      return true
    }

    const { delta, reactions, truncated, empty, taskBlock } = await this.serial(async () => {
      const pendingReactions = this.takeRouterReactions(router.key)
      const current = store.chats.get(chatKey) ?? this.chats.get(chatKey)
        ?? { source: message.chat.source, type: message.chat.ref.type, firstSeenAt: Date.now() }
      const prevSeq = topicThreadId === undefined ? current.deliveredSeq : current.topicCursors?.[topicThreadId]
      if (wakeKind === 'ambient' && pendingReactions.length === 0 && prevSeq !== undefined && message.seq <= prevSeq) {
        return { delta: [] as ImStoredMessage[], reactions: pendingReactions, truncated: false, empty: true, taskBlock: '' }
      }

      let items: ImStoredMessage[]
      let cutOff = false
      if (!hasMessageAnchor) {
        if (prevSeq === undefined) {
          items = this.config.freshContextMessages > 0
            ? this.im.history.before(chatKey, Number.MAX_SAFE_INTEGER, this.config.freshContextMessages, include)
            : []
        } else {
          const after = this.im.history.after(chatKey, prevSeq, this.config.maxRouterDeltaMessages + 1, include)
          if (after.length > this.config.maxRouterDeltaMessages) {
            cutOff = true
            items = after.slice(-this.config.maxRouterDeltaMessages)
          } else {
            items = after
          }
        }
      } else if (prevSeq === undefined) {
        const before = this.config.freshContextMessages > 0
          ? this.im.history.before(chatKey, message.seq, this.config.freshContextMessages, include)
          : []
        items = [...before, message]
      } else {
        const after = this.im.history
          .after(chatKey, prevSeq, this.config.maxRouterDeltaMessages + 1, include)
          .filter(item => item.seq <= message.seq)
        if (after.length > this.config.maxRouterDeltaMessages) {
          cutOff = true
          const recentBefore = this.config.maxRouterDeltaMessages > 1
            ? this.im.history.before(chatKey, message.seq, this.config.maxRouterDeltaMessages - 1, include)
            : []
          items = [...recentBefore, message]
        } else {
          items = after.some(item => item.key === message.key) ? after : [...after, message]
        }
      }

      if (items.length === 0 && pendingReactions.length === 0) {
        return { delta: [] as ImStoredMessage[], reactions: pendingReactions, truncated: false, empty: true, taskBlock: '' }
      }

      const allTasks = this.tasks.list().filter(task => this.isDispatchTask(task))
      const prevTasks = topicThreadId === undefined ? current.deliveredTasks : current.topicTaskCursors?.[topicThreadId]
      const prevFloorId = (topicThreadId === undefined
        ? current.deliveredTaskFloorId
        : current.topicTaskFloorIds?.[topicThreadId]) ?? 0
      const formattedTasks = prevTasks === undefined
        ? this.formatTaskSnapshot(allTasks, chatKey)
        : this.formatTaskDelta(allTasks, prevTasks, prevFloorId)
      const { nextTasks, nextFloorId } = this.advanceTaskCursors(prevTasks, prevFloorId, allTasks)

      const anchorSeq = hasMessageAnchor ? message.seq : 0
      const nextSeq = Math.max(prevSeq ?? 0, anchorSeq, ...items.map(item => item.seq))
      let updated: DispatchChat
      if (topicThreadId === undefined) {
        const { deliveredTaskFloorId: _dropFloor, ...rest } = current
        updated = {
          ...rest,
          ...nextSeq > 0 ? { deliveredSeq: nextSeq } : {},
          deliveredTasks: nextTasks,
          ...nextFloorId > 0 ? { deliveredTaskFloorId: nextFloorId } : {},
        }
      } else {
        const { topicTaskFloorIds: _dropFloors, ...rest } = current
        const nextFloors = nextFloorId > 0
          ? { ...current.topicTaskFloorIds, [topicThreadId]: nextFloorId }
          : dropRecordKey(current.topicTaskFloorIds, topicThreadId)
        updated = {
          ...rest,
          ...nextSeq > 0 ? { topicCursors: { ...current.topicCursors, [topicThreadId]: nextSeq } } : {},
          topicTaskCursors: { ...current.topicTaskCursors, [topicThreadId]: nextTasks },
          ...nextFloors === undefined ? {} : { topicTaskFloorIds: nextFloors },
        }
      }
      await store.chats.put(chatKey, updated)
      this.chats.set(chatKey, updated)
      return { delta: items, reactions: pendingReactions, truncated: cutOff, empty: false, taskBlock: formattedTasks }
    })

    if (empty) return { content: [], empty: true, reactionIds: [] }

    const chatConfig = this.chats.get(chatKey)
    const wakeMode = this.effectiveWakeMode(chatConfig)
    const replyMode = this.effectiveReplyMode(chatConfig)
    const headerLines = [
      `<im-chat key="${attr(chatKey)}" source="${attr(message.chat.source)}" type="${attr(message.chat.ref.type)}" router="${attr(router.key)}" trigger="${wakeKind}" wake-mode="${wakeMode}" reply-mode="${replyMode}" />`,
    ]
    if (
      (chatConfig?.watchTopics !== undefined && chatConfig.watchTopics.length > 0)
      || chatConfig?.watchNote !== undefined
      || chatConfig?.replyPolicy !== undefined
    ) {
      const cfgParts: string[] = []
      if (chatConfig.watchTopics !== undefined && chatConfig.watchTopics.length > 0) {
        cfgParts.push(`<watch-topics>${attr(chatConfig.watchTopics.join('、'))}</watch-topics>`)
      }
      if (chatConfig.watchNote !== undefined) {
        cfgParts.push(`<watch-note>${attr(chatConfig.watchNote)}</watch-note>`)
      }
      if (chatConfig.replyPolicy !== undefined) {
        cfgParts.push(`<reply-policy>${attr(chatConfig.replyPolicy)}</reply-policy>`)
      }
      headerLines.push(`<chat-config>\n  ${cfgParts.join('\n  ')}\n</chat-config>`)
    }
    if (wakeKind === 'ambient') {
      if (replyMode === 'mention_only') {
        headerLines.push(
          '<ambient-notice>这是一次未 @ 机器人的旁路监听唤醒（trigger="ambient"，当前群 replyMode="mention_only"）。本批增量消息是群里发生的全部内容（含群友之间、别的机器人、告警广播），其中 @ 别人（包括 @ 其他 bot）的消息不是在叫你，`trigger="direct"` 才是唯一判据。请检查本批未读消息是否命中本群 watch-topics / watch-note 或某任务的 wantedTopics：若命中，调用 create_task / route_messages_to_task / steer_task 处理；若未命中，不要调用任何工具，直接结束本轮保持沉默。禁止在此模式下调用 router_reply。</ambient-notice>',
        )
      } else {
        headerLines.push(
          `<ambient-notice>这是一次未 @ 机器人的主动模式唤醒（trigger="ambient"，当前群 replyMode="proactive"）。请结合 watch-topics / watch-note / reply-policy 与上下文判断是否介入：简单闲聊/通用常识/Chronicle 已知结论可用 router_reply 简短回复（上限 ${this.config.maxAutoRepliesPerHour} 次/小时）；若需查 Wiki、代码、文档、日志或调 skill 才能答准，请调 create_task 由 Worker 在话题调查回复，不要靠猜调用 router_reply；无需介入则不调工具直接沉默结束。</ambient-notice>`,
        )
      }
    }
    if (reactions.length > 0) {
      headerLines.push(ROUTER_REACTION_NOTICE)
    }
    if (message.thread !== undefined) {
      for (const task of this.findThreadTasks(message)) {
        headerLines.push(
          `<thread-context task="#${task.id}" title="${attr(task.title)}" follow-thread="${task.followThread === true}"`
          + (task.note === undefined ? '' : ` note="${attr(task.note)}"`)
          + (task.description === undefined ? '' : ` description="${attr(task.description)}"`)
          + ' />',
        )
      }
    }
    if (taskBlock !== '') headerLines.push(taskBlock)
    if (truncated) {
      headerLines.push(`<context-note>未读消息较多，已截断仅保留最近 ${delta.length} 条增量消息（含本次触发消息 #${message.seq}）。</context-note>`)
    }

    const header = headerLines.join('\n')
    const baseContent = delta.length > 0
      ? await this.im.format(delta, {
        style: 'xml',
        media: true,
        header,
      })
      : [{ type: 'text', text: header }]
    const content = this.appendReactionsToContent(baseContent, reactions)
    return { content, reactionIds: reactions.map(item => item.id) }
  }

  private advanceTaskCursors(
    prevTasks: Record<string, number> | undefined,
    prevFloorId: number,
    allTasks: readonly ImTaskLike[],
  ): { nextTasks: Record<string, number>; nextFloorId: number } {
    const nextTasks: Record<string, number> = { ...prevTasks }
    for (const task of allTasks) {
      nextTasks[String(task.id)] = task.updatedAt
    }
    const entries = Object.entries(nextTasks)
    if (entries.length <= MAX_TRACKED_TASK_VERSIONS) {
      return { nextTasks, nextFloorId: prevFloorId }
    }
    entries.sort((left, right) => Number(right[0]) - Number(left[0]))
    const kept: Record<string, number> = {}
    let nextFloorId = prevFloorId
    for (let index = 0; index < entries.length; index++) {
      const [idKey, ts] = entries[index]!
      if (index < MAX_TRACKED_TASK_VERSIONS) {
        kept[idKey] = ts
      } else {
        const numericId = Number(idKey)
        if (Number.isFinite(numericId)) nextFloorId = Math.max(nextFloorId, numericId)
      }
    }
    return { nextTasks: kept, nextFloorId }
  }

  private formatTaskLines(items: readonly { task: ImTaskLike; change?: 'new' | 'updated' }[]): string[] {
    return items.map(({ task, change }) => {
      const attrs = [
        `id="#${task.id}"`,
        ...change === undefined ? [] : [`change="${change}"`],
        `title="${attr(task.title)}"`,
        `chat="${attr(task.chat)}"`,
        `scope="${task.topicScope ?? 'chat'}"`,
        `follow-thread="${task.followThread === true}"`,
      ]
      const details: string[] = []
      if (task.description !== undefined) details.push(`描述：${task.description}`)
      if (task.wantedTopics !== undefined && task.wantedTopics.length > 0) {
        details.push(`希望接手话题：${task.wantedTopics.join('、')}`)
      }
      if (task.note !== undefined) details.push(`最近备注：${task.note}`)
      if (details.length === 0) return `  <task ${attrs.join(' ')} />`
      return `  <task ${attrs.join(' ')}>${attr(details.join(' | '))}</task>`
    })
  }

  private formatTaskSnapshot(allTasks: readonly ImTaskLike[], currentChatKey: string): string {
    if (allTasks.length === 0) return ''
    const localAll: ImTaskLike[] = []
    const crossAll: ImTaskLike[] = []
    for (const task of allTasks) {
      const worker = this.im.sessions.get(task.session)
      const inCurrent = task.chat === currentChatKey || worker?.bindings.some(b => b.chat === currentChatKey) === true
      if (inCurrent) {
        localAll.push(task)
      } else if (task.topicScope === 'all' || (task.wantedTopics !== undefined && task.wantedTopics.length > 0)) {
        crossAll.push(task)
      }
    }
    const prioritizeWatched = (list: ImTaskLike[]): ImTaskLike[] => {
      const watched: ImTaskLike[] = []
      const plain: ImTaskLike[] = []
      for (const task of list) {
        if (task.wantedTopics !== undefined && task.wantedTopics.length > 0) watched.push(task)
        else plain.push(task)
      }
      return [...watched, ...plain].slice(0, MAX_ACTIVE_TASK_SUMMARY)
    }
    const selected = [...prioritizeWatched(localAll), ...prioritizeWatched(crossAll)]
    if (selected.length === 0) return ''
    return [
      '<tasks-snapshot>',
      ...this.formatTaskLines(selected.map(task => ({ task }))),
      '</tasks-snapshot>',
    ].join('\n')
  }

  private formatTaskDelta(
    allTasks: readonly ImTaskLike[],
    prevTasks: Record<string, number>,
    prevFloorId: number,
  ): string {
    const changed: Array<{ task: ImTaskLike; change: 'new' | 'updated' }> = []
    for (const task of allTasks) {
      const key = String(task.id)
      const seenAt = prevTasks[key]
      if (seenAt === undefined) {
        if (task.id > prevFloorId) changed.push({ task, change: 'new' })
      } else if (seenAt !== task.updatedAt) {
        changed.push({ task, change: 'updated' })
      }
    }
    if (changed.length === 0) return ''
    changed.sort((left, right) => right.task.updatedAt - left.task.updatedAt || right.task.id - left.task.id)
    return [
      '<tasks-delta>',
      ...this.formatTaskLines(changed.slice(0, MAX_TASK_DELTA)),
      '</tasks-delta>',
    ].join('\n')
  }

  private desiredWorkerThread(message: ImStoredMessage): string | undefined {
    if (message.thread?.id !== undefined && message.thread.id !== '') return message.thread.id
    if (this.autoThreads(message)) {
      const msgId = splitKey(message.key).id
      if (msgId !== '') return msgId
    }
    return undefined
  }

  /**
   * Whether a new task started on this main-timeline message is confined to a reply thread: `autoThread` is on, the
   * chat is a group, and its platform has reply threads (not in `threadlessPlatforms`, and the bot does not deny
   * `message.thread`).
   */
  private autoThreads(message: ImStoredMessage): boolean {
    if (!this.config.autoThread || isDirectType(message.chat.ref.type)) return false
    const platform = splitKey(message.chat.key).bot.split(':')[0]?.toLowerCase() ?? ''
    if (this.config.threadlessPlatforms.some(name => name.toLowerCase() === platform)) return false
    try {
      const bot = this.im.bot?.(message.chat.key)
      if (bot?.supports?.('message.thread', { chat: message.chat.ref }) === false) return false
    } catch { /* an unmounted bot keeps the configured answer */ }
    return true
  }

  /** Find tasks holding a writable thread-confined binding matching `message`'s thread/root/quote. */
  private findThreadTasks(message: ImStoredMessage): ImTaskLike[] {
    const matched: ImTaskLike[] = []
    for (const task of this.tasks.list()) {
      if (!this.isDispatchTask(task)) continue
      const worker = this.im.sessions.get(task.session)
      if (worker === undefined) continue
      const hit = worker.bindings.some(
        b => b.chat === message.chat.key && b.writable && matchesBindingThread(b, message),
      )
      if (hit) matched.push(task)
    }
    return matched
  }

  private bindWorkerThread(workerSessionId: string, chat: string, threadId: string): Promise<void> {
    const previous = this.granting.get(workerSessionId) ?? Promise.resolve()
    const updated = previous.then(async () => {
      const record = this.im.sessions.get(workerSessionId)
      if (record === undefined) return
      if (record.bindings.some(b => b.chat === chat && b.writable && b.thread === threadId)) return
      const next = [...record.bindings, { chat, writable: true, thread: threadId }]
      await this.im.sessions.bind(workerSessionId, next)
    })
    const chain = updated.then(() => {}, () => {})
    this.granting.set(workerSessionId, chain)
    void chain.then(() => { if (this.granting.get(workerSessionId) === chain) this.granting.delete(workerSessionId) })
    return updated
  }

  private grant(worker: string, messages: readonly ImStoredMessage[]): Promise<void> {
    const previous = this.granting.get(worker) ?? Promise.resolve()
    const granted = previous.then(async () => {
      const record = this.im.sessions.get(worker)
      if (record === undefined) return
      const bindings = computeWritableBindings(
        record.bindings,
        messages,
        msg => this.desiredWorkerThread(msg),
        msg => this.autoThreads(msg),
      )
      if (bindings !== undefined) await this.im.sessions.bind(worker, bindings)
    })
    const chain = granted.then(() => {}, () => {})
    this.granting.set(worker, chain)
    void chain.then(() => { if (this.granting.get(worker) === chain) this.granting.delete(worker) })
    return granted
  }

  private grantChatFallback(worker: string, chat: string): Promise<void> {
    const previous = this.granting.get(worker) ?? Promise.resolve()
    const granted = previous.then(async () => {
      const record = this.im.sessions.get(worker)
      if (record === undefined) return
      if (record.bindings.some(b => b.chat === chat && b.writable)) return
      const next = record.bindings.some(b => b.chat === chat)
        ? record.bindings.map(b => (b.chat === chat ? { ...b, writable: true } : b))
        : [...record.bindings, { chat, writable: true }]
      await this.im.sessions.bind(worker, next)
    })
    const chain = granted.then(() => {}, () => {})
    this.granting.set(worker, chain)
    void chain.then(() => { if (this.granting.get(worker) === chain) this.granting.delete(worker) })
    return granted
  }

  private candidates(store: DispatchStore, chat: string): Candidate[] {
    const found: Candidate[] = []
    for (const task of this.tasks.list()) {
      if (!this.isDispatchTask(task)) continue
      const worker = this.im.sessions.get(task.session)
      if (worker === undefined || !worker.bindings.some(binding => binding.chat === chat)) continue
      for (const rule of this.rulesOf(store, task.id)) found.push({ rule, task })
    }
    return found
  }

  private evaluate(engine: RuleEngine, candidates: readonly Candidate[], input: RuleInput): Map<number, RuleOutcome> {
    const outcomes = engine.evaluate(new Map(candidates.map(({ rule }) => [rule.id, rule.match])), input)
    for (const [id, outcome] of outcomes) {
      if (outcome.error === undefined) continue
      const failure = this.failures.get(id)
      this.failures.set(id, { count: (failure?.count ?? 0) + 1, last: outcome.error })
      this.logger.warn('IM route rule #%d failed on message %s and did not match: %s', id, input.id, outcome.error)
    }
    return outcomes
  }

  private isDispatchTask(task: ImTaskLike): boolean {
    if (task.ownerKind === DISPATCHER_OWNER) return true
    if (task.meta?.by === DISPATCHER_OWNER) return true
    const owner = this.im.sessions.get(task.owner)
    if (owner !== undefined) {
      return isRouterKey(owner.key) || owner.owner === DISPATCHER_OWNER
    }
    return task.ownerKind === undefined
  }

  private peek(agent?: AgentLike): Role | undefined {
    try {
      return this.roleOf(agent)
    } catch {
      return undefined
    }
  }

  private roleOf(agent: AgentLike | undefined): Role {
    const record = agent === undefined ? undefined : this.im.sessions.get(agent.session.id)
    if (record === undefined) throw new ImError('ownership', 'Dispatch tools require a session that the IM host serves.')
    if (isRouterKey(record.key) || record.owner === DISPATCHER_OWNER) {
      return { kind: 'dispatcher', record }
    }
    const task = this.tasks.of(record.sessionId)
    if (task !== undefined && this.isDispatchTask(task)) {
      return { kind: 'worker', record, task }
    }
    throw new ImError('access', 'Only a router or a dispatch task worker can do this.')
  }

  private workerOf(caller: AgentLike): { record: ImHostedRecord; task: ImTaskLike } {
    const role = this.roleOf(caller)
    if (role.kind !== 'worker') {
      throw new ImError('access', 'Only a worker of a dispatch task manages its route rules.')
    }
    return role
  }

  private dispatcherOf(caller: AgentLike): { record: ImHostedRecord } {
    const role = this.roleOf(caller)
    if (role.kind !== 'dispatcher') throw new ImError('access', 'Only a chat router starts, steers, and routes tasks.')
    return role
  }

  private taskOf(id: number): ImTaskLike {
    const task = this.tasks.get(id)
    if (task === undefined) throw new ImError('access', `No task #${id} exists.`)
    return task
  }

  private rulesOf(store: DispatchStore, task: number): RouteRule[] {
    return [...store.rules.entries()].map(([, rule]) => rule).filter(rule => rule.task === task)
  }

  private ownedRule(store: DispatchStore, task: ImTaskLike, id: number): RouteRule {
    const rule = store.rules.get(String(id))
    if (rule === undefined || rule.task !== task.id) {
      throw new ImError('access', `Task #${task.id} holds no route rule #${id}.`)
    }
    return rule
  }

  private expression(engine: RuleEngine, match: string): string {
    if (!match.trim()) {
      throw new ImError('capacity', 'A route rule expression must not be empty; omit it to match every message.')
    }
    if (match.length > this.config.maxRuleChars) {
      throw new ImError('capacity', `A route rule expression exceeds ${this.config.maxRuleChars} characters.`)
    }
    const error = engine.check(match)
    if (error !== undefined) throw new ImError('capacity', `The route rule expression does not compile: ${error}`)
    return match
  }

  private note(note: string | undefined): string | undefined {
    if (note !== undefined && note.length > this.config.maxRuleChars) {
      throw new ImError('capacity', `A route rule note exceeds ${this.config.maxRuleChars} characters.`)
    }
    return note?.trim() ? note : undefined
  }

  private describe(rule: RouteRule): string {
    const effect = rule.mode === 'cut'
      ? 'messages it matches go to that task instead of you, even when they mention the bot'
      : 'messages it matches go to that task, and you still receive the ones that address the bot'
    return `route rule #${rule.id} (${rule.mode}): ${rule.match}${rule.note === undefined ? '' : ` — ${rule.note}`}. `
      + `Every admitted message is evaluated against it: ${effect}.`
  }

  private async announce(
    session: string, text: string, summary: string, rule: RouteRule, change: 'added' | 'changed' | 'removed',
  ): Promise<void> {
    try {
      const task = this.tasks.get(rule.task)
      if (task !== undefined) this.hooks.ruleChanged?.(change, this.view(rule, task))
    } catch (error: unknown) {
      this.logger.warn('im-dispatch: a rule observer failed: %s', String(error))
    }
    if (this.im.sessions.get(session) === undefined) return
    try {
      await this.im.sessions.deliver(session, {
        id: `dispatch:rule:${rule.id}:${rule.updatedAt}:${change}`, mode: 'inject', content: [{ type: 'text', text }],
      })
    } catch (error: unknown) {
      this.logger.error('IM route-rule notice "%s" was not delivered; the change stands: %s', summary, error)
    }
  }

  private view(rule: RouteRule, task: ImTaskLike): RouteRuleView {
    const failure = this.failures.get(rule.id)
    return {
      id: rule.id,
      task: task.id,
      match: rule.match,
      mode: rule.mode,
      ...rule.note === undefined ? {} : { note: rule.note },
      ...failure === undefined ? {} : { errors: failure.count, lastError: failure.last },
    }
  }

  private chatOf(record: ImHostedRecord, token: string | undefined): string {
    const wanted = token?.trim() ?? ''
    if (wanted !== '') {
      for (const chat of this.chats.keys()) {
        if (chat === wanted || splitKey(chat).id === wanted) return chat
      }
      throw new ImError('access', `No chat ${wanted} has reached dispatch; use the chat key of the arriving context.`)
    }
    const taskChat = this.tasks.of(record.sessionId)?.chat
    if (taskChat !== undefined) return taskChat
    const triggerChat = this.triggerOf(record.sessionId)?.chat.key
    if (triggerChat !== undefined) return triggerChat
    const homeChat = record.bindings.find(b => b.home === true)?.chat ?? record.bindings[0]?.chat
    if (homeChat !== undefined && isRouterKey(record.key)) return homeChat
    throw new ImError('capacity', 'Name the chat: this turn has no message to infer it from.')
  }

  private triggerOf(session: string): ImStoredMessage | undefined {
    return this.im.sessions.trigger?.(session)
  }

  private lookup(chat: string, token: string): ImStoredMessage {
    const trimmed = token.trim()
    const numbered = /^#(\d+)$/.exec(trimmed)
    const seq = numbered === null ? undefined : Number(numbered[1])
    const message = seq === undefined
      ? this.im.history.get(trimmed.includes('|')
        ? messageKey(splitKey(trimmed).bot, splitKey(trimmed).id)
        : messageKey(splitKey(chat).bot, trimmed))
      : this.im.history.after(chat, seq - 1, 1).find(candidate => candidate.seq === seq)
    if (message === undefined || message.chat.key !== chat) {
      throw new ImError('access', `No message ${trimmed} is stored in chat ${chat}.`)
    }
    return message
  }

  private span(chat: string, range: { from: string; to: string }): ImStoredMessage[] {
    const from = this.lookup(chat, range.from)
    const to = this.lookup(chat, range.to)
    if (to.seq < from.seq) throw new ImError('capacity', 'A message range ends before it starts.')
    const span = this.im.history.after(chat, from.seq - 1, this.config.maxTaskMessages + 1)
      .filter(message => message.seq <= to.seq)
    if (span.length > this.config.maxTaskMessages) {
      throw new ImError('capacity', `That range reaches further than ${this.config.maxTaskMessages} messages; name fewer.`)
    }
    return span
  }

  private handoff(chat: string, all: readonly ImStoredMessage[]): ImStoredMessage[] {
    if (this.config.contextMessages === 0) return [...all]
    const byConversation = new Map<string | undefined, ImStoredMessage[]>()
    for (const message of all) {
      const threadId = message.thread?.id
      let group = byConversation.get(threadId)
      if (group === undefined) {
        group = []
        byConversation.set(threadId, group)
      }
      group.push(message)
    }
    const around: ImStoredMessage[] = []
    for (const [threadId, group] of byConversation) {
      let earliest = group[0]!
      let latest = group[0]!
      for (const message of group) {
        if (message.seq < earliest.seq) earliest = message
        if (message.seq > latest.seq) latest = message
      }
      const sameConversation = (message: ImStoredMessage): boolean => message.thread?.id === threadId
      around.push(
        ...this.im.history.before(chat, earliest.seq, this.config.contextMessages, sameConversation),
        ...this.im.history.after(chat, latest.seq, this.config.contextMessages, sameConversation),
      )
    }
    const quoted = all
      .flatMap(message => (message.quote === undefined ? [] : [this.im.history.get(message.quote.key)]))
      .filter((message): message is ImStoredMessage => message !== undefined && message.chat.key === chat)
    const seen = new Set<string>()
    const combined: ImStoredMessage[] = []
    for (const message of [...quoted, ...around, ...all]) {
      if (seen.has(message.key)) continue
      seen.add(message.key)
      combined.push(message)
    }
    return combined.sort((left, right) => left.seq - right.seq)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.then(() => {}, () => {})
    return result
  }
}
