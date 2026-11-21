/**
 * Automatic human-readable session titling for per-chat routers and background task workers.
 *
 * `dsh-session-title` only generates automatic titles for `source.kind === 'user'` messages, leaving
 * `source.kind === 'im'` sessions untitled (`null`) in the Web GUI. This module synchronizes clear titles onto live
 * and cold persisted IM sessions via `ctx.sessionTitle.rename`, upgrading auto-generated titles as chat names become
 * known while never overwriting custom user-edited titles.
 *
 * @module dsh-im-dispatch/titles
 */

import type {
  DispatchIm, ImHostedRecord, ImTaskLike, LiveSessionLike, Logger, SessionQueryLike, SessionStoreLike,
  SessionTitleServiceLike,
} from './types.ts'
import { DISPATCHER_CHAT_PREFIX, DISPATCHER_KEY, DISPATCHER_TOPIC_PREFIX } from './api.ts'
import { splitKey } from './im.ts'

/** Known metadata about one admitted chat used for formatting session titles. */
export interface ChatTitleInfo {
  name?: string
  type?: string
}

/** Minimum host surface needed by {@link SessionTitleSynchronizer}. */
export interface TitleSyncHost {
  whenReady(): Promise<void>
  desiredSessionTitle(sessionId: string, recordOverride?: { key: string }): string | undefined
  sessionIdsForChat(chatKey: string): string[]
}

export interface SessionTitleSynchronizerOptions {
  host: TitleSyncHost
  im: DispatchIm
  sessions: () => SessionStoreLike | undefined
  sessionTitle: () => SessionTitleServiceLike | undefined
  sessionQuery: () => SessionQueryLike | undefined
  logger: Logger
}

const AUTO_TITLE_RE = /^(\[(?:群路由|私聊|话题路由|全局路由[^\]]*)\]\s|#\d+\s)/u

/** Shorten long opaque platform chat/thread identifiers for display (`chat_0a1b2c…9f8e`). */
export function shortPlatformId(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 9)}…${id.slice(-4)}`
}

/** Collapse whitespace and truncate cleanly at code-point boundaries. */
export function cleanTitleText(raw: string, maxCodePoints = 80): string {
  const collapsed = raw.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return ''
  const chars = Array.from(collapsed)
  if (chars.length <= maxCodePoints) return collapsed
  if (maxCodePoints <= 1) return chars.slice(0, maxCodePoints).join('')
  return `${chars.slice(0, maxCodePoints - 1).join('').trimEnd()}…`
}

/** Derive the display title for a dispatch router session from its key and known chat info. */
export function formatRouterSessionTitle(
  key: string,
  getChatInfo: (chatKey: string) => ChatTitleInfo | undefined,
): string | undefined {
  if (key === DISPATCHER_KEY) return '[全局路由 · 旧]'
  if (key.startsWith(DISPATCHER_CHAT_PREFIX)) {
    const chatKey = key.slice(DISPATCHER_CHAT_PREFIX.length)
    const info = getChatInfo(chatKey)
    const label = cleanTitleText(info?.name ?? '', 40) || shortPlatformId(splitKey(chatKey).id)
    if (info?.type === 'direct' || info?.type === 'private') return `[私聊] ${label}`
    return `[群路由] ${label}`
  }
  if (key.startsWith(DISPATCHER_TOPIC_PREFIX)) {
    const body = key.slice(DISPATCHER_TOPIC_PREFIX.length)
    const sep = body.lastIndexOf(':')
    if (sep <= 0) return undefined
    const chatKey = body.slice(0, sep)
    const threadId = body.slice(sep + 1)
    const info = getChatInfo(chatKey)
    const label = cleanTitleText(info?.name ?? '', 36) || shortPlatformId(splitKey(chatKey).id)
    return `[话题路由] ${label} · #${shortPlatformId(threadId)}`
  }
  return undefined
}

/** Derive the display title for a task worker session from its task number, title, and home chat name. */
export function formatTaskSessionTitle(
  task: ImTaskLike,
  getChatInfo?: (chatKey: string) => ChatTitleInfo | undefined,
): string {
  const titleText = cleanTitleText(task.title, 56) || '未命名任务'
  const base = `#${task.id} ${titleText}`
  const chatName = cleanTitleText(getChatInfo?.(task.chat)?.name ?? '', 24)
  return chatName ? `${base} · ${chatName}` : base
}

/**
 * Decide whether an automatic title should be written over `currentTitle`.
 * Always permits naming untitled sessions and upgrading previously auto-formatted titles,
 * while preserving any custom title edited manually by an operator.
 */
export function shouldApplyAutoTitle(
  currentTitle: string | undefined,
  desired: string,
  lastAuto: string | undefined,
): boolean {
  if (currentTitle === undefined) return true
  if (currentTitle === desired) return false
  return currentTitle === lastAuto || AUTO_TITLE_RE.test(currentTitle)
}

function readObservedTitle(events: readonly { readonly type: string; readonly data?: unknown }[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'session/title') continue
    const data = event.data
    if (data !== null && typeof data === 'object' && typeof (data as { title?: unknown }).title === 'string') {
      return (data as { title: string }).title
    }
  }
  return undefined
}

/** Keeps live and persisted IM router/worker session logs titled via `ctx.sessionTitle.rename`. */
export class SessionTitleSynchronizer {
  private readonly deps: SessionTitleSynchronizerOptions
  private readonly autoTitles = new Map<string, string>()
  private readonly lastDesired = new Map<string, string>()
  private readonly chains = new Map<string, Promise<boolean>>()
  private disposed = false

  constructor(deps: SessionTitleSynchronizerOptions) {
    this.deps = deps
  }

  dispose(): void {
    this.disposed = true
  }

  /** Schedule title synchronization after the synchronous `session/created` read-only boundary unwinds. */
  onSessionCreated(session: LiveSessionLike): void {
    if (this.disposed) return
    const sessionId = session.id
    queueMicrotask(() => {
      if (this.disposed) return
      if (this.deps.sessions()?.get(sessionId) !== session) return
      void this.syncSession(sessionId)
    })
  }

  /** Apply or refresh the automatic title on a currently live session. */
  syncSession(sessionId: string, recordOverride?: { key: string }): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    const prev = this.chains.get(sessionId) ?? Promise.resolve(false)
    const run = prev.catch(() => false).then(() => this.syncSessionNow(sessionId, recordOverride))
    this.chains.set(sessionId, run)
    void run.finally(() => {
      if (this.chains.get(sessionId) === run) this.chains.delete(sessionId)
    })
    return run
  }

  private async syncSessionNow(sessionId: string, recordOverride?: { key: string }): Promise<boolean> {
    if (this.disposed) return false
    const desired = this.deps.host.desiredSessionTitle(sessionId, recordOverride)
    if (desired === undefined) return false

    const store = this.deps.sessions()
    const titles = this.deps.sessionTitle()
    const live = store?.get(sessionId)
    if (store === undefined || titles === undefined || live === undefined) return false

    try {
      const current = titles.get(live)?.title
      if (current !== undefined && current === this.autoTitles.get(sessionId) && this.lastDesired.get(sessionId) === desired) {
        return false
      }
      if (!shouldApplyAutoTitle(current, desired, this.autoTitles.get(sessionId))) {
        if (current === desired) {
          this.autoTitles.set(sessionId, desired)
          this.lastDesired.set(sessionId, desired)
        }
        return false
      }
      const accepted = titles.rename(live, desired)
      this.autoTitles.set(sessionId, accepted.title)
      this.lastDesired.set(sessionId, desired)
      await store.flush?.(live)
      return true
    } catch (error: unknown) {
      this.deps.logger.warn('im-dispatch: failed to auto-rename session %s: %s', sessionId, String(error))
      return false
    }
  }

  /** Re-sync titles for every router and task associated with `chatKey` (live or cold). */
  async syncChat(chatKey: string): Promise<void> {
    if (this.disposed) return
    const sessionIds = this.deps.host.sessionIdsForChat(chatKey)
    for (const sessionId of sessionIds) {
      if (this.disposed) return
      const store = this.deps.sessions()
      if (store?.get(sessionId) !== undefined) {
        await this.syncSession(sessionId)
        continue
      }
      await this.syncColdSessionIfPersisted(sessionId)
    }
  }

  /** Cold-safe startup backfill for existing persisted router/worker sessions lacking a title. */
  async backfill(): Promise<void> {
    try {
      await this.deps.host.whenReady()
      if (this.disposed) return
      const store = this.deps.sessions()
      const titles = this.deps.sessionTitle()
      if (store === undefined || titles === undefined) return

      const records = this.deps.im.sessions.list?.() ?? []
      for (const record of records) {
        if (this.disposed) return
        const desired = this.deps.host.desiredSessionTitle(record.sessionId, record)
        if (desired === undefined) continue
        if (store.get(record.sessionId) !== undefined) {
          await this.syncSession(record.sessionId, record)
          continue
        }
        await this.syncColdSessionIfPersisted(record.sessionId, record, desired)
      }
    } catch (error: unknown) {
      this.deps.logger.warn('im-dispatch: session title backfill encountered an error: %s', String(error))
    }
  }

  private async syncColdSessionIfPersisted(
    sessionId: string,
    recordOverride?: ImHostedRecord,
    precomputedDesired?: string,
  ): Promise<boolean> {
    if (this.disposed) return false
    const desired = precomputedDesired ?? this.deps.host.desiredSessionTitle(sessionId, recordOverride)
    if (desired === undefined) return false

    const query = this.deps.sessionQuery()
    const imSessions = this.deps.im.sessions
    if (query === undefined || imSessions.agent === undefined) return false

    let existingTitle: string | undefined
    let existsOnDisk = false
    try {
      const obs = await query.observeSession(sessionId)
      try {
        existsOnDisk = true
        existingTitle = readObservedTitle(obs.events)
      } finally {
        obs[Symbol.dispose]()
      }
    } catch {
      existsOnDisk = false
    }
    if (!existsOnDisk || this.disposed) return false
    if (!shouldApplyAutoTitle(existingTitle, desired, this.autoTitles.get(sessionId))) {
      if (existingTitle === desired) {
        this.autoTitles.set(sessionId, desired)
        this.lastDesired.set(sessionId, desired)
      }
      return false
    }

    try {
      const agent = await imSessions.agent(sessionId)
      if (this.disposed) return false
      return await this.syncSession(agent.session.id, recordOverride)
    } catch (error: unknown) {
      this.deps.logger.warn('im-dispatch: failed cold title sync for session %s: %s', sessionId, String(error))
      return false
    }
  }
}
