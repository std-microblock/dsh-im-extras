/**
 * Durable storage domain (`im_session_auth`) holding session ACLs and capability grants.
 *
 * @module dsh-im-session-auth/domain
 */
import { z } from 'zod'
import type { ImChatKey, ImMessageKey } from '@deepseek-ai/dsh-im'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionAuthRecord, SessionGrantRecord } from './api.ts'

const storedSessionId = z.string().transform((value): SessionId => value as SessionId)
const storedChatKey = z.string().transform((value): ImChatKey => value as ImChatKey)
const storedMessageKey = z.string().transform((value): ImMessageKey => value as ImMessageKey)

const sessionUserSchema = z.looseObject({
  id: z.string(),
  name: z.exactOptional(z.string()),
})

const allowedUserSchema = z.looseObject({
  id: z.string(),
  name: z.exactOptional(z.string()),
  addedBy: z.exactOptional(z.string()),
  addedAt: z.number(),
})

const sessionAuthSchema = z.looseObject({
  sessionId: storedSessionId,
  exclusive: z.boolean(),
  owner: z.exactOptional(sessionUserSchema),
  allowedUsers: z.array(allowedUserSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const grantSchema = z.looseObject({
  key: z.string(),
  sessionId: storedSessionId,
  capabilityId: z.string(),
  status: z.enum(['pending', 'active', 'reauth_required', 'revoked']),
  grantor: sessionUserSchema,
  chat: z.exactOptional(storedChatKey),
  cardId: z.exactOptional(z.string()),
  cardMessage: z.exactOptional(storedMessageKey),
  statusMessage: z.exactOptional(z.string()),
  meta: z.exactOptional(z.record(z.string(), z.unknown())),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/** The `im_session_auth` storage domain. */
export const imSessionAuthDomain = defineDomain({
  name: 'im_session_auth',
  version: 1,
  tables: {
    sessions: domainTable<string, SessionAuthRecord>(sessionAuthSchema),
    grants: domainTable<string, SessionGrantRecord>(grantSchema),
  },
})

/** Typed handle of `im_session_auth`. */
export type ImSessionAuthDomain = Domain<typeof imSessionAuthDomain>

/** Composite key for the `grants` table. */
export function grantKey(sessionId: string, capabilityId: string): string {
  return `${sessionId}\u0000${capabilityId}`
}
