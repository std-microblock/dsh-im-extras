/**
 * Element builders of the summary renderer: the platform-neutral content of the one streamed message per turn — a
 * status line, the latest progress summary or the answer so far, and (running only) the stop button.
 *
 * Each builder returns the children of the message, not the message: the turn composes `im/streaming-message` around
 * them, which is where other plugins add their own lines. Everything here is pure: the same activity and plan always
 * produce the same children, which keeps payload snapshots stable and lets the stream scheduler skip unchanged states.
 */
import type { Child, Element } from '@deepseek-ai/cordis-plugin-im-core'
import { h } from '@deepseek-ai/cordis-plugin-im-core'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ImActivity } from '@deepseek-ai/dsh-im'
import { segmentsOf, type TurnCards } from './cards.ts'
import type { SummaryStrings } from './locale.ts'

/** Characters of an error message kept in the closing line. */
export const SUMMARY_ERROR_CHARS = 200

/**
 * Prefix of this renderer's stop button: `summary:stop:<sessionId>`. The plugin answers the click itself
 * (`im/button`): it stops the session when the chat the button lives in is bound to it.
 */
export const STOP_BUTTON_PREFIX = 'summary:stop:'

/**
 * The stop prefix the IM host used to route itself, still carried by cards published before this renderer owned the
 * button; a click on one is handled exactly like {@link STOP_BUTTON_PREFIX}.
 */
export const LEGACY_STOP_BUTTON_PREFIX = 'dsh:stop:'

/**
 * The session a stop control targets.
 * @param id - a button id.
 * @returns the session id and whether the click goes through the session-auth guard; `undefined` for any other button.
 */
export function stopTargetOf(id: string): { sessionId: string; auth: boolean } | undefined {
  if (id.startsWith(AUTH_STOP_BUTTON_PREFIX)) return { sessionId: id.slice(AUTH_STOP_BUTTON_PREFIX.length), auth: true }
  for (const prefix of [STOP_BUTTON_PREFIX, LEGACY_STOP_BUTTON_PREFIX]) {
    if (id.startsWith(prefix)) return { sessionId: id.slice(prefix.length), auth: false }
  }
  return undefined
}

/** Stop button prefix used when `dsh-im-session-auth` (`ctx.imAuth`) is mounted so stop clicks require ACL. */
export const AUTH_STOP_BUTTON_PREFIX = 'dsh:auth-stop:'

/** What one turn renders, resolved once from the stream strategy and the config in `begin`. */
export interface SummaryPlan {
  /** The stream rewrites what the message already shows (`patch` / `edit`), so provisional content stays truthful. */
  editing: boolean
  /** Offer the stop control while the turn runs (`config.showStop`). */
  showStop: boolean
  /** Route stop clicks through session auth guard (`dsh:auth-stop:`) instead of the unguarded `summary:stop:`. */
  authStop?: boolean
  /** Answer characters shown at most (`config.maxChars`). */
  maxChars: number
  strings: SummaryStrings
  sessionId: SessionId
  /**
   * Whoever clicked this turn's stop control, recorded when the click arrives: the closing footer then names them
   * instead of saying only that the turn was cancelled. Absent for a turn stopped another way (`/stop`, the GUI).
   */
  stoppedBy?: { id: string; name?: string }
  /** Cards of this turn; absent when no card service is mounted (card blocks stay code blocks). */
  cards?: TurnCards
}

/**
 * The answer so far: every text segment of the turn, in order.
 * @param activity - the turn's activity accumulated so far.
 * @returns the text segments joined by a blank line, trimmed; `''` when the turn produced none.
 */
export function answerOf(activity: ImActivity): string {
  return activity.segments
    .flatMap(segment => (segment.kind === 'text' ? [segment.text] : []))
    .join('\n\n')
    .trim()
}

/**
 * Tool calls the turn made so far.
 * @param activity - the turn's activity accumulated so far.
 * @returns the number of tool segments, running or finished.
 */
export function toolCalls(activity: ImActivity): number {
  return activity.segments.filter(segment => segment.kind === 'tool').length
}

/**
 * The tool being called right now, if the turn's latest step is a running tool call.
 * @param activity - the turn's activity accumulated so far.
 * @returns the running tool's name, or `undefined` when the latest segment is no running tool.
 */
export function runningTool(activity: ImActivity): string | undefined {
  const last = activity.segments.at(-1)
  return last?.kind === 'tool' && last.status === 'running' ? last.name : undefined
}

/**
 * The one-line progress of the turn: the running tool, or the model thinking.
 * @param activity - the turn's activity accumulated so far.
 * @param strings - string table of the configured reply language.
 * @returns the `calling` line of a running tool, else the `thinking` line.
 */
export function statusLine(activity: ImActivity, strings: SummaryStrings): string {
  const tool = runningTool(activity)
  return tool === undefined ? strings.thinking : strings.calling(tool, toolCalls(activity))
}

/**
 * The answer bounded by `maxChars`, with the truncation note when it was cut (code-point safe).
 * @param activity - the turn's activity accumulated so far.
 * @param maxChars - answer characters to show at most.
 * @param strings - string table providing the truncation note.
 * @returns the answer, or its prefix plus the truncation note when it exceeded `maxChars` code points.
 */
export function boundedAnswer(activity: ImActivity, maxChars: number, strings: SummaryStrings): string {
  const answer = answerOf(activity)
  // Card sources are code, not reading matter: only the prose counts against the bound, and a cut never lands
  // inside a card block.
  const segments = segmentsOf(answer)
  if (segments.some(segment => segment.kind === 'card')) {
    let budget = maxChars
    let out = ''
    for (const segment of segments) {
      if (segment.kind === 'card') {
        out += `\n\`\`\`satori-tsx\n${segment.source}${segment.complete ? '\n```\n' : ''}`
        continue
      }
      const chars = Array.from(segment.text)
      if (chars.length <= budget) {
        out += segment.text
        budget -= chars.length
        continue
      }
      return `${out}${chars.slice(0, budget).join('').trimEnd()}${strings.truncated}`
    }
    return out.trim()
  }
  const chars = Array.from(answer)
  if (chars.length <= maxChars) return answer
  return `${chars.slice(0, maxChars).join('').trimEnd()}${strings.truncated}`
}

/**
 * The answer as message children: markdown, with each ```` ```satori-tsx ```` block replaced by its card when the turn
 * has a card service. Without one the answer is a single markdown element.
 * @param answer - the bounded answer.
 * @param plan - the turn's plan (its cards).
 * @returns the children.
 */
export function answerBody(answer: string, plan: SummaryPlan): Child[] {
  const cards = plan.cards
  if (cards === undefined) return [h.markdown(answer)]
  const segments = segmentsOf(answer)
  if (!segments.some(segment => segment.kind === 'card')) return [h.markdown(answer)]
  return segments.flatMap((segment): Child[] => segment.kind === 'markdown'
    ? [h.markdown(segment.text)]
    : cards.render(segment.index, segment.source, segment.complete))
}

/**
 * The settled answer with every card replaced by its slot placeholder (what the card service stores to republish).
 * @param answer - the bounded answer the message was built from.
 * @param plan - the turn's plan.
 * @param footer - the footer line of the message.
 * @returns the slotted children, or `undefined` when the answer holds no card.
 */
export function slottedContent(answer: string, plan: SummaryPlan, footer: Child[]): Child[] | undefined {
  const cards = plan.cards
  if (cards === undefined || cards.count === 0) return undefined
  const children = segmentsOf(answer).flatMap((segment): Child[] => segment.kind === 'markdown'
    ? [h.markdown(segment.text)]
    : [cards.slot(segment.index)])
  return [...children, h('small', ...footer)]
}

/**
 * An error message cut at {@link SUMMARY_ERROR_CHARS}.
 * @param message - the raw error text; runs of whitespace collapse to one space first.
 * @returns the one-line message, ending in `…` when it was cut.
 */
export function boundedError(message: string): string {
  const chars = Array.from(message.replace(/\s+/g, ' ').trim())
  return chars.length <= SUMMARY_ERROR_CHARS ? chars.join('') : `${chars.slice(0, SUMMARY_ERROR_CHARS).join('')}…`
}

/**
 * Failures the chat is told in its own terms: an execution environment that dropped mid-turn is an operator problem
 * on our side, and the raw text names a path the reader cannot act on (`/home/agent/work: connection closed`).
 */
const FAILURE_REWRITES: readonly { readonly match: RegExp; readonly text: string }[] = [
  {
    match: /connection closed|EnvError|ssh connection closed|\bCLOSED\b/i,
    text: '执行环境的连接断开了，这一轮没能跑完（不是你的问题），稍后重试即可',
  },
  {
    match: /timed? ?out|ETIMEDOUT|TimeoutError/i,
    text: '这一轮超时了，没能跑完，稍后重试即可',
  },
]

/**
 * The reader-facing account of a failed turn: a known infrastructure failure in plain words, anything else as the
 * bounded raw text.
 * @param message - the raw error text.
 * @returns the one-line failure text, cut at {@link SUMMARY_ERROR_CHARS}.
 */
export function failureOf(message: string): string {
  const bounded = boundedError(message)
  for (const rewrite of FAILURE_REWRITES) {
    if (rewrite.match.test(bounded)) return rewrite.text
  }
  return bounded
}

/**
 * The stop control of this turn's session (this plugin routes `summary:stop:<sessionId>` to `sessions.stop`).
 *
 * A `<fallback>`: an action button where the mode renders one, and a line telling the reader how to stop everywhere
 * else — a platform without interactive buttons must not receive a dead button.
 *
 * @param plan - the turn's resolved rendering plan.
 * @returns the alternative carrying the turn's stop id.
 */
export function stopButton(plan: SummaryPlan): Element<'fallback'> {
  const prefix = plan.authStop ? AUTH_STOP_BUTTON_PREFIX : STOP_BUTTON_PREFIX
  return h('fallback',
    h('button', { type: 'action', id: `${prefix}${plan.sessionId}` }, plan.strings.stop),
    h.text(plan.strings.stopHint))
}

/**
 * Footer of a finished turn: elapsed time, tool calls, and why the turn ended early. A turn somebody stopped names
 * them — `已由 @名字 取消` — because a mention tells the reader who ended it; a turn stopped another way (`/stop`, the
 * GUI page) has no click to attribute and says only that it was cancelled.
 *
 * @param activity - the finished turn's activity.
 * @param plan - the turn's resolved rendering plan.
 * @returns the footer's children: text, with the mention of whoever stopped the turn in place.
 */
export function footerLine(activity: ImActivity, plan: SummaryPlan): Child[] {
  const elapsed = plan.strings.elapsed(activity.updatedAt - activity.startedAt)
  const base = plan.strings.footer(elapsed, toolCalls(activity))
  if (activity.status === 'cancelled') {
    const by = plan.stoppedBy
    if (by === undefined) return [h.text(`${base} · ${plan.strings.cancelled}`)]
    return [
      h.text(`${base} · ${plan.strings.stoppedBefore}`),
      h('at', { type: 'user', id: by.id, ...by.name === undefined ? {} : { name: by.name } }),
      h.text(plan.strings.stoppedAfter),
    ]
  }
  if (activity.status === 'error' && activity.error !== undefined) {
    return [h.text(`${base} · ${plan.strings.error(failureOf(activity.error))}`)]
  }
  return [h.text(base)]
}

/**
 * Running state: status line, then the latest progress summary or else the answer so far, plus the stop control.
 *
 * `undefined` when there is nothing to show yet — a platform that can only append or only publish the final message
 * has no status line, so an empty answer must not open the stream with an empty message.
 * @param activity - the running turn's activity.
 * @param plan - the turn's resolved rendering plan.
 * @param summary - the latest model-written progress summary of the turn; only shown where the message is editable.
 * @returns the message's children, or `undefined` when the stream has nothing to show yet.
 */
export function runningContent(
  activity: ImActivity,
  plan: SummaryPlan,
  summary?: string,
): Child[] | undefined {
  const answer = boundedAnswer(activity, plan.maxChars, plan.strings)
  if (!plan.editing) return answer ? answerBody(answer, plan) : undefined
  const children: Child[] = [h('small', h.text(statusLine(activity, plan.strings)))]
  // A summary replaces the answer so far: the turn's intermediate narration is what the summary condenses. Cards are
  // part of the answer, so they show only while the answer does.
  if (summary !== undefined && summary !== '') children.push(h.markdown(summary))
  else if (answer) children.push(...answerBody(answer, plan))
  // Never in an append-only or final-only stream: the control would repeat in every appended suffix and could not be
  // taken back again, which is why `editing` is the condition.
  if (plan.showStop) children.push(stopButton(plan))
  return children
}

/**
 * Final state: the answer and its footer; an error line when the turn failed without answering.
 * @param activity - the finished turn's activity.
 * @param plan - the turn's resolved rendering plan.
 * @returns the settled message's children, or `undefined` to leave the stream's last state in place.
 */
export function finalContent(activity: ImActivity, plan: SummaryPlan): Child[] | undefined {
  const answer = boundedAnswer(activity, plan.maxChars, plan.strings)
  if (answer) {
    // A failed turn's text is what it managed to say before it broke: mark it, so nobody reads half an answer — or a
    // line of the model's own narration — as the conclusion.
    const partial = activity.status === 'error' ? [h('small', h.text(plan.strings.partial))] : []
    return [...answerBody(answer, plan), ...partial, h('small', ...footerLine(activity, plan))]
  }
  if (activity.error !== undefined) return [h('small', h.text(plan.strings.error(failureOf(activity.error))))]
  return undefined
}

/**
 * The one line a turn that shows no answer closes with: `Done` for a turn that simply produced nothing, and its
 * footer — elapsed time, tool calls, and that it was stopped or failed — for the rest. A turn the chat watched has to
 * end visibly, even when it produced nothing to read.
 * @param activity - the settled turn.
 * @param plan - the turn's resolved rendering plan.
 * @returns the closing message's children.
 */
export function closingContent(activity: ImActivity, plan: SummaryPlan): Child[] {
  return [h('small', ...activity.status === 'done' ? [h.text(plan.strings.done)] : footerLine(activity, plan))]
}
