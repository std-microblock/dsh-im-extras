/**
 * `im/streaming-message`: the message a turn streams, open to contributions from other plugins.
 *
 * This renderer owns that message — it decides when it appears, what it says, and when it is withdrawn — but it is not
 * the only thing with something to show in it. A deployment that serves a page per session wants its link in the same
 * message; a deployment with an approval checklist wants its state there. Rather than knowing any of them, the renderer
 * composes every state of the message through one waterfall: a listener returns what it received from `next()` plus
 * anything of its own, and the renderer publishes the result.
 *
 * A listener must call `next()`, and it must keep what `next()` returned: the content it receives is the message the
 * turn would otherwise publish. The waterfall runs for every state of every streamed turn — while it runs, when it
 * settles, and when a stopped or failed turn closes — so a contribution stays in the message throughout, and is written
 * once, not accumulated per state.
 *
 * @module dsh-im-output-summary/events
 */
import type { Child } from '@deepseek-ai/cordis-plugin-im-core'
import type { ImActivity } from '@deepseek-ai/dsh-im'

/** Which state of a turn the message shows. */
export type StreamingPart =
  /** The turn runs: the progress line, the summary or the answer so far, the stop control. */
  | 'progress'
  /** The collapsed process message left behind when a streamed turn pushes its result as a separate message. */
  | 'process'
  /** The settled answer with its footer. */
  | 'settled'
  /** The one line a stopped or failed turn closes with. */
  | 'closing'

/** What one state of a streamed message tells the plugins that add to it. */
export interface ImStreamingMessage {
  /** The turn whose message is being built: its session, its trigger, its segments so far, how it settled. */
  activity: ImActivity
  /** Which state of that turn the message shows. */
  part: StreamingPart
  /**
   * On `settled` / `closing`: `true` when the turn already left a separate collapsed `process`
   * message in the chat, so contributions that belong once per turn are not repeated.
   */
  hasProcessMessage?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The content of the message a turn streams, composed by every plugin that adds to it.
     *
     * @param message - the turn and the state of it the message shows.
     * @param next - the content built so far; call it and keep what it returns.
     * @mode waterfall
     */
    'im/streaming-message'(message: ImStreamingMessage, next: () => Child[]): Child[]
  }
}
