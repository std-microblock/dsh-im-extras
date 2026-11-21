/**
 * `dsh-im-output-summary`: the streamed summary output renderer.
 *
 * Sessions whose `output` is `summary` stream a live progress card while the agent works (current step / tool being
 * called, a model-written progress summary refreshed on the configured cadence, and a stop button where action buttons
 * exist). When the turn ends, if a live streamed card went out and another plugin contributes `process` content (such
 * as the session page link), that card collapses in place to the `process` content and the final answer + footer (or
 * error line) is sent as a separate new message; cancelled turns with no answer settle in place on the process card,
 * and turns that never opened a streamed card send one result message directly. Sessions with `output: 'none'` (the
 * default) are untouched: nothing is published unless the agent calls a send tool.
 *
 * Two turns ask for less and get it:
 *
 * - `firstOutput: first-tool` keeps the message back until the turn's first tool call, so a turn that only answers
 *   arrives as the single message the person reads rather than as a card that appears and is rewritten.
 * - The `no_output` tool silences a turn that should leave the chat untouched (a click that only updates a card, work
 *   nobody should read): what it published is withdrawn and nothing else goes out.
 *
 * The message is open to other plugins through the `im/streaming-message` waterfall: another plugin (a page-link plugin, for
 * one) contributes a link to the session's page to the message this renderer already publishes, instead
 * of posting a second "working" message beside it.
 *
 * ```yaml
 * - dsh-im-output-summary:
 *     locale: zh
 *     maxChars: 4000
 *     intervalMs: 1200
 *     firstOutput: first-tool
 *     showStop: true
 *     progress: true
 *     progressIntervalMs: 60000
 *     progressMinSteps: 3
 * ```
 *
 * @module @deepseek-ai/dsh-im-output-summary
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-im'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { SummaryConfig } from './config.ts'
import { ProgressSummarizer } from './progress.ts'
import type { TurnCardService } from './cards.ts'
import { SummaryRenderer } from './renderer.ts'
import { applyNoOutputTool, GUIDANCE, GUIDANCE_ORDER, GUIDANCE_SECTION } from './tools.ts'
import { stopTargetOf } from './view.ts'

export { Config, type Config as SummaryConfig, type FirstOutput, type SummaryLocale } from './config.ts'
export { stringsOf, type SummaryStrings } from './locale.ts'
export {
  PROGRESS_SUMMARY_TIMEOUT_CODE, ProgressSummarizer,
  type ImProgressSummaryEventData, type ImProgressSummaryRequestEventData, type ProgressListener, type ProgressSource,
} from './progress.ts'
export { CARD_FENCE, segmentsOf, type AnswerSegment, type TurnCardService, type TurnCards } from './cards.ts'
export { type ImStreamingMessage, type StreamingPart } from './events.ts'
export { normalizeSummary, progressPrompt } from './prompt.ts'
export {
  SummaryRenderer, SUMMARY_RENDERER_ID, type MessageComposer, type StopClick, type SummaryLog,
} from './renderer.ts'
export { applyNoOutputTool, GUIDANCE, GUIDANCE_ORDER, GUIDANCE_SECTION, NO_OUTPUT_TOOL } from './tools.ts'
export {
  answerBody, answerOf, AUTH_STOP_BUTTON_PREFIX, LEGACY_STOP_BUTTON_PREFIX, STOP_BUTTON_PREFIX, stopTargetOf, boundedAnswer, slottedContent, boundedError, closingContent, finalContent,
  footerLine, runningContent, runningTool, statusLine, stopButton, SUMMARY_ERROR_CHARS, toolCalls, type SummaryPlan,
} from './view.ts'

export const name = 'output-summary'
/** The IM host whose renderer registry this plugin registers into, and the services the progress summaries use. */
export const inject = ['im', 'llm', 'sessions']

/**
 * Register the summary renderer, its progress summarizer and the `no_output` tool.
 * @param ctx - context carrying `im`, `llm`, and `sessions`.
 * @param config - resolved operator configuration.
 */
export function apply(ctx: Context, config: SummaryConfig): void {
  const progress = new ProgressSummarizer(ctx, config)
  progress.start()
  // `imCards` (dsh-im-card) is optional: without it a card block stays a code block. The message itself is composed
  // through `im/streaming-message`, so whichever plugins know something about this turn can add it in place.
  const renderer = new SummaryRenderer(config, progress, ctx.logger,
    () => ctx.get('imCards') as TurnCardService | undefined,
    (message, next) => ctx.waterfall('im/streaming-message', message, next),
    () => ctx.get('imAuth') !== undefined)
  ctx.effect(() => ctx.im.outputs.register(renderer))
  // The stop control belongs to this renderer: `summary:stop:<id>` (and `dsh:stop:<id>` on cards published while the
  // IM host still routed it) stops a session bound to the chat the button lives in. When `imAuth` is active, stop
  // controls carry `dsh:auth-stop:` so unauthorized group members cannot cancel an exclusive session. A turn somebody
  // stopped from the card closes with a footer naming them.
  ctx.on('im/button', (event) => {
    const target = stopTargetOf(event.id)
    if (target === undefined) return
    const record = ctx.im.sessions.get(target.sessionId)
    if (record === undefined || !record.bindings.some(binding => binding.chat === event.chat.key)) return
    if (target.auth) {
      const auth = ctx.get('imAuth') as { canInteract(sessionId: string, userId: string): boolean } | undefined
      if (auth !== undefined && !auth.canInteract(record.sessionId, event.user.id)) {
        void event.raw?.respond?.({
          toast: { type: 'warning', content: '当前会话已被独占，仅独占者及已授权协作者可停止运行' },
        })
        return
      }
    }
    renderer.stoppedBy(event)
    void ctx.im.sessions.stop(record.sessionId).catch((error: unknown) => {
      ctx.logger.warn('IM stop button could not stop session %s: %s', record.sessionId, error)
    })
  })
  // A turn that must leave the chat untouched says so before it publishes: `no_output`, plus the guidance that makes a
  // model reach for it. Both need services a headless deployment may not mount.
  ctx.inject(['tools'], (scoped) => { scoped.effect(() => applyNoOutputTool(scoped, ctx.im, renderer)) })
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(() => scoped.systemPrompt.section({
      name: GUIDANCE_SECTION, order: GUIDANCE_ORDER, interpolate: false, text: GUIDANCE,
    }))
  })
  ctx.logger.info('IM output summary renders turns in %s (%s, summary cadence %d ms)',
    config.locale, config.firstOutput, config.progressIntervalMs)
}
