/**
 * Core user-name resolution, caching and enrichment host for `dsh-im-user-names`.
 *
 * Enrichment flow (without modifying `dsh-im` or any platform adapter):
 * 1. `satori/receive`: passively harvests mention names from inbound messages (without mutating the raw message before
 *    `dsh-im`'s intake digest); enriches `reaction-*` users (bounded live lookup) and `interaction/*` users (strictly
 *    synchronous cache-only so card callbacks never risk the platform's 3-second deadline).
 * 2. `im/message` (`{ prepend: true }`): runs before `im-dispatch` / `im-session-auth` / `im-session-commands`; resolves
 *    missing sender names via static aliases → durable/memory cache → batch `ctx.im.members` roster sync → optional
 *    single-user contact lookup (with permission circuit-breaker), then writes `message.sender.name` (and optionally
 *    `message.quote.sender`) in place so downstream consumers see it immediately and `ImStore.settle()` persists it.
 * 3. `im/stored` (`{ prepend: true }`): passively harvests mentions and synchronously fills sender/quote names from
 *    cache for messages stored outside `im/message` (such as historical messages fetched on demand via `im_read`).
 */
import type { Bot, ChatRef, MembersPage, Session, UserRef } from '@deepseek-ai/cordis-plugin-im-core'
import type { ImChatKey, ImMessage, ImMessageEvent, ImMessageKey, ImOutcome } from '@deepseek-ai/dsh-im'
import type { Config } from './config.ts'
import { imUserNamesDomain, userCacheKey, type ImUserNamesDomain, type StoredUserName, type UserNameSource } from './domain.ts'
import { formatUserName, isPermissionError, isUsableName, stripIdSuffix } from './format.ts'

/** Minimal logger surface used by the host. */
export interface LoggerLike {
  debug?(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

/** Minimal `ctx.im` surface required by `ImUserNamesHost`. */
export interface ImHostLike {
  readonly history: {
    get(key: ImMessageKey): ImMessage | undefined
    before(chat: ImChatKey, seq: number, limit: number): ImMessage[]
  }
  members?(chat: ImChatKey, cursor?: string, limit?: number, signal?: AbortSignal): Promise<MembersPage>
  bot?(chat: ImChatKey): Bot
}

/** Minimal `ctx.storageDomain` surface required by `ImUserNamesHost`. */
export interface StorageDomainLike {
  open(spec: typeof imUserNamesDomain): Promise<ImUserNamesDomain>
}

/** Optional options for {@link ImUserNamesHost.resolve}. */
export interface ResolveUserOptions {
  chatKey?: ImChatKey
  chatType?: ChatRef['type']
  isBot?: boolean
  bot?: Bot
  /** Set `false` for strictly synchronous cache/alias lookups (no platform I/O). */
  allowLive?: boolean
  /** Override wall-clock lookup timeout for this call (e.g. shorter budget for reactions). */
  timeoutMs?: number
}

/** Structural duck-type for Lark-like `bot.internal.contact.user.get`. */
type ContactUserGet = (
  userId: string,
  query?: { user_id_type?: 'open_id' | 'union_id' | 'user_id' },
) => Promise<unknown>

interface ContactCapableBot {
  internal?: {
    contact?: {
      user?: {
        get?: ContactUserGet
      }
    }
  }
}

export interface ImUserNamesHostDeps {
  im: ImHostLike
  storage: StorageDomainLike
  logger: LoggerLike
  config: Config
  now?: () => number
}

const MEMBERS_PAGE_SIZE = 100
const BACKFILL_HISTORY_LIMIT = 100
const REACTION_TIMEOUT_CAP_MS = 1_500

function splitKey(key: string): { bot: string; id: string } {
  const at = key.indexOf('|')
  return at < 0 ? { bot: '', id: key } : { bot: key.slice(0, at), id: key.slice(at + 1) }
}

function asMessageKey(botId: string, messageId: string): ImMessageKey {
  return `${botId}|${messageId}` as ImMessageKey
}

function asChatKey(botId: string, chatId: string): ImChatKey {
  return `${botId}|${chatId}` as ImChatKey
}

function extractContactName(response: unknown): string | undefined {
  if (response === null || typeof response !== 'object') return undefined
  const root = response as Record<string, unknown>
  const nestedData = root.data !== null && typeof root.data === 'object' ? root.data as Record<string, unknown> : undefined
  const candidate = (root.user ?? nestedData?.user ?? root) as Record<string, unknown> | undefined
  if (candidate === null || typeof candidate !== 'object') return undefined
  for (const field of ['name', 'nickname', 'en_name'] as const) {
    const value = candidate[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

async function raceTimeout<T>(operation: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  // Suppress unhandled rejection if the underlying promise rejects after timeout wins the race.
  void operation.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.()
          reject(new Error(`user name lookup timed out after ${timeoutMs} ms`))
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class ImUserNamesHost {
  private readonly im: ImHostLike
  private readonly storage: StorageDomainLike
  private readonly logger: LoggerLike
  readonly config: Config
  private readonly now: () => number

  private domain: ImUserNamesDomain | undefined
  private readonly cache = new Map<string, StoredUserName>()
  private readonly userNegativeUntil = new Map<string, number>()
  private readonly chatRosterCooldownUntil = new Map<string, number>()
  private readonly contactForbiddenUntil = new Map<string, number>()
  private readonly inflightRosters = new Map<string, Promise<boolean>>()
  private readonly inflightContacts = new Map<string, Promise<string | undefined>>()
  private readonly backfilledChats = new Set<string>()
  private writes: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(deps: ImUserNamesHostDeps) {
    this.im = deps.im
    this.storage = deps.storage
    this.logger = deps.logger
    this.config = deps.config
    this.now = deps.now ?? (() => Date.now())
  }

  /** Open the `im_user_names` storage domain and hydrate the in-memory LRU cache. */
  async open(): Promise<void> {
    this.disposed = false
    const domain = await this.storage.open(imUserNamesDomain)
    this.domain = domain
    const entries = [...domain.table('users').entries()]
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    for (const [key, entry] of entries) {
      this.cache.set(key, entry)
    }
    this.evictOverflow()
  }

  /** Drain queued durable writes and close the storage domain. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.writes.catch(() => {})
    const domain = this.domain
    this.domain = undefined
    if (domain !== undefined) await domain.close()
    this.cache.clear()
    this.userNegativeUntil.clear()
    this.chatRosterCooldownUntil.clear()
    this.contactForbiddenUntil.clear()
    this.inflightRosters.clear()
    this.inflightContacts.clear()
    this.backfilledChats.clear()
  }

  /** Wait for any queued durable writes to settle (useful in tests). */
  async flush(): Promise<void> {
    await this.writes
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Public lookup & cache API

  /**
   * Synchronous pure display-name lookup (static aliases first, then cached entries including stale ones).
   * Returns the raw display name without `(${userId})`, or `undefined` when unknown.
   */
  lookup(botId: string, userId: string): string | undefined {
    const id = userId.trim()
    if (!id) return undefined
    const alias = this.aliasOf(botId, id)
    if (alias !== undefined) return alias
    return this.cache.get(userCacheKey(botId, id))?.name
  }

  /**
   * Synchronous formatted display label (`Name(userId)` when `includeId` is enabled, else `Name`), or `undefined`
   * when no display name is known for this user.
   */
  format(botId: string, userId: string): string | undefined {
    const raw = this.lookup(botId, userId)
    return raw === undefined ? undefined : formatUserName(raw, userId, this.config.includeId)
  }

  /** Record a learned pure display name in memory and queue durable persistence if new or stale. */
  remember(botId: string, userId: string, name: string, source: UserNameSource = 'sender'): void {
    const bot = botId.trim()
    const id = userId.trim()
    if (!bot || !id || !isUsableName(name, id)) return
    const clean = stripIdSuffix(name, id)
    if (!clean || clean === id) return
    const key = userCacheKey(bot, id)
    this.userNegativeUntil.delete(key)
    const now = this.now()
    const existing = this.cache.get(key)
    const refreshThreshold = Math.max(60_000, Math.floor(this.config.ttlMs / 2))
    if (existing !== undefined && existing.name === clean && now - existing.updatedAt < refreshThreshold) {
      // Refresh LRU recency in memory without triggering redundant durable writes.
      this.cache.delete(key)
      this.cache.set(key, existing)
      return
    }
    const next: StoredUserName = { name: clean, source, updatedAt: now }
    this.cache.delete(key)
    this.cache.set(key, next)
    const evicted = this.collectOverflowKeys()
    this.queueWrite(async (domain) => {
      await domain.table('users').put(key, next)
      if (evicted.length > 0) await domain.table('users').deleteMany(evicted)
    })
  }

  /**
   * Resolve the pure display name of one user (aliases → fresh cache → group roster sync → optional contact lookup).
   * Never throws on platform errors; degrades to stale cached value or `undefined`.
   */
  async resolve(botId: string, userId: string, options: ResolveUserOptions = {}): Promise<string | undefined> {
    const bot = botId.trim()
    const id = userId.trim()
    if (!bot || !id) return undefined

    const alias = this.aliasOf(bot, id)
    if (alias !== undefined) return alias

    const key = userCacheKey(bot, id)
    const now = this.now()
    const cached = this.cache.get(key)
    if (cached !== undefined && now - cached.updatedAt < this.config.ttlMs) {
      return cached.name
    }
    const stale = cached?.name
    if (options.allowLive === false || this.disposed) return stale
    if ((this.userNegativeUntil.get(key) ?? 0) > now) return stale

    const timeoutMs = options.timeoutMs ?? this.config.lookupTimeoutMs

    // Tier A: Batch-sync chat member roster (reuses existing `im_members` scope; zero contact scope needed).
    if (this.config.syncChatMembers && options.chatKey !== undefined && options.chatType !== 'direct') {
      await this.syncChatRoster(options.chatKey, timeoutMs)
      const afterRoster = this.cache.get(key)
      if (afterRoster !== undefined && this.now() - afterRoster.updatedAt < this.config.ttlMs) {
        return afterRoster.name
      }
    }

    // Tier B: Single-user contact lookup fallback (mainly for DMs or non-roster human users).
    if (this.config.contactFallback && options.isBot !== true) {
      const botInstance = options.bot ?? this.botOf(options.chatKey)
      if (botInstance !== undefined && (this.contactForbiddenUntil.get(bot) ?? 0) <= this.now()) {
        const contactName = await this.lookupContactUser(bot, id, botInstance, timeoutMs)
        if (contactName !== undefined) return contactName
      }
    }

    this.userNegativeUntil.set(key, this.now() + this.config.negativeTtlMs)
    return stale
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Event handlers

  /**
   * `im/message` waterfall handler (`{ prepend: true }`): enriches `event.message.sender.name` (and optionally
   * `event.message.quote.sender`) before downstream strategies (`im-dispatch`, `im-session-auth`, `im-session-commands`)
   * see it, and before `ImStore.settle()` persists the message record.
   */
  async handleMessage(event: ImMessageEvent, next: () => Promise<ImOutcome>): Promise<ImOutcome> {
    if (this.config.enabled && !this.disposed) {
      try {
        await this.enrichMessageEvent(event)
      } catch (error: unknown) {
        this.logger.warn('im-user-names: failed to enrich message %s: %s', event.message.key, String(error))
      }
    }
    return await next()
  }

  /**
   * `im/stored` listener (`{ prepend: true }`): passively harvests mention/sender names and synchronously enriches
   * messages stored outside the `im/message` waterfall (such as historical messages loaded via `im_read`).
   */
  onStored(message: ImMessage): void {
    if (!this.config.enabled || this.disposed) return
    try {
      this.harvestMessage(message)
      this.enrichMessageSync(message)
    } catch (error: unknown) {
      this.logger.warn('im-user-names: failed onStored for %s: %s', message.key, String(error))
    }
  }

  /**
   * `satori/receive` listener (`{ prepend: true }`):
   * - For messages: only harvests mention names (never mutates `session.message.sender` so intake dedupe digests stay
   *   identical to the raw wire payload).
   * - For reactions: enriches `session.reaction.user.name` (with a bounded live lookup if needed) before `bot.dispatch`
   *   emits `im/reaction`.
   * - For card interactions: enriches `user.name` strictly from memory/alias cache (0 ms I/O, protecting Feishu's 3 s
   *   callback deadline).
   */
  async onReceive(session: Session): Promise<void> {
    if (!this.config.enabled || this.disposed) return
    try {
      const botId = session.bot.id
      if (session.type === 'message' && session.message !== undefined) {
        for (const mentioned of session.message.mentions.users) {
          if (mentioned.id && mentioned.name) this.remember(botId, mentioned.id, mentioned.name, 'mention')
        }
        if (session.message.sender.id && session.message.sender.name && session.message.sender.id !== session.bot.selfId) {
          this.remember(botId, session.message.sender.id, session.message.sender.name, 'sender')
        }
        return
      }

      if ((session.type === 'reaction-added' || session.type === 'reaction-removed') && session.reaction?.user !== undefined) {
        const user = session.reaction.user
        if (!user.id || (session.bot.selfId && user.id === session.bot.selfId)) return
        const stored = this.im.history.get(asMessageKey(botId, session.reaction.message.id))
        const chatKey = stored?.chat.key
          ?? (session.reaction.message.chat !== undefined ? asChatKey(botId, session.reaction.message.chat.id) : undefined)
        const chatType = stored?.chat.ref.type ?? session.reaction.message.chat?.type
        await this.enrichUserRef(botId, user, {
          ...chatKey === undefined ? {} : { chatKey },
          ...chatType === undefined ? {} : { chatType },
          isBot: user.isBot === true,
          bot: session.bot,
          allowLive: true,
          timeoutMs: Math.min(this.config.lookupTimeoutMs, REACTION_TIMEOUT_CAP_MS),
        })
        return
      }

      const interactionUser = session.button?.user ?? session.select?.user ?? session.check?.user
      if (interactionUser !== undefined && interactionUser.id) {
        this.enrichUserRefSync(botId, interactionUser)
      }
    } catch (error: unknown) {
      // Never reject `satori/receive`: an error here would withhold the platform event ACK.
      this.logger.warn('im-user-names: failed onReceive (%s): %s', session.type, String(error))
    }
  }

  /** Passively harvest user names from mentions (and any existing sender/quote names) on one message. */
  harvestMessage(message: ImMessage): void {
    const botId = message.chat.bot || splitKey(message.chat.key).bot
    if (!botId) return
    for (const mentioned of message.mentions.users) {
      if (mentioned.id && mentioned.name) {
        this.remember(botId, mentioned.id, mentioned.name, 'mention')
      }
    }
    if (!message.sender.self && message.sender.id && message.sender.name) {
      this.remember(botId, message.sender.id, message.sender.name, 'sender')
    }
    if (message.quote?.sender?.id && message.quote.sender.name) {
      this.remember(botId, message.quote.sender.id, message.quote.sender.name, 'sender')
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals

  private aliasOf(botId: string, userId: string): string | undefined {
    const raw = this.config.aliases[userCacheKey(botId, userId)] ?? this.config.aliases[userId]
    if (typeof raw !== 'string') return undefined
    const clean = stripIdSuffix(raw, userId)
    return clean || undefined
  }

  private botOf(chatKey: ImChatKey | undefined): Bot | undefined {
    if (chatKey === undefined || this.im.bot === undefined) return undefined
    try {
      return this.im.bot(chatKey)
    } catch {
      return undefined
    }
  }

  private async enrichMessageEvent(event: ImMessageEvent): Promise<void> {
    const { message, bot } = event
    const botId = message.chat.bot || bot.id
    this.harvestMessage(message)

    if (!message.sender.self && message.sender.id) {
      await this.enrichUserRef(botId, message.sender, {
        chatKey: message.chat.key,
        chatType: message.chat.ref.type,
        isBot: message.sender.isBot === true,
        bot,
        allowLive: true,
      })
    }

    if (this.config.enrichQuotes) {
      this.enrichQuoteSync(message, botId, bot.selfId)
    }

    // Backfill older in-memory messages of this chat once after startup so the first router delta / im_history
    // after installing or restarting already shows resolved names from the persisted cache.
    if (!this.backfilledChats.has(message.chat.key)) {
      this.backfilledChats.add(message.chat.key)
      this.backfillChatHistory(message.chat.key, message.seq, bot.selfId)
    }
  }

  private enrichMessageSync(message: ImMessage, botSelfId?: string): void {
    const botId = message.chat.bot || splitKey(message.chat.key).bot
    if (!botId) return
    if (!message.sender.self && message.sender.id) {
      this.enrichUserRefSync(botId, message.sender)
    }
    if (this.config.enrichQuotes) {
      this.enrichQuoteSync(message, botId, botSelfId)
    }
  }

  private enrichUserRefSync(botId: string, user: UserRef): void {
    const id = user.id.trim()
    if (!id) return
    const alias = this.aliasOf(botId, id)
    if (alias !== undefined) {
      user.name = formatUserName(alias, id, this.config.includeId)
      return
    }
    if (isUsableName(user.name, id)) {
      user.name = formatUserName(user.name!, id, this.config.includeId)
      return
    }
    const cached = this.cache.get(userCacheKey(botId, id))?.name
    if (cached !== undefined) {
      user.name = formatUserName(cached, id, this.config.includeId)
    }
  }

  private async enrichUserRef(botId: string, user: UserRef, options: ResolveUserOptions): Promise<void> {
    const id = user.id.trim()
    if (!id) return
    const alias = this.aliasOf(botId, id)
    if (alias !== undefined) {
      user.name = formatUserName(alias, id, this.config.includeId)
      return
    }
    if (isUsableName(user.name, id)) {
      this.remember(botId, id, user.name!, 'sender')
      user.name = formatUserName(user.name!, id, this.config.includeId)
      return
    }
    const resolved = await this.resolve(botId, id, options)
    if (resolved !== undefined) {
      user.name = formatUserName(resolved, id, this.config.includeId)
    }
  }

  private enrichQuoteSync(message: ImMessage, botId: string, botSelfId?: string): void {
    const quote = message.quote
    if (quote === undefined) return
    const storedQuoted = this.im.history.get(quote.key)
    const sameChatQuoted = storedQuoted !== undefined && storedQuoted.chat.key === message.chat.key
      ? storedQuoted
      : undefined
    if (quote.sender === undefined && sameChatQuoted !== undefined && sameChatQuoted.sender.id) {
      quote.sender = {
        id: sameChatQuoted.sender.id,
        ...sameChatQuoted.sender.name === undefined ? {} : { name: sameChatQuoted.sender.name },
        ...sameChatQuoted.sender.isBot === true ? { isBot: true } : {},
      }
    }
    if (quote.sender === undefined || !quote.sender.id) return
    const isSelf = sameChatQuoted?.sender.self === true
      || (botSelfId !== undefined && botSelfId !== '' && quote.sender.id === botSelfId)
    if (isSelf) return
    this.enrichUserRefSync(botId, quote.sender)
  }

  private backfillChatHistory(chatKey: ImChatKey, beforeSeq?: number, botSelfId?: string): void {
    const recent = this.im.history.before(chatKey, beforeSeq ?? Number.MAX_SAFE_INTEGER, BACKFILL_HISTORY_LIMIT)
    for (const item of recent) {
      this.enrichMessageSync(item, botSelfId)
    }
  }

  /**
   * Batch-sync one chat's member roster via `ctx.im.members` (single-flight per chat, cooldown-gated, bounded by
   * `maxMemberPages` and `timeoutMs`).
   */
  private syncChatRoster(chatKey: ImChatKey, timeoutMs: number): Promise<boolean> {
    if (this.im.members === undefined || this.disposed) return Promise.resolve(false)
    const now = this.now()
    if ((this.chatRosterCooldownUntil.get(chatKey) ?? 0) > now) return Promise.resolve(false)
    const inflight = this.inflightRosters.get(chatKey)
    if (inflight !== undefined) return inflight

    const task = this.runChatRosterSync(chatKey, timeoutMs).finally(() => {
      if (this.inflightRosters.get(chatKey) === task) this.inflightRosters.delete(chatKey)
    })
    this.inflightRosters.set(chatKey, task)
    return task
  }

  private async runChatRosterSync(chatKey: ImChatKey, timeoutMs: number): Promise<boolean> {
    const membersFn = this.im.members
    if (membersFn === undefined) return false
    const botId = splitKey(chatKey).bot
    if (!botId) return false

    const controller = new AbortController()
    const batch: { key: string; entry: StoredUserName }[] = []
    let learnedAny = false

    const fetchAll = async (): Promise<void> => {
      let cursor: string | undefined
      for (let pageIndex = 0; pageIndex < this.config.maxMemberPages; pageIndex++) {
        if (controller.signal.aborted || this.disposed) break
        const page = await membersFn(chatKey, cursor, MEMBERS_PAGE_SIZE, controller.signal)
        const timestamp = this.now()
        for (const member of page.data) {
          const id = member.id?.trim()
          if (!id || !isUsableName(member.name, id)) continue
          const clean = stripIdSuffix(member.name!, id)
          if (!clean || clean === id) continue
          const key = userCacheKey(botId, id)
          this.userNegativeUntil.delete(key)
          const existing = this.cache.get(key)
          const refreshThreshold = Math.max(60_000, Math.floor(this.config.ttlMs / 2))
          if (existing !== undefined && existing.name === clean && timestamp - existing.updatedAt < refreshThreshold) {
            this.cache.delete(key)
            this.cache.set(key, existing)
            continue
          }
          const entry: StoredUserName = { name: clean, source: 'member', updatedAt: timestamp }
          this.cache.delete(key)
          this.cache.set(key, entry)
          batch.push({ key, entry })
          learnedAny = true
        }
        if (page.next === undefined || page.next === '') break
        cursor = page.next
      }
    }

    try {
      await raceTimeout(fetchAll(), timeoutMs, () => { controller.abort() })
    } catch (error: unknown) {
      this.logger.warn('im-user-names: roster sync for %s incomplete: %s', chatKey, String(error))
    } finally {
      this.chatRosterCooldownUntil.set(chatKey, this.now() + this.config.chatSyncCooldownMs)
    }

    if (batch.length > 0) {
      const evicted = this.collectOverflowKeys()
      this.queueWrite(async (domain) => {
        const table = domain.table('users')
        for (const item of batch) await table.put(item.key, item.entry)
        if (evicted.length > 0) await table.deleteMany(evicted)
      })
    }

    if (learnedAny) {
      const botSelfId = this.botOf(chatKey)?.selfId
      this.backfilledChats.add(chatKey)
      this.backfillChatHistory(chatKey, undefined, botSelfId)
    }

    return learnedAny
  }

  /**
   * Optional single-user contact lookup fallback (`bot.internal.contact.user.get`), single-flight per user and
   * circuit-broken per bot if the platform reports missing contact scope.
   */
  private lookupContactUser(botId: string, userId: string, bot: Bot, timeoutMs: number): Promise<string | undefined> {
    const userClient = (bot as unknown as ContactCapableBot).internal?.contact?.user
    if (userClient === undefined || typeof userClient.get !== 'function' || this.disposed) {
      return Promise.resolve(undefined)
    }
    const callGet: ContactUserGet = (id, query) => userClient.get!(id, query)

    const key = userCacheKey(botId, userId)
    const inflight = this.inflightContacts.get(key)
    if (inflight !== undefined) return inflight

    const task = this.runContactLookup(botId, userId, callGet, timeoutMs).finally(() => {
      if (this.inflightContacts.get(key) === task) this.inflightContacts.delete(key)
    })
    this.inflightContacts.set(key, task)
    return task
  }

  private async runContactLookup(
    botId: string,
    userId: string,
    getFn: ContactUserGet,
    timeoutMs: number,
  ): Promise<string | undefined> {
    try {
      const response = await raceTimeout(
        Promise.resolve(getFn(userId, { user_id_type: 'open_id' })),
        timeoutMs,
      )
      const name = extractContactName(response)
      if (name !== undefined && isUsableName(name, userId)) {
        this.remember(botId, userId, name, 'contact')
        return stripIdSuffix(name, userId)
      }
      return undefined
    } catch (error: unknown) {
      if (isPermissionError(error)) {
        const cooldown = this.config.contactForbiddenCooldownMs
        this.contactForbiddenUntil.set(botId, this.now() + cooldown)
        this.logger.warn(
          'im-user-names: contact lookup denied for bot %s (disabling contact fallback for %d min): %s',
          botId,
          Math.round(cooldown / 60_000),
          String(error),
        )
      } else {
        this.logger.debug?.('im-user-names: contact lookup failed for %s|%s: %s', botId, userId, String(error))
      }
      return undefined
    }
  }

  private collectOverflowKeys(): string[] {
    const evicted: string[] = []
    while (this.cache.size > this.config.maxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
      evicted.push(oldest)
    }
    return evicted
  }

  private evictOverflow(): void {
    const evicted = this.collectOverflowKeys()
    if (evicted.length > 0) {
      this.queueWrite(async (domain) => {
        await domain.table('users').deleteMany(evicted)
      })
    }
  }

  private queueWrite(job: (domain: ImUserNamesDomain) => Promise<void>): void {
    const run = this.writes.then(async () => {
      if (this.domain === undefined) return
      try {
        await job(this.domain)
      } catch (error: unknown) {
        this.logger.warn('im-user-names: durable cache write failed: %s', String(error))
      }
    })
    this.writes = run.catch(() => {})
  }
}
