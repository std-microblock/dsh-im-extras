/**
 * Cards inside the streamed answer: ```` ```satori-tsx ```` blocks of the turn's text become interactive cards in the
 * one message the turn publishes, at the place the block stands.
 *
 * The renderer only parses the answer; a card service (`ctx.imCards`, provided by `dsh-im-card` when it is mounted)
 * runs the cards. Without that service a block stays what it is: a fenced code block.
 *
 * @module dsh-im-output-summary/cards
 */
import type { Element, MessageHandle } from '@deepseek-ai/cordis-plugin-im-core'
import type { ImActivity, ImChatKey } from '@deepseek-ai/dsh-im'

/** The fence language that marks a card. */
export const CARD_FENCE = 'satori-tsx'

/** One piece of the answer: markdown, or a card block (complete once its closing fence arrived). */
export type AnswerSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'card'; index: number; source: string; complete: boolean }

/** The cards of one turn, as a card service runs them. */
export interface TurnCards {
  /**
   * The elements that stand for card block `index` now: the card's latest render, a placeholder while it starts, or
   * an error line. A complete block is mounted on its first call.
   */
  render(index: number, source: string, complete: boolean): Element[]
  /** The placeholder the settled message stores in place of card `index`. */
  slot(index: number): Element
  /** Called when a card changed and the message must be republished (while the turn streams). */
  attach(update: () => void): void
  /** Hand the settled message over to the card service, which republishes it on every later card change. */
  adopt(handle: MessageHandle, slotted: Element<'message'>): Promise<void>
  /** Number of card blocks that were mounted. */
  readonly count: number
  /** Resolves once every card block started so far has mounted or failed. */
  settle(): Promise<void>
  /** End the turn's binding (cards stay alive in their message). */
  dispose(): void
}

/** The card service the renderer consumes (`ctx.imCards`). */
export interface TurnCardService {
  /**
   * Open the cards of one turn.
   * @param activity - the turn.
   * @param chat - the chat the turn publishes into.
   */
  turn(activity: ImActivity, chat: ImChatKey): TurnCards
}

/**
 * Split an answer into markdown and card blocks. An unclosed ```` ```satori-tsx ```` block at the end is a card that is
 * still being written.
 * @param answer - the answer text.
 * @returns the segments in order; markdown segments are never empty.
 */
export function segmentsOf(answer: string): AnswerSegment[] {
  const out: AnswerSegment[] = []
  const open = new RegExp(`^([ \\t]{0,3})(\`{3,})${CARD_FENCE}[ \\t]*$`, 'm')
  let rest = answer
  let index = 0
  for (;;) {
    const start = open.exec(rest)
    if (start === null) break
    const before = rest.slice(0, start.index)
    if (before.trim()) out.push({ kind: 'markdown', text: before })
    const fence = start[2]!
    const bodyStart = start.index + start[0].length + 1
    const close = new RegExp(`^[ \\t]{0,3}${fence}\`*[ \\t]*$`, 'm')
    const tail = rest.slice(bodyStart)
    const end = close.exec(tail)
    if (end === null) {
      out.push({ kind: 'card', index: index++, source: tail, complete: false })
      rest = ''
      break
    }
    out.push({ kind: 'card', index: index++, source: tail.slice(0, end.index), complete: true })
    rest = tail.slice(end.index + end[0].length)
  }
  if (rest.trim()) out.push({ kind: 'markdown', text: rest })
  return out
}
