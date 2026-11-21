/**
 * The sticker host: sending a sticker into a chat, collecting a chat picture into the library, and the automatic
 * sticker that follows a finished burst of the bot's own messages.
 *
 * A sticker goes out as an ordinary image (`<img src="file:…" alt="表情 #12 …">`) on every platform — official QQ
 * bots and Lark have no favourites API — and its `alt` names it, so the chat history the agent reads later says which
 * sticker it was. The automatic sticker listens to `im/stored`: every own message of the bot restarts that chat's
 * quiet timer, and when the bot has been quiet for `auto.gapMs` a die decides whether one sticker of `auto.tag`
 * follows. A burst in which the agent already sent a sticker never gets a second one.
 *
 * @module dsh-im-stickers/host
 */
import { pathToFileURL } from 'node:url'
import { h, type Element } from '@deepseek-ai/cordis-plugin-im-core'
import type { ImApi, ImChatKey, ImMessage, ImSendResult, ImSendOptions } from '@deepseek-ai/dsh-im'
import { autoFor, type AutoConfig, type StickersConfig } from './config.ts'
import { admitSource, mediaElements, parseMediaId, type HostResolver } from './collect.ts'
import type { StickerRecord } from './domain.ts'
import type { StickerLibrary } from './library.ts'
import { stickerLabel } from './pick.ts'
import { MessageSegments, segmentWantsSticker, type MessageSegment, type SegmentTimers } from './segments.ts'

/** Prefix of the `alt` text a sticker image carries. */
export const STICKER_ALT_PREFIX = '表情 '

/** Fetches one resource's bytes (im-core's resource fetcher in production). */
export type ResourceFetch = (src: string, signal: AbortSignal) => Promise<{ data: Uint8Array; mime?: string }>

/** What the host needs. */
export interface StickerHostDeps {
  im: Pick<ImApi, 'send' | 'history' | 'chat'>
  library: StickerLibrary
  fetch: () => ResourceFetch | undefined
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; debug(...args: unknown[]): void }
  resolveHost?: HostResolver
  timers?: SegmentTimers
  rnd?: () => number
}

/** Options of one sticker send. */
export interface StickerSendOptions {
  session?: string
  operationId?: string
  quote?: string
  /** The send is the automatic one (logged as such). */
  automatic?: boolean
}

export class StickerHost {
  readonly segments: MessageSegments
  private readonly lastSent = new Map<string, number>()
  /** Chats with a sticker send in flight: the own message stored meanwhile is that sticker. */
  private readonly sending = new Map<string, number>()
  private stopped = false

  constructor(readonly deps: StickerHostDeps, public config: StickersConfig) {
    this.segments = new MessageSegments(
      chat => this.autoOf(chat).gapMs,
      (chat, segment) => { void this.closed(chat, segment) },
      deps.timers,
    )
  }

  /** Stop the automatic sticker timers. */
  stop(): void {
    this.stopped = true
    this.segments.stop()
  }

  // ---------------------------------------------------------------------------------------------------------------
  // sending

  /**
   * The content of one sticker message.
   * @param row - the sticker.
   * @returns an image element naming the sticker in its `alt`.
   */
  contentOf(row: StickerRecord): Element {
    return h('img', { src: pathToFileURL(this.deps.library.filePath(row)).href, alt: `${STICKER_ALT_PREFIX}${stickerLabel(row)}` })
  }

  /**
   * Send one sticker into a chat.
   * @param chat - the chat key.
   * @param row - the sticker.
   * @param options - session attribution, idempotency key and quote.
   * @returns the publication result.
   */
  async send(chat: ImChatKey, row: StickerRecord, options: StickerSendOptions = {}): Promise<ImSendResult> {
    const sendOptions: ImSendOptions = {
      ...options.session === undefined ? {} : { session: options.session as never },
      ...options.operationId === undefined ? {} : { operationId: options.operationId },
      ...options.quote === undefined ? {} : { quote: options.quote as never },
    }
    this.sending.set(chat, (this.sending.get(chat) ?? 0) + 1)
    let result: ImSendResult
    try {
      result = await this.deps.im.send(chat, this.contentOf(row), sendOptions)
    } finally {
      const left = (this.sending.get(chat) ?? 1) - 1
      if (left > 0) this.sending.set(chat, left)
      else this.sending.delete(chat)
    }
    if (result.status === 'confirmed' || result.status === 'partial') {
      this.lastSent.set(chat, row.id)
      await this.deps.library.recordUse(row.id)
      this.deps.logger.debug('sticker #%d sent to %s%s', row.id, chat, options.automatic ? ' (automatic)' : '')
    }
    return result
  }

  /**
   * The sticker sent last into a chat by this process.
   * @param chat - the chat key.
   * @returns its id.
   */
  lastSentIn(chat: string): number | undefined { return this.lastSent.get(chat) }

  // ---------------------------------------------------------------------------------------------------------------
  // collecting

  /**
   * Store a picture posted in a chat as a sticker.
   * @param chat - the chat the picture was posted in.
   * @param id - its media id (`12.1`, `#12.1`, or `12` for the first media element of message 12).
   * @param signal - cancellation.
   * @returns the sticker and whether it is new.
   * @throws Error when the id names no stored image, the source is refused or the download fails.
   */
  async collect(chat: ImChatKey, id: string, signal?: AbortSignal): Promise<{ row: StickerRecord; created: boolean }> {
    const parsed = parseMediaId(id)
    if (parsed === undefined) throw new Error(`"${id}" is not a media id such as 12.1`)
    const [message] = this.deps.im.history.after(chat, parsed.seq - 1, 1)
    if (message === undefined || message.seq !== parsed.seq) throw new Error(`chat ${chat} has no stored message #${parsed.seq}`)
    const element = mediaElements(message.content).find(item => item.index === parsed.index)
    if (element === undefined) throw new Error(`message #${parsed.seq} has no media element #${parsed.index}`)
    if (element.type !== 'img') throw new Error(`#${parsed.seq}.${parsed.index} is a ${element.type}, not an image`)
    const fetch = this.deps.fetch()
    if (fetch === undefined) throw new Error('no resource fetcher is available')
    await admitSource(element.src, this.deps.resolveHost)
    const fetched = await fetch(element.src, signal ?? AbortSignal.timeout(60_000))
    return this.deps.library.add({
      data: fetched.data,
      source: 'chat',
      origin: { chat, message: message.key, seq: message.seq, index: element.index },
      ...element.name === undefined ? {} : { name: element.name },
    })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the automatic sticker

  /**
   * `im/stored` listener: the bot's own messages drive the bursts.
   * @param message - a stored message.
   */
  stored(message: ImMessage): void {
    if (!message.sender.self || this.stopped) return
    const chat = message.chat.key
    if (this.isSticker(message)) {
      this.segments.sticker(chat)
      return
    }
    if (!this.autoOf(chat).enabled && !this.segments.isOpen(chat)) return
    this.segments.message(chat)
  }

  /**
   * Whether an own message is a sticker: an image whose `alt` names a sticker, or an image-only message stored while
   * a sticker send to that chat was in flight.
   * @param message - an own stored message.
   * @returns true for a sticker.
   */
  isSticker(message: ImMessage): boolean {
    const images = mediaElements(message.content).filter(item => item.type === 'img')
    if (images.some(item => item.name?.startsWith(STICKER_ALT_PREFIX) === true)) return true
    if (images.length === 0 || !this.sending.has(message.chat.key)) return false
    return message.text.replace(/\[[^\]]*\]/g, '').trim() === ''
  }

  /**
   * The automatic-sticker settings of one chat.
   * @param chat - the chat key.
   * @returns the effective settings.
   */
  autoOf(chat: string): AutoConfig {
    const info = this.deps.im.chat(chat as ImChatKey)
    const override = this.deps.library.override(chat)
    return autoFor(this.config, {
      chat,
      source: info?.source,
      bot: info?.bot ?? (chat.includes('|') ? chat.slice(0, chat.indexOf('|')) : undefined),
    }, override === undefined ? undefined : {
      ...override.enabled === undefined ? {} : { enabled: override.enabled },
      ...override.percent === undefined ? {} : { percent: override.percent },
    })
  }

  private async closed(chat: string, segment: MessageSegment): Promise<void> {
    if (this.stopped) return
    const auto = this.autoOf(chat)
    const rnd = this.deps.rnd ?? Math.random
    if (!auto.enabled || !segmentWantsSticker(segment, auto.percent, rnd())) return
    const last = this.lastSent.get(chat)
    const row = this.deps.library.pick({
      ...auto.tag ? { tags: [auto.tag] } : {},
      ...last === undefined ? {} : { exclude: [last] },
    }, rnd)
    if (row === undefined) return
    try {
      const result = await this.send(chat as ImChatKey, row, { automatic: true })
      if (result.status !== 'confirmed') this.deps.logger.info('automatic sticker #%d to %s: %s %s', row.id, chat, result.status, result.error ?? '')
    } catch (error) {
      this.deps.logger.warn('automatic sticker #%d to %s failed: %s', row.id, chat, error)
    }
  }
}
