/**
 * Durable cache of `dsh-im-user-names` (domain `im_user_names`):
 * - `users`: `${botId}|${userId}` → `{ name, source, updatedAt }`, storing pure display names without the `(${id})`
 *   suffix so format changes (`includeId`) apply cleanly and re-enrichment never double-wraps.
 */
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'

export type UserNameSource = 'member' | 'contact' | 'mention' | 'sender'

export interface StoredUserName {
  /** Pure display name without any trailing `(${userId})` suffix. */
  name: string
  /** Where this display name was learned from. */
  source: UserNameSource
  /** Unix epoch milliseconds when this entry was recorded or refreshed. */
  updatedAt: number
}

const storedUserNameSchema = z.object({
  name: z.string(),
  source: z.enum(['member', 'contact', 'mention', 'sender']),
  updatedAt: z.number(),
})

/** Scoped cache key for one user under one bot (`${botId}|${userId}`). */
export function userCacheKey(botId: string, userId: string): string {
  return `${botId}|${userId}`
}

export const imUserNamesDomain = defineDomain({
  name: 'im_user_names',
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: {
    users: domainTable<string, StoredUserName>(storedUserNameSchema),
  },
})

export type ImUserNamesDomain = Domain<typeof imUserNamesDomain>
