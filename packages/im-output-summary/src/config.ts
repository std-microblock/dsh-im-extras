/** Operator configuration of the summary output renderer. */
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Reply language of the summary renderer. */
export type SummaryLocale = 'zh' | 'en'

/**
 * When a turn's message first appears: `immediate` opens it as the turn starts, and `first-tool` waits for the turn's
 * first tool call, so a turn that only answers arrives as the single message the person reads.
 */
export type FirstOutput = 'immediate' | 'first-tool'

/**
 * Operator configuration of the summary renderer: reply language, answer bound, publish pacing, the stop button, and
 * the cadence and bounds of the model-written progress summaries.
 */
export interface SummaryConfig {
  /** Reply language; `zh` by default. Progress summaries are written in this language too. */
  locale: SummaryLocale
  /** Characters of the answer shown at most (the platform's `limit.text.chars` wins when it is smaller). */
  maxChars: number
  /** Minimum interval between two published states of the one streamed message. */
  intervalMs: number
  /** Whether the message appears as the turn starts or at its first tool call. */
  firstOutput: FirstOutput
  /** Offer the `dsh:stop:<sessionId>` button on platforms that support action buttons. */
  showStop: boolean
  /** Enable model-written progress summaries on platforms that can rewrite the streamed message. */
  progress: boolean
  /** Delay before the first summary of a turn, so even a short task reports where it stands. */
  progressFirstDelayMs: number
  /** Milliseconds that pass at least between the turn start or the previous summary and the next one. */
  progressIntervalMs: number
  /** Model requests the turn makes at least between the turn start or the previous summary and the next one. */
  progressMinSteps: number
  /** End-to-end deadline of one summary request. */
  progressTimeoutMs: number
  /** Output-token budget of one summary reply; unset keeps the turn's own budget. */
  progressMaxTokens?: number
  /** Reasoning effort of the summary reply; unset keeps the turn's own effort (and its latency). */
  progressReasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Characters of one summary shown at most. */
  progressMaxChars: number
}

/** Validated operator configuration. */
export const Config = z.object({
  locale: z.union(['zh', 'en']).default('zh'),
  maxChars: z.natural().min(1).default(4000),
  intervalMs: z.natural().min(1).default(1200),
  firstOutput: z.union(['immediate', 'first-tool']).default('immediate'),
  showStop: z.boolean().default(true),
  progress: z.boolean().default(true),
  progressFirstDelayMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(5_000),
  progressIntervalMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(60_000),
  progressMinSteps: z.natural().default(3),
  progressTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  progressMaxTokens: z.natural().min(1),
  progressReasoningEffort: z.union(['off', 'low', 'high', 'max']),
  progressMaxChars: z.natural().min(1).default(600),
})

/** The resolved configuration shape the validated `Config` schema produces. */
export type Config = SummaryConfig
