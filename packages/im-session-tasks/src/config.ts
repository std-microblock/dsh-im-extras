/** Operator configuration of the session-tasks plugin. */
import z from '@deepseek-ai/schemastery'
import type { SessionTasksConfig } from './api.ts'

/** Validated operator configuration. */
export const Config = z.object({
  owners: z.array(z.string()).default(['conversation', 'dispatcher']),
  sharedOwners: z.array(z.string()).default(['dispatch', 'dispatcher']),
  tools: z.object({
    owner: z.array(z.string()).default(['task_start', 'task_list', 'task_message']),
    worker: z.array(z.string()).default(['task_note', 'task_describe']),
  }),
  maxTextChars: z.natural().min(1).default(20000),
  locale: z.union(['zh', 'en']).default('zh'),
})

/** The resolved configuration shape the validated `Config` schema produces. */
export type Config = SessionTasksConfig
