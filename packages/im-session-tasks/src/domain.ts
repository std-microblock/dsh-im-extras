/**
 * Durable storage of the task registry (domain `im_tasks`): one record per worker session, keyed by that session id,
 * so a restart knows the owners and titles of every task.
 *
 * Version 2 removed the task `status`: version-1 rows still carry it, and the schema below strips it on read while the
 * rest of the record is unchanged, so both generations load and the next write stamps version 2.
 */
import { z } from 'zod'
import type { ImChatKey } from '@deepseek-ai/dsh-im'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type { TaskRecord } from './api.ts'

/**
 * Stored text of one branded identity: the record keeps `${botId}|${id}` (or the session id) itself, so a read
 * re-applies the compile-time brand to the text it just validated.
 */
const storedSessionId = z.string().transform((value): SessionId => value as SessionId)
const storedChatKey = z.string().transform((value): ImChatKey => value as ImChatKey)

const taskSchema = z.object({
  session: storedSessionId,
  id: z.number().int().nonnegative(),
  owner: storedSessionId,
  title: z.string(),
  note: z.exactOptional(z.string()),
  description: z.exactOptional(z.string()),
  wantedTopics: z.exactOptional(z.array(z.string())),
  topicScope: z.exactOptional(z.union([z.literal('chat'), z.literal('all')])),
  followThread: z.exactOptional(z.boolean()),
  chat: storedChatKey,
  meta: z.exactOptional(z.record(z.string(), z.unknown())),
  key: z.exactOptional(z.string()),
  ownerKind: z.exactOptional(z.string()),
  seq: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/** The `im_tasks` storage domain. */
export const imTasksDomain = defineDomain({
  name: 'im_tasks',
  version: 2,
  compatibleVersions: [1],
  tables: {
    tasks: domainTable<string, TaskRecord>(taskSchema),
  },
})

/** The typed handle of the `im_tasks` storage domain. */
export type ImTasksDomain = Domain<typeof imTasksDomain>
