/** Configuration of `dsh-im-auto-resume`. */
import Schema from '@deepseek-ai/schemastery'

/** Default model-visible continuation prompt delivered to an interrupted IM session after restart. */
export const DEFAULT_CONTINUATION_TEXT =
  'The Harness was restarted while you were working in this session. The user wants you to continue the previous work. '
  + 'Review the conversation, check the outcome of any interrupted tool calls before repeating them, and continue from '
  + 'where you stopped. Subagents that were running were interrupted too and will not reply on their own; continue them '
  + 'or delegate again if you still need their results.'

export interface Config {
  /** Whether automatic resume on startup is enabled. */
  enabled: boolean
  /** Maximum number of interrupted IM sessions resumed concurrently. */
  concurrency: number
  /** Maximum automatic resume attempts per session within `retryWindowMs` before giving up. */
  maxRetries: number
  /** Rolling window (ms) for counting repeated automatic resume attempts of one session. */
  retryWindowMs: number
  /** Skip markers older than this (ms), e.g. after prolonged host downtime. */
  maxAgeMs: number
  /** Delay (ms) after startup before scanning and delivering resumed turns, so renderers and adapters finish mounting. */
  startupDelayMs: number
  /** Model-visible continuation message delivered to each resumed session. */
  continuationText: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Enable automatic resume of interrupted IM sessions after host restart.'),
  concurrency: Schema.natural().min(1).default(2)
    .description('Maximum number of IM sessions resumed concurrently.'),
  maxRetries: Schema.natural().default(2)
    .description('Maximum auto-resume attempts per session within retryWindowMs before giving up.'),
  retryWindowMs: Schema.natural().default(600_000)
    .description('Rolling window in milliseconds for counting repeated auto-resume attempts.'),
  maxAgeMs: Schema.natural().default(1_800_000)
    .description('Skip interrupted turns older than this duration in milliseconds.'),
  startupDelayMs: Schema.natural().default(1_500)
    .description('Delay in milliseconds after startup before delivering resumed turns.'),
  continuationText: Schema.string().default(DEFAULT_CONTINUATION_TEXT)
    .description('Continuation text delivered to each resumed IM session.'),
})
