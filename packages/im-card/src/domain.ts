/**
 * Durable state of the cards (domain `im_cards`, one document per card): what was published, where, by whom, the
 * compiled bundle and the latest VM snapshot.
 *
 * @module dsh-im-card/domain
 */
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type { CardBundle } from './bundle.ts'
import type { CardSnapshot } from './engine.ts'

/** Where a card lives: a standalone message, or a slot inside a streamed turn message. */
export type CardPlacement =
  | { kind: 'message' }
  | { kind: 'slot'; host: string; index: number }

/** One stored card. */
export interface CardRecord {
  id: string
  /** Session that published the card (receives `agent.send`). */
  session: string
  /** Chat key the card is published in. */
  chat: string
  /** Platform message id of the message carrying the card, once known. */
  message?: string
  /** Bot id of that message. */
  bot?: string
  placement: CardPlacement
  bundle: CardBundle
  props: unknown
  /**
   * The person whose message the card answers. Quick replies default to admitting only them, and name them in toasts
   * and in the line a used control leaves; absent, they admit everyone.
   */
  requester?: { id: string; name?: string }
  /**
   * Absolute path of the folder this card may read and write (`fs`), fixed when it was published. Absent for a card
   * published without a working directory, or with file access switched off.
   */
  dataDir?: string
  /** Latest snapshot; absent until the first snapshot was written. */
  snapshot?: CardSnapshot
  /** The card was closed: no more renders, its buttons are inert. */
  closed: boolean
  /** Earliest timer due (epoch ms) when the snapshot was taken: the card is revived then even without a click. */
  wake?: number
  createdAt: number
  updatedAt: number
}

/** One streamed message that hosts card slots: its body without the cards, so a card update can republish it. */
export interface HostRecord {
  id: string
  chat: string
  bot: string
  message: string
  /** The message content as JSON element tree, with `<dsh-card-slot index>` placeholders where cards go. */
  content: unknown
  cards: string[]
  createdAt: number
}

const snapshotSchema = z.object({
  baseline: z.string(),
  length: z.number().int().positive(),
  delta: z.string(),
  stackPointer: z.number(),
  runtimePtr: z.number(),
  contextPtr: z.number(),
})

const cardSchema = z.looseObject({
  id: z.string(),
  session: z.string(),
  chat: z.string(),
  message: z.exactOptional(z.string()),
  bot: z.exactOptional(z.string()),
  placement: z.union([
    z.object({ kind: z.literal('message') }),
    z.object({ kind: z.literal('slot'), host: z.string(), index: z.number().int().nonnegative() }),
  ]),
  // Cards published before esbuild bundling stored a module map instead of one script: they still restore from their
  // snapshot, but cannot be re-run from source (script is empty for them).
  bundle: z.union([
    z.object({ entry: z.string(), script: z.string(), files: z.array(z.string()) }),
    z.object({ entry: z.string(), modules: z.record(z.string(), z.string()) })
      .transform(old => ({ entry: old.entry, script: '', files: Object.keys(old.modules) })),
  ]),
  props: z.unknown(),
  requester: z.exactOptional(z.object({ id: z.string(), name: z.exactOptional(z.string()) })),
  dataDir: z.exactOptional(z.string()),
  snapshot: z.exactOptional(snapshotSchema),
  closed: z.boolean(),
  wake: z.exactOptional(z.number()),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const hostSchema = z.looseObject({
  id: z.string(),
  chat: z.string(),
  bot: z.string(),
  message: z.string(),
  content: z.unknown(),
  cards: z.array(z.string()),
  createdAt: z.number(),
})

/** The `im_cards` storage domain. */
export const imCardsDomain = defineDomain({
  name: 'im_cards',
  version: 1,
  layout: 'per-record',
  tables: {
    cards: domainTable<string, CardRecord>(cardSchema),
    hosts: domainTable<string, HostRecord>(hostSchema),
  },
})

/** Typed handle of the `im_cards` domain. */
export type ImCardsDomain = Domain<typeof imCardsDomain>
