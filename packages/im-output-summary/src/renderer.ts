/**
 * The summary output renderer: streams a progress message while a turn runs, collapses it to any contributed process
 * panel when finished, and sends the final answer as a separate message.
 *
 * While the turn runs the message shows a small progress line (thinking / the tool being called) followed by the
 * latest model-written progress summary — or, before the first summary, the answer so far — plus a stop control. At the
 * end, when a live streamed card was published and a contributing plugin supplies `process` content (such as the
 * session page link), that card collapses in place to the `process` content and the settled answer (with its footer) or
 * error goes out as a fresh message so the chat notifies natively and shows the result in the conversation preview.
 * Cancelled turns with no answer settle in place on the process card instead; turns that never opened a streamed card
 * (`firstOutput: first-tool` with no tool calls) send one result message directly. Everything is derived from the
 * platform-neutral vocabulary — the renderer never names a platform:
 *
 * - The stream's own strategy decides how much may be published before the end. A stream that rewrites what it already
 *   shows (`patch` / `edit`) carries a *provisional* status line, the progress summaries, and the stop control;
 *   an append-only or final-only stream omits them, because an appended suffix cannot be taken back and a final-only
 *   stream must not publish anything before the end.
 * - The message appears at the turn's first tool call when `config.firstOutput` is `first-tool`, so a turn that only
 *   answers arrives as the single message the person reads; `immediate` publishes the progress line from the start.
 * - `no_output` silences a turn: what it published is withdrawn and nothing further goes out, so a card-only turn
 *   leaves the chat untouched.
 * - Every state of the message is composed through the `im/streaming-message` waterfall, which is where another plugin
 *   adds what only it knows — the deployment's page link for the session, for one.
 * - The stop control is a `<fallback>`: an action button where the mode renders one, and a `reply /stop` line
 *   everywhere else, so the turn always offers a way out and never sends dead button glyphs.
 * - A turn that produced nothing to show (and no contributed `process` panel to keep) is recalled; when the platform
 *   refuses the deletion, its last published state stays and the turn is logged.
 * - `config.maxChars` bounds the answer with a truncation note.
 *
 * The stream scheduler of the core coalesces these updates, so `update()` may be called for every delta.
 */
import type { Child, Element, MessageHandle, MessageStream, StreamStrategy } from '@deepseek-ai/cordis-plugin-im-core'
import { h } from '@deepseek-ai/cordis-plugin-im-core'
import type {
  ImActivity, ImActivityChange, ImOutputIO, ImOutputRenderer, ImTurnOutput,
} from '@deepseek-ai/dsh-im'
// The entry re-exports only types, so the stop-button id prefix comes from the package's published `./src/*` subpath.
import { STOP_BUTTON_PREFIX } from '@deepseek-ai/dsh-im/src/outputs.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SummaryConfig } from './config.ts'
import type { ImStreamingMessage, StreamingPart } from './events.ts'
import { stringsOf } from './locale.ts'
import type { ProgressSource } from './progress.ts'
import type { TurnCardService } from './cards.ts'
import { NO_OUTPUT_TOOL } from './tools.ts'
import {
  answerOf, AUTH_STOP_BUTTON_PREFIX, boundedAnswer, closingContent, finalContent, footerLine, runningContent,
  slottedContent, type SummaryPlan,
} from './view.ts'

/** `spec.output` value that selects this renderer. */
export const SUMMARY_RENDERER_ID = 'summary'

/**
 * How a message is composed with other plugins' contributions: `ctx.waterfall('im/streaming-message', …)`. A function
 * rather than the context, so a test drives the renderer without one.
 */
export type MessageComposer = (message: ImStreamingMessage, next: () => Child[]) => Child[]

/** The bit of a logger this renderer uses: one line per turn, so an operator can see what a card was allowed to show. */
export interface SummaryLog {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

/** The click this renderer reads: the stop control of one of its own messages. */
export interface StopClick {
  /** `dsh:stop:<sessionId>`, as the stop control carries it. */
  id: string
  /** Who clicked it. */
  user: { id: string; name?: string }
}

/** Registers itself as {@link SUMMARY_RENDERER_ID} and renders every turn that selects it. */
export class SummaryRenderer implements ImOutputRenderer {
  readonly id = SUMMARY_RENDERER_ID

  /**
   * This renderer publishes a session's turns as one streamed message, and takes other plugins' contributions to it
   * through `im/streaming-message`. A deployment that would otherwise post a message per turn — the page link of
   * `dsh-toc-agent-plugin`, for one — reads this and contributes instead of publishing beside it.
   */
  readonly streamsMessage = true

  /** The turn this renderer publishes for each session, newest last: what `no_output` and the stop control reach. */
  private readonly turns = new Map<SessionId, SummaryTurn>()

  /**
   * @param config - resolved operator configuration.
   * @param progress - progress-summary feed; without it (or with `config.progress` off) no summary is shown.
   * @param logger - optional diagnostic sink for the per-turn rendering plan.
   * @param cards - looked up per turn: the card service may mount after this renderer.
   * @param compose - the contribution waterfall; without it the message is only what this renderer builds.
   */
  constructor(
    readonly config: SummaryConfig,
    readonly progress?: ProgressSource,
    readonly logger?: SummaryLog,
    readonly cards?: () => TurnCardService | undefined,
    readonly compose?: MessageComposer,
    readonly hasAuth?: () => boolean,
  ) {}

  begin(activity: ImActivity, io: ImOutputIO): ImTurnOutput {
    const sessionId = activity.session.sessionId
    const turn = new SummaryTurn(activity, io, this.config, () => {
      if (this.turns.get(sessionId) === turn) this.turns.delete(sessionId)
    }, this.config.progress ? this.progress : undefined, this.logger, this.cards?.(), this.compose, this.hasAuth)
    this.turns.set(sessionId, turn)
    return turn
  }

  /**
   * Silence the turn this renderer is publishing for one session.
   * @param sessionId - the hosted session.
   * @returns whether a message the turn already published was withdrawn; `false` when nothing was published or no
   *   turn of that session is running here.
   */
  async silence(sessionId: SessionId): Promise<boolean> {
    return await this.turns.get(sessionId)?.silence() ?? false
  }

  /**
   * Record who pressed the stop control of a turn, so its closing footer names them instead of saying only that the
   * turn was stopped. Clicks on other messages and other controls are ignored.
   * @param click - the button click as the IM host reports it.
   */
  stoppedBy(click: StopClick): void {
    const sessionId = click.id.startsWith(AUTH_STOP_BUTTON_PREFIX)
      ? click.id.slice(AUTH_STOP_BUTTON_PREFIX.length)
      : click.id.startsWith(STOP_BUTTON_PREFIX)
        ? click.id.slice(STOP_BUTTON_PREFIX.length)
        : undefined
    if (sessionId === undefined) return
    this.turns.get(sessionId as SessionId)?.stoppedBy(click.user)
  }
}

/**
 * Whether a stream may carry provisional content: it has to rewrite what the chat already shows.
 * @param strategy - strategy of the opened stream.
 * @returns `true` for `patch` and `edit`.
 */
function rewritesInPlace(strategy: StreamStrategy | undefined): boolean {
  return strategy === 'patch' || strategy === 'edit'
}

/** One turn: the streamed process message it owns, plus the separate settled result when split. */
class SummaryTurn implements ImTurnOutput {
  /** The message stream, opened on the turn's first publication; absent until then. */
  private ready: Promise<MessageStream | undefined> | undefined
  /** The rendering plan; resolved with the stream, because the stream's strategy decides what may be published. */
  private plan: SummaryPlan | undefined
  /** Whether `stream.update()` was actually invoked during this turn (a live progress card went out). */
  private published = false
  private closed = false
  /** `no_output` was called: the turn publishes nothing, from that moment on and at the end. */
  private silent = false
  /** Whether the silencing call withdrew a message this turn had already published. */
  private withdrawn = false
  /** Whoever pressed this turn's stop control, recorded before the turn ends. */
  private stopper: { id: string; name?: string } | undefined
  /** Latest activity, redrawn when a summary arrives between two activity changes. */
  private latest: ImActivity
  /** Latest progress summary of the turn. */
  private summary: string | undefined
  /** Ends the progress watch; absent when the turn shows no summaries. */
  private unwatch: (() => void) | undefined
  /** Last stream state reported in the log, so a frozen card is visible without logging every delta. */
  private lastState: string | undefined
  /** Summary length at the last report: a new summary always logs, unchanged ones do not. */
  private lastSummaryChars = -1

  constructor(
    activity: ImActivity,
    private readonly io: ImOutputIO,
    private readonly config: SummaryConfig,
    /** Drops this turn from the renderer's registry, so a later `no_output` call reaches the next turn. */
    private readonly release: () => void,
    private readonly progress?: ProgressSource,
    private readonly logger?: SummaryLog,
    private readonly cardService?: TurnCardService,
    private readonly compose?: MessageComposer,
    private readonly hasAuth?: () => boolean,
  ) {
    this.latest = activity
    // `immediate` opens the turn's message here, so the chat watches the work from the first second and a turn that
    // produces nothing to show stays recallable; `first-tool` waits for the first tool call (see `showing`).
    this.publish(activity)
  }

  update(activity: ImActivity, _change: ImActivityChange): void {
    if (this.closed) return
    this.latest = activity
    this.publish(activity)
  }

  async end(activity: ImActivity): Promise<void> {
    this.release()
    if (this.closed) return
    this.closed = true
    if (this.silent) {
      // A silenced turn leaves the chat as it found it: nothing is settled, no closing line is posted.
      this.unwatch?.()
      this.plan?.cards?.dispose()
      return
    }
    const stream = this.ready === undefined ? undefined : await this.ready
    // The watch is installed once the stream settles, which may be after this turn ended.
    this.unwatch?.()
    const plan = this.plan ?? this.resolveFinalPlan(activity)
    const cards = plan.cards
    if (cards !== undefined) {
      // A complete card block whose closing fence arrived in the last delta has to be started (and awaited) before the
      // final content is built; otherwise the settled message would keep its loading placeholder.
      finalContent(activity, plan)
      await cards.settle()
    }
    const hasResultOrError = finalContent(activity, plan) !== undefined || activity.status === 'error'
    const hasStreamedCard = this.published && stream !== undefined && plan.editing

    if (hasResultOrError) {
      let processKept = false
      const processChildren = hasStreamedCard ? this.contribute('process', activity, () => []) : []
      if (hasStreamedCard && processChildren.length > 0) {
        processKept = await this.closeStream(stream, h('message', ...processChildren), activity)
      }
      const settled = this.settled(activity, plan, processKept)
      const outgoing = settled ?? this.closing(activity, plan, processKept)
      const settleInStream = stream !== undefined && (!plan.editing || (this.published && processChildren.length === 0))

      if (cards !== undefined && settled !== undefined && cards.count > 0) {
        const slotted = slottedContent(boundedAnswer(activity, plan.maxChars, plan.strings), plan,
          footerLine(activity, plan))
        const result = settleInStream
          ? await this.closeWith(stream, settled, activity)
          : (await this.io.send(settled)).handle
        cards.dispose()
        if (result !== undefined && slotted !== undefined) {
          await cards.adopt(result, h('message',
            ...this.contribute('settled', activity, () => slotted, { hasProcessMessage: processKept })))
        }
        return
      }
      cards?.dispose()
      if (settleInStream) {
        // The full update carries the final answer and drops the stop button; a card whose turn ended must not keep
        // offering one, so a refused edit is retried once before the answer goes out as a plain message.
        if (await this.closeStream(stream, outgoing, activity)) return
      }
      await this.io.send(outgoing)
      return
    }

    cards?.dispose()
    if (activity.status === 'cancelled') {
      const closing = this.closing(activity, plan, false)
      if (stream !== undefined && (this.published || !plan.editing)) {
        if (await this.closeStream(stream, closing, activity)) return
      }
      await this.io.send(closing)
      return
    }

    if (!this.published || stream === undefined) return
    if (plan.editing) {
      const processChildren = this.contribute('process', activity, () => [])
      if (processChildren.length > 0) {
        await this.closeStream(stream, h('message', ...processChildren), activity)
        return
      }
    }
    if (await stream.abort({ recall: true, reason: 'nothing to show' })) return
    this.logger?.warn('IM output summary of session %s published nothing and could not recall its progress message',
      activity.session.sessionId)
    // A stopped or failed turn the chat watched still has to end audibly; a completed one that produced nothing stays
    // as quiet as its progress message was.
    if (activity.status !== 'done') await this.io.send(this.closing(activity, plan))
  }

  /**
   * Publish nothing for the rest of this turn (`no_output`), withdrawing what already went out.
   * @returns whether a message this turn had published was withdrawn from the chat.
   */
  async silence(): Promise<boolean> {
    if (this.silent) return this.withdrawn
    this.silent = true
    // A turn that has not published yet publishes nothing: there is no message to open and none to recall.
    const ready = this.ready
    if (ready === undefined) return false
    const stream = await ready
    if (stream === undefined) return false
    this.withdrawn = await stream.abort({ recall: true, reason: 'no_output' })
    return this.withdrawn
  }

  /**
   * Record who pressed this turn's stop control.
   * @param user - the person who clicked it.
   */
  stoppedBy(user: { id: string; name?: string }): void {
    this.stopper = user
    if (this.plan !== undefined) this.plan.stoppedBy = user
  }

  /**
   * Close the stream with content and report the message that carries it (for card adoption).
   * @param stream - the turn's message stream.
   * @param content - the settled content.
   * @param activity - the settled turn.
   * @returns the handle of the message that shows the content, or `undefined` when nothing was published.
   */
  private async closeWith(
    stream: MessageStream, content: Element<'message'>, activity: ImActivity,
  ): Promise<MessageHandle | undefined> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return (await stream.close(content)).handle
      } catch (error) {
        if (attempt === 1) continue
        this.logger?.warn('IM output summary of session %s could not close its progress message: %s',
          activity.session.sessionId, error instanceof Error ? error.message : String(error))
      }
    }
    return (await this.io.send(content)).handle
  }

  /**
   * Close the streamed message with the turn's settled content. The platform refuses an occasional edit (an expired
   * card, a transient answer), so one refusal is retried before the content has to go out as a plain message.
   * @param stream - the turn's message stream.
   * @param content - the settled content of the turn.
   * @param activity - the settled turn, for the log.
   * @returns whether the streamed message took the content.
   */
  private async closeStream(stream: MessageStream, content: Element<'message'>, activity: ImActivity): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await stream.close(content)
        return true
      } catch (error) {
        if (attempt === 1) continue
        this.logger?.warn('IM output summary of session %s could not close its progress message, so the closing content '
          + 'goes out as a message instead: %s', activity.session.sessionId,
        error instanceof Error ? error.message : String(error))
      }
    }
    return false
  }

  // ---------------------------------------------------------------------------------------------------------------

  /**
   * The turn's message stream, opened on first use and kept for the rest of the turn.
   * @param activity - the turn as it stands when the stream opens: it resolves the rendering plan.
   * @returns the stream, or `undefined` when the platform refused to open one (fallback: one plain send).
   */
  private open(activity: ImActivity): Promise<MessageStream | undefined> {
    this.ready ??= this.io.stream({ intervalMs: this.config.intervalMs }).then(
      (stream) => {
        this.plan = this.resolvePlan(activity, stream)
        return stream
      },
      () => {
        this.plan = this.resolvePlan(activity, undefined)
        return undefined
      },
    )
    return this.ready
  }

  /**
   * Whether the turn has reached the point where its message may appear: right away, or at its first tool call.
   * @param activity - the turn as it stands now.
   * @returns whether the message may be published.
   */
  private showing(activity: ImActivity): boolean {
    if (this.ready !== undefined) return true
    if (this.config.firstOutput === 'immediate') return true
    // The silencing call itself is not the work the message is waiting for.
    return activity.segments.some(segment => segment.kind === 'tool' && segment.name !== NO_OUTPUT_TOOL)
  }

  /**
   * The plan of this turn: what the stream's strategy allows, and the configured bounds.
   * @param activity - the turn, providing the session whose stop button a click routes back to.
   * @param stream - the opened stream, or `undefined` when the platform refused one.
   * @returns the plan every render of this turn uses.
   */
  private resolvePlan(activity: ImActivity, stream: MessageStream | undefined): SummaryPlan {
    const plan: SummaryPlan = {
      editing: rewritesInPlace(stream?.strategy),
      showStop: this.config.showStop,
      ...this.hasAuth?.() ? { authStop: true } : {},
      maxChars: this.config.maxChars,
      strings: stringsOf(this.config.locale),
      sessionId: activity.session.sessionId,
      ...this.stopper === undefined ? {} : { stoppedBy: this.stopper },
    }
    // Cards need a message that can be rewritten: an appended or final-only stream could never show a card's change.
    if (this.cardService !== undefined && plan.editing) {
      const cards = this.cardService.turn(activity, this.io.chat)
      cards.attach(() => { if (!this.closed) this.publish(this.latest) })
      plan.cards = cards
    }
    this.logger?.info('IM output summary begins turn %d of %s in %s (editing=%s stop=%s progress=%s)',
      activity.turn, activity.session.sessionId, this.io.chat, plan.editing, plan.showStop,
      String(this.progress !== undefined))
    // Summaries need a rewritable message: an appended or final-only one could never replace an outdated summary.
    if (!this.closed && this.progress !== undefined && plan.editing) {
      this.unwatch = this.progress.watch(activity.session.sessionId, activity.turn, (summary) => {
        if (this.closed) return
        this.summary = summary
        this.publish(this.latest)
      })
    }
    return plan
  }

  /**
   * The plan of a turn that reached `end()` without ever opening a stream (for example, `firstOutput: 'first-tool'`
   * with zero tool calls): no streamed edits happen, while inline cards still mount and adopt onto the sent message.
   * @param activity - the settled turn.
   * @returns the non-editing rendering plan for the single final publication.
   */
  private resolveFinalPlan(activity: ImActivity): SummaryPlan {
    const plan: SummaryPlan = {
      editing: false,
      showStop: this.config.showStop,
      ...this.hasAuth?.() ? { authStop: true } : {},
      maxChars: this.config.maxChars,
      strings: stringsOf(this.config.locale),
      sessionId: activity.session.sessionId,
      ...this.stopper === undefined ? {} : { stoppedBy: this.stopper },
    }
    if (this.cardService !== undefined) {
      plan.cards = this.cardService.turn(activity, this.io.chat)
    }
    return plan
  }

  /**
   * The running message of this turn, composed with every plugin's contribution.
   * @param activity - the running turn.
   * @returns the message, or `undefined` when there is nothing to show yet.
   */
  private running(activity: ImActivity): Element<'message'> | undefined {
    const children = runningContent(activity, this.plan!, this.summary)
    return children === undefined ? undefined : h('message', ...this.contribute('progress', activity, () => children))
  }

  /**
   * The settled message of this turn, composed with every plugin's contribution.
   * @param activity - the settled turn.
   * @param plan - the turn's resolved rendering plan.
   * @param hasProcessMessage - whether the turn already kept a separate collapsed process message.
   * @returns the message, or `undefined` when the turn has nothing to leave behind.
   */
  private settled(activity: ImActivity, plan: SummaryPlan, hasProcessMessage = false): Element<'message'> | undefined {
    const children = finalContent(activity, plan)
    return children === undefined
      ? undefined
      : h('message', ...this.contribute('settled', activity, () => children, { hasProcessMessage }))
  }

  /**
   * The one line a stopped or failed turn closes with, composed with every plugin's contribution.
   * @param activity - the settled turn.
   * @param plan - the turn's resolved rendering plan.
   * @param hasProcessMessage - whether the turn already kept a separate collapsed process message.
   * @returns the message.
   */
  private closing(activity: ImActivity, plan: SummaryPlan, hasProcessMessage = false): Element<'message'> {
    return h('message', ...this.contribute('closing', activity, () => closingContent(activity, plan), { hasProcessMessage }))
  }

  /**
   * Run the contribution waterfall for one state of the message.
   * @param part - which state of the turn the message shows.
   * @param activity - the turn the message belongs to.
   * @param next - this renderer's own children of that state.
   * @param options - whether a separate process message was already kept.
   * @returns the children to publish.
   */
  private contribute(
    part: StreamingPart,
    activity: ImActivity,
    next: () => Child[],
    options?: { hasProcessMessage?: boolean },
  ): Child[] {
    const message: ImStreamingMessage = {
      activity,
      part,
      ...options?.hasProcessMessage ? { hasProcessMessage: true } : {},
    }
    return this.compose === undefined ? next() : this.compose(message, next)
  }

  /** Replace the streamed state with the running view of `activity` (never throws, never opens an empty message). */
  private publish(activity: ImActivity): void {
    if (this.closed || this.silent || !this.showing(activity)) return
    void this.open(activity).then((stream) => {
      if (this.closed || this.silent) return
      const content = this.running(activity)
      if (content === undefined) return
      // A stream that stopped applying updates would otherwise freeze the card with no trace: report the state the
      // stream is in whenever it changes, and whenever a new summary goes out.
      const state = stream?.state ?? 'no-stream'
      const summaryChars = this.summary?.length ?? 0
      if (state !== this.lastState || summaryChars !== this.lastSummaryChars) {
        this.lastState = state
        this.lastSummaryChars = summaryChars
        this.logger?.info('IM output summary of session %s publishes %d answer chars and %d summary chars (stream=%s)',
          activity.session.sessionId, answerOf(activity).length, summaryChars, state)
      }
      if (stream !== undefined) {
        this.published = true
        stream.update(content)
      }
    })
  }
}
