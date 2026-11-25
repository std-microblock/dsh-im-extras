/**
 * Durable storage of `dsh-im-auto-resume` (domain `im_auto_resume`):
 * - `running`: one marker per IM session whose latest turn is open or ended by host disposal (`activity.disposed`).
 * - `attempts`: rolling timestamps of recent auto-resume attempts per session, for crash-loop protection.
 */
import { z } from 'zod'
import type { ImChatKey, ImMessageKey } from '@deepseek-ai/dsh-im'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'

export interface RunningMarker {
  sessionId: SessionId
  chat?: ImChatKey
  triggerKey?: ImMessageKey
  turn: number
  startedAt: number
}

export interface AttemptHistory {
  timestamps: number[]
}

const storedSessionId = z.string().transform((value): SessionId => value as SessionId)
const storedChatKey = z.string().transform((value): ImChatKey => value as ImChatKey)
const storedMessageKey = z.string().transform((value): ImMessageKey => value as ImMessageKey)

const runningMarkerSchema = z.object({
  sessionId: storedSessionId,
  chat: z.exactOptional(storedChatKey),
  triggerKey: z.exactOptional(storedMessageKey),
  turn: z.number().int().nonnegative(),
  startedAt: z.number(),
})

const attemptHistorySchema = z.object({
  timestamps: z.array(z.number()),
})

export const imAutoResumeDomain = defineDomain({
  name: 'im_auto_resume',
  version: 1,
  tables: {
    running: domainTable<string, RunningMarker>(runningMarkerSchema),
    attempts: domainTable<string, AttemptHistory>(attemptHistorySchema),
  },
})

export type ImAutoResumeDomain = Domain<typeof imAutoResumeDomain>
