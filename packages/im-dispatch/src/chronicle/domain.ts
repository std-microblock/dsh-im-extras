/**
 * Durable storage domain (`im_chronicle`) holding append-only compacted log entries and immutable sealed chunks.
 *
 * @module dsh-im-dispatch/chronicle/domain
 */

import { z } from 'zod'
import type { DomainLike, KvTableLike } from '../types.ts'
import type { ChronicleChunk, ChronicleEntry } from './api.ts'

export interface ChronicleGlobal {
  nextId: number
  sessionSalt: string
}

const entrySchema = z.object({
  id: z.number().int().positive(),
  time: z.number(),
  kind: z.enum(['task_created', 'task_routed', 'bot_reply']),
  chat: z.string(),
  taskId: z.exactOptional(z.number().int().positive()),
  subject: z.string(),
  summary: z.string(),
  line: z.string(),
})

const chunkSchema = z.object({
  startId: z.number().int().positive(),
  endId: z.number().int().positive(),
  count: z.number().int().positive(),
  text: z.string(),
})

const globalSchema = z.object({
  nextId: z.number().int().positive(),
  sessionSalt: z.string().min(1),
})

/** Zero-padded 8-digit lexicographic key so map iteration stays ordered for 1..99,999,999 entries. */
export function entryKey(id: number): string {
  return String(id).padStart(8, '0')
}

export const chronicleDomain = {
  name: 'im_chronicle',
  version: 1,
  global: {
    schema: globalSchema,
    initial: { nextId: 1, sessionSalt: 'im-chronicle-v1' },
  },
  tables: {
    entries: { valueSchema: entrySchema },
    chunks: { valueSchema: chunkSchema },
  },
} as const

export interface ChronicleStore {
  global: { get(): ChronicleGlobal; set(value: ChronicleGlobal): Promise<void> }
  entries: KvTableLike<ChronicleEntry>
  chunks: KvTableLike<ChronicleChunk>
  close(): Promise<void>
}

export function chronicleStore(domain: DomainLike): ChronicleStore {
  return {
    global: domain.global as ChronicleStore['global'],
    entries: domain.table('entries') as KvTableLike<ChronicleEntry>,
    chunks: domain.table('chunks') as KvTableLike<ChronicleChunk>,
    close: () => domain.close(),
  }
}
