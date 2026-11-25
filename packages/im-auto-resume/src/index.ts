/**
 * `dsh-im-auto-resume`: IM-native automatic resume for interrupted `dsh-im` sessions.
 *
 * Observes `im/activity` to record running IM sessions (along with their target chat and original trigger message key),
 * keeps markers across crashes and graceful shutdowns (`activity.disposed`), and on startup resumes interrupted
 * sessions through `ctx.im.sessions.deliver` with crash-loop protection (`maxRetries` within `retryWindowMs`).
 *
 * When paired with `dsh-im-output-summary`, resumed turns automatically reattach to their original Feishu/IM streaming
 * card and continue updating it in place instead of posting a fresh card.
 *
 * @module dsh-im-auto-resume
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-im'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { Config, DEFAULT_CONTINUATION_TEXT } from './config.ts'
import { imAutoResumeDomain, type AttemptHistory, type ImAutoResumeDomain, type RunningMarker } from './domain.ts'
import { ImAutoResumeService, wasInterrupted, type AutoResumeExhaustedEvent } from './service.ts'

export { Config, DEFAULT_CONTINUATION_TEXT }
export { imAutoResumeDomain, type AttemptHistory, type ImAutoResumeDomain, type RunningMarker }
export { ImAutoResumeService, wasInterrupted, type AutoResumeExhaustedEvent }

export const name = 'im-auto-resume'
export const inject = ['im', 'agents', 'sessionQuery', 'storageDomain']

export function apply(ctx: Context, config: Config): void {
  const service = new ImAutoResumeService(ctx, config)
  ctx.effect(async () => {
    await service.start()
    return () => service.dispose()
  })
}
