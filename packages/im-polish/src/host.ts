/**
 * The polish host: the `im/before-send` listener body, the polish log, and the per-chat switches.
 *
 * Two things happen to one outgoing text, in this order:
 *
 * 1. **The length guard** (`limits.maxTextChars`). A message the platform draws as a single plain text bubble may not
 *    be longer than the ceiling; one that is gets dropped with a reason the agent can act on (write it as markdown, or
 *    render it with typst and send the picture). The guard is independent of the polish switch — it is a rule about
 *    what the chat receives, not about how it is worded — and it never touches a message that really is markdown, an
 *    image, a card or a file.
 * 2. **The polish**, for the messages that are eligible (see {@link PolishHost.beforeSend}). A rewrite that grows past
 *    the same ceiling is not used: the draft goes out.
 *
 * One chat's sends are decided one at a time, so the second of two quick messages is compared with the first even
 * before the first was stored. Every decision is recorded (original, result, drop and reason) in the `im_polish`
 * domain for the panel, bounded by `maxRecords`.
 *
 * @module dsh-im-polish/host
 */
import type { ImApi, ImChatKey, ImMessage, ImOutgoing } from '@deepseek-ai/dsh-im'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { resolveChat, type PolishConfig, type ResolvedChatConfig, type RuleSubject } from './config.ts'
import { textContent } from './content.ts'
import { imPolishDomain, type ChatOverride, type ImPolishDomain, type PolishRecord } from './domain.ts'
import type { Complete } from './llm.ts'
import { tooLongMessage, usesMarkdown } from './markdown.ts'
import { decide, type PolishOutcome } from './polisher.ts'

/** What the host needs from its surroundings; the service passes the live services, a test passes stubs. */
export interface PolishHostDeps {
  im: Pick<ImApi, 'history' | 'format' | 'sessions' | 'chat'>
  storage: Pick<DomainFacility, 'open'>
  /** The model call; absent when no `llm` service is mounted. */
  complete: () => Complete | undefined
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; debug(...args: unknown[]): void }
  /** Called after each recorded decision (panel live update). */
  onRecord?: (record: PolishRecord) => void
  now?: () => number
  rnd?: () => number
}

/** Filter of {@link PolishHost.records}. */
export interface PolishRecordFilter {
  chat?: string
  action?: PolishRecord['action']
  /** Only records older than this id (paging). */
  before?: string
  /** Free text searched in the original and the result. */
  query?: string
  limit?: number
}

/** Counts of the polish log. */
export interface PolishStats {
  total: number
  rewritten: number
  kept: number
  dropped: number
  /** Kept reasons and how often each occurred. */
  reasons: Record<string, number>
}

/** Messages the bot sent recently but the store may not have yet, per chat. */
interface PendingSent { text: string; at: number }

let sequence = 0

export class PolishHost {
  private domain: ImPolishDomain | undefined
  private readonly ids: string[] = []
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly pending = new Map<string, PendingSent[]>()
  private readonly now: () => number

  constructor(readonly deps: PolishHostDeps, public config: PolishConfig) {
    this.now = deps.now ?? Date.now
  }

  /** Open the domain and load the record index. */
  async open(): Promise<void> {
    const domain = await this.deps.storage.open(imPolishDomain)
    this.domain = domain
    this.ids.push(...[...domain.table('records').keys()].sort())
  }

  /** Wait for the decisions in flight and close the domain. */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.chains.values()])
    const domain = this.domain
    this.domain = undefined
    await domain?.close()
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the send listener

  /**
   * Polish one outgoing publication in place: replace `content`, or set `drop`.
   *
   * The length guard runs first and independently of the polish switch: a message the platform draws as one plain
   * text bubble may not exceed `limits.maxTextChars`, whether or not this chat gets its wording rewritten. A message
   * that is really markdown (or an image, a card, a file — `textContent` refuses those) is not measured: a document
   * is allowed to be long, a chat bubble is not.
   * @param outgoing - the draft of `im/before-send`.
   */
  async beforeSend(outgoing: ImOutgoing): Promise<void> {
    if (outgoing.drop !== undefined) return
    const text = textContent(outgoing.content)
    if (text === undefined) return
    const subject = this.subjectOf(outgoing.chat, outgoing.options.session)
    const draft = text.text.trim()
    const { limits } = this.config
    const plain = (value: string): boolean => !text.markdown || !usesMarkdown(value)
    const tooLong = (value: string): boolean => plain(value) && charCount(value) > limits.maxTextChars
    if (tooLong(draft)) {
      const message = tooLongMessage(charCount(draft), limits.maxTextChars)
      outgoing.drop = message
      this.deps.logger.info('IM polish dropped a %d-character text bubble in %s (limit %d)',
        charCount(draft), outgoing.chat, limits.maxTextChars)
      await this.record(outgoing.chat, subject, outgoing.options.session, draft, {
        action: 'dropped', text: draft, reason: 'too-long', dropMessage: message, subs: [], attempts: [],
      }, this.now())
      return
    }
    const chatConfig = this.resolve(subject)
    if (!chatConfig.enabled) return
    if (charCount(draft) < limits.minChars) return
    if (draft.length > limits.maxInputChars || draft.split('\n').length > limits.maxLines) return
    // Code and tables are content: their wording is not the bot's voice.
    if (/```|^\s*\|.*\|\s*$/m.test(draft)) return
    await this.serial(outgoing.chat, async () => {
      const started = this.now()
      let outcome = await this.decideFor(outgoing.chat, draft, text.markdown, chatConfig, outgoing.options.session)
      // A rewrite may not turn a short bubble into a wall of text: the draft kept the ceiling, so it goes out instead.
      if (outcome.action === 'rewritten' && tooLong(outcome.text)) {
        outcome = { ...outcome, action: 'kept', text: draft, reason: 'rewrite-too-long' }
      }
      if (outcome.action === 'dropped') outgoing.drop = outcome.dropMessage ?? 'repeat'
      else {
        if (outcome.action === 'rewritten') outgoing.content = text.rebuild(outcome.text)
        this.remember(outgoing.chat, outcome.text)
      }
      await this.record(outgoing.chat, subject, outgoing.options.session, draft, outcome, started)
    })
  }

  /**
   * What the polish would do with one text in one chat, without sending or recording anything (panel preview).
   * @param chat - the chat key.
   * @param draft - the text.
   * @param session - optional sending session (route and rule matching).
   * @returns the decision.
   */
  async preview(chat: ImChatKey, draft: string, session?: string): Promise<PolishOutcome> {
    const subject = this.subjectOf(chat, session)
    return this.decideFor(chat, draft.trim(), false, this.resolve(subject), session)
  }

  private async decideFor(
    chat: ImChatKey, draft: string, markdown: boolean, chatConfig: ResolvedChatConfig, session: string | undefined,
  ): Promise<PolishOutcome> {
    const { transcript, botRecent } = await this.contextOf(chat)
    const route = this.routeOf(session)
    const complete = this.deps.complete()
    return decide({
      draft, markdown, transcript, botRecent, style: chatConfig.style, note: chatConfig.note,
      route: complete === undefined ? undefined : route,
    }, this.config, complete ?? (() => Promise.reject(new Error('no llm service'))), this.deps.rnd)
  }

  /** The recent chat as transcript lines, and the bot's own recent messages. */
  async contextOf(chat: ImChatKey): Promise<{ transcript: string; botRecent: string[] }> {
    const { context, repeat } = this.config
    const history = this.deps.im.history
    const latest = history.latest(chat)
    const end = latest === undefined ? 0 : latest.seq + 1
    const recent = latest === undefined || context.messages === 0 ? [] : history.before(chat, end, context.messages)
    let transcript = ''
    if (recent.length > 0) {
      const blocks = await this.deps.im.format(recent, { style: 'line' })
      transcript = blocks.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
        .split('\n').map(line => clip(line, context.maxChars)).join('\n')
    }
    const since = this.now() - repeat.windowMs
    const own = latest === undefined || context.botMessages === 0
      ? []
      : history.before(chat, end, context.botMessages, (message: ImMessage) => message.sender.self && message.time >= since)
    const texts = own.map(message => message.text.trim()).filter(Boolean)
    for (const sent of this.pending.get(chat) ?? []) {
      if (sent.at >= since && !texts.includes(sent.text)) texts.push(sent.text)
    }
    return { transcript, botRecent: texts.slice(-Math.max(context.botMessages, 1)).map(text => clip(text, context.maxChars)) }
  }

  /** The route of the rewrite: the configured one, else the sending session's own. */
  routeOf(session: string | undefined): { provider: string; model: string } | undefined {
    const { provider, model } = this.config.model
    if (provider && model) return { provider, model }
    if (session === undefined) return undefined
    const record = this.deps.im.sessions.of(session as never)
    return record === undefined ? undefined : { provider: record.composition.provider, model: record.composition.model }
  }

  /** The chat and sending session, as the rules see them. */
  subjectOf(chat: ImChatKey, session: string | undefined): RuleSubject {
    const info = this.deps.im.chat(chat)
    const record = session === undefined ? undefined : this.deps.im.sessions.of(session as never)
    return {
      chat,
      source: info?.source,
      bot: info?.bot ?? (chat.includes('|') ? chat.slice(0, chat.indexOf('|')) : undefined),
      preset: record?.composition.agentPreset,
      owner: record?.owner,
    }
  }

  /** The effective configuration of one send. */
  resolve(subject: RuleSubject): ResolvedChatConfig {
    return resolveChat(this.config, subject, this.domain?.table('chats').get(subject.chat))
  }

  private remember(chat: string, text: string): void {
    const since = this.now() - this.config.repeat.windowMs
    const list = (this.pending.get(chat) ?? []).filter(sent => sent.at >= since)
    list.push({ text, at: this.now() })
    this.pending.set(chat, list.slice(-Math.max(1, this.config.context.botMessages)))
  }

  private serial<T>(chat: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(chat) ?? Promise.resolve()
    const next = previous.then(run, run)
    const tail = next.catch(() => {})
    this.chains.set(chat, tail)
    void tail.then(() => { if (this.chains.get(chat) === tail) this.chains.delete(chat) })
    return next
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the log

  private async record(
    chat: string, subject: RuleSubject, session: string | undefined, original: string, outcome: PolishOutcome, started: number,
  ): Promise<void> {
    const at = this.now()
    const id = `${at.toString(36).padStart(9, '0')}-${(sequence++ % 1296).toString(36).padStart(2, '0')}`
    const route = this.routeOf(session)
    const record: PolishRecord = {
      id, at, chat,
      ...subject.source === undefined ? {} : { source: subject.source },
      ...session === undefined ? {} : { session },
      action: outcome.action,
      original,
      result: outcome.text,
      ...outcome.reason === undefined ? {} : { reason: outcome.reason },
      ...outcome.dropMessage === undefined ? {} : { dropMessage: outcome.dropMessage },
      subs: outcome.subs,
      ...outcome.similar === undefined ? {} : { similarity: round(outcome.similar.score), similarTo: outcome.similar.text },
      attempts: outcome.attempts,
      ...route === undefined ? {} : { model: `${route.provider}/${route.model}` },
      durationMs: at - started,
    }
    const level = outcome.action === 'dropped' ? 'info' : 'debug'
    this.deps.logger[level]('IM polish %s in %s (%s): %s', outcome.action, chat, outcome.reason ?? '-',
      JSON.stringify(outcome.text.slice(0, 80)))
    const domain = this.domain
    if (domain === undefined) return
    try {
      await domain.table('records').put(id, record)
      this.ids.push(id)
      while (this.ids.length > this.config.maxRecords) {
        const oldest = this.ids.shift()
        if (oldest !== undefined) await domain.table('records').delete(oldest)
      }
    } catch (error) {
      this.deps.logger.warn('IM polish could not record a decision: %s', error)
    }
    this.deps.onRecord?.(record)
  }

  /**
   * Recorded decisions, newest first.
   * @param filter - chat, action, free text and paging.
   * @returns the matching records.
   */
  records(filter: PolishRecordFilter = {}): PolishRecord[] {
    const table = this.domain?.table('records')
    if (table === undefined) return []
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 500))
    const query = filter.query?.trim().toLowerCase()
    const out: PolishRecord[] = []
    for (let i = this.ids.length - 1; i >= 0 && out.length < limit; i--) {
      const id = this.ids[i]!
      if (filter.before !== undefined && id >= filter.before) continue
      const record = table.get(id)
      if (record === undefined) continue
      if (filter.chat !== undefined && record.chat !== filter.chat) continue
      if (filter.action !== undefined && record.action !== filter.action) continue
      if (query && !`${record.original}\n${record.result}`.toLowerCase().includes(query)) continue
      out.push(record)
    }
    return out
  }

  /**
   * One recorded decision.
   * @param id - its id.
   * @returns the record, when kept.
   */
  get(id: string): PolishRecord | undefined {
    return this.domain?.table('records').get(id)
  }

  /**
   * Counts of the log, optionally for one chat and a time window.
   * @param filter - chat and the earliest decision time.
   * @returns totals per action and per reason.
   */
  stats(filter: { chat?: string; since?: number } = {}): PolishStats {
    const stats: PolishStats = { total: 0, rewritten: 0, kept: 0, dropped: 0, reasons: {} }
    const table = this.domain?.table('records')
    if (table === undefined) return stats
    for (const [, record] of table.entries()) {
      if (filter.chat !== undefined && record.chat !== filter.chat) continue
      if (filter.since !== undefined && record.at < filter.since) continue
      stats.total++
      stats[record.action]++
      if (record.reason !== undefined) {
        const reason = record.reason.split(' ')[0]!
        stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1
      }
    }
    return stats
  }

  /**
   * Delete records (all of them, or one chat's).
   * @param filter - the chat whose records go; absent clears the log.
   * @returns how many were deleted.
   */
  async clear(filter: { chat?: string } = {}): Promise<number> {
    const domain = this.domain
    if (domain === undefined) return 0
    let removed = 0
    for (const id of [...this.ids]) {
      const record = domain.table('records').get(id)
      if (filter.chat !== undefined && record?.chat !== filter.chat) continue
      await domain.table('records').delete(id)
      this.ids.splice(this.ids.indexOf(id), 1)
      removed++
    }
    return removed
  }

  // ---------------------------------------------------------------------------------------------------------------
  // per-chat switches

  /** The panel's per-chat switches. */
  overrides(): ChatOverride[] {
    const table = this.domain?.table('chats')
    return table === undefined ? [] : [...table.entries()].map(([, value]) => value)
  }

  /**
   * Switch the polish on or off for one chat, or clear the switch (`enabled: undefined`).
   * @param chat - the chat key.
   * @param enabled - the switch; undefined returns the chat to the configuration.
   * @returns the stored switch, or undefined when it was cleared.
   */
  async setChat(chat: string, enabled: boolean | undefined): Promise<ChatOverride | undefined> {
    const table = this.domain?.table('chats')
    if (table === undefined) throw new Error('The polish store is not open.')
    if (enabled === undefined) {
      await table.delete(chat)
      return undefined
    }
    const value: ChatOverride = { chat, enabled, updatedAt: this.now() }
    await table.put(chat, value)
    return value
  }
}

function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

/** Length in characters as a reader counts them (one emoji is one character, not two UTF-16 units). */
function charCount(text: string): number {
  return Array.from(text).length
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
