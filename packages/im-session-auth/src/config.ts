/** Operator configuration schema of `dsh-im-session-auth`. */
import z from '@deepseek-ai/schemastery'
import type { SessionAuthConfig } from './api.ts'

/** Validated operator configuration. */
export const Config = z.object({
  refusalThrottleMs: z.natural().min(0).default(15_000),
})

/** Resolved configuration shape. */
export type Config = SessionAuthConfig
