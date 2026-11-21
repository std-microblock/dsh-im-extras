/**
 * The bot's message bursts per chat, for the automatic sticker.
 *
 * Every message the bot sends restarts a `gapMs` timer; when the timer finally fires, the burst is over and one die
 * roll decides whether a sticker follows. A burst that already carried a sticker (the agent picked one itself) never
 * gets a second one, and a sticker on its own neither counts as a message nor opens a burst. Only the bot's own sends
 * take part: the chat's traffic is not the bot talking.
 *
 * Timers are injectable so tests can drive bursts without waiting.
 *
 * @module dsh-im-stickers/segments
 */

/** One finished burst. */
export interface MessageSegment {
  /** Messages the bot sent in it. */
  messages: number
  /** A sticker went out in it. */
  sticker: boolean
}

/**
 * Whether a finished burst earns an automatic sticker.
 * @param segment - the burst.
 * @param percent - the chance, 0–100.
 * @param roll - the die, 0 ≤ roll < 1.
 * @returns true when a sticker should follow.
 */
export function segmentWantsSticker(segment: MessageSegment, percent: number, roll: number): boolean {
  if (segment.sticker || segment.messages <= 0) return false
  const chance = Math.min(100, Math.max(0, Number(percent) || 0))
  return roll * 100 < chance
}

/** Timer functions; the defaults are the global ones, unref'd. */
export interface SegmentTimers {
  set(fn: () => void, ms: number): unknown
  clear(timer: unknown): void
}

const defaultTimers: SegmentTimers = {
  set: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  },
  clear: timer => { clearTimeout(timer as ReturnType<typeof setTimeout>) },
}

/** The open bursts of every chat. */
export class MessageSegments {
  private readonly open = new Map<string, { timer: unknown; segment: MessageSegment }>()

  /**
   * @param gapMs - the quiet time of one chat.
   * @param onClose - called with the chat and the finished burst.
   * @param timers - injectable timers.
   */
  constructor(
    private readonly gapMs: (chat: string) => number,
    private readonly onClose: (chat: string, segment: MessageSegment) => void,
    private readonly timers: SegmentTimers = defaultTimers,
  ) {}

  /** The bot sent a message (not a sticker) into a chat. */
  message(chat: string): void {
    const segment = this.open.get(chat)?.segment ?? { messages: 0, sticker: false }
    segment.messages++
    this.arm(chat, segment)
  }

  /** The bot sent a sticker into a chat: marks the open burst, opens none. */
  sticker(chat: string): void {
    const open = this.open.get(chat)
    if (open === undefined) return
    open.segment.sticker = true
    this.arm(chat, open.segment)
  }

  /** Whether a chat has an open burst. */
  isOpen(chat: string): boolean { return this.open.has(chat) }

  /** Drop every pending timer (shutdown). */
  stop(): void {
    for (const { timer } of this.open.values()) this.timers.clear(timer)
    this.open.clear()
  }

  private arm(chat: string, segment: MessageSegment): void {
    const previous = this.open.get(chat)
    if (previous !== undefined) this.timers.clear(previous.timer)
    const timer = this.timers.set(() => {
      if (this.open.get(chat)?.timer !== timer) return
      this.open.delete(chat)
      this.onClose(chat, { messages: segment.messages, sticker: segment.sticker })
    }, this.gapMs(chat))
    this.open.set(chat, { timer, segment })
  }
}
