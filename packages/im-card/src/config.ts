/** Operator configuration of the card service. */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_DATA_DIR } from './data.ts'

/** Bounds and pacing of interactive cards. */
export interface CardsConfig {
  /** Card VMs kept in memory at once; the least recently used one is snapshotted and freed beyond this. */
  maxLive: number
  /** Heap bytes one card VM may allocate. */
  memoryBytes: number
  /** CPU milliseconds one entry into a card VM (render, click, timer) may take. */
  cpuMs: number
  /** Minimum interval between two edits of one message. */
  editIntervalMs: number
  /** Delay between a state change and the snapshot that persists it. */
  snapshotDelayMs: number
  /**
   * Whether a due timer brings a card that is not in memory back. Off by default: only a click revives a card, so no
   * background timer can hold (or re-enter) a VM on its own.
   */
  wakeOnTimer: boolean
  /** Modules one card may import, entry included. */
  maxModules: number
  /** Source bytes of one card over all its modules. */
  maxSourceBytes: number
  /** `agent.send` calls one card may make per minute. */
  agentPerMinute: number
  /** Characters of one `agent.send` text. */
  agentMaxChars: number
  /** Cards one streamed turn message may embed. */
  maxSlotsPerTurn: number
  /**
   * Folder a card reads and writes through its `fs` API: relative to the publishing session's working directory, or
   * absolute. A card cannot leave it. Cards of one working directory share it, so a card names its own files
   * (`poll-42.json`); an empty string gives cards no file access at all.
   */
  dataDir: string
  /** Largest file a card may read, write or append. */
  filesMaxBytes: number
  /** Budget of one card `fetch`, redirects included. */
  fetchTimeoutMs: number
  /** Largest response body a card may receive. */
  fetchMaxBytes: number
  /** `fetch` calls one card may make per minute. */
  fetchPerMinute: number
  /** Requests one card may have in flight at once. */
  fetchConcurrent: number
  /**
   * Host names a card may reach (`api.example.com`, `*.internal`; `*` matches any span of characters). Empty allows
   * any host.
   */
  fetchHosts: string[]
  /** Allow requests to loopback, private, link-local and carrier-grade NAT addresses. */
  fetchAllowPrivate: boolean
  /**
   * Chat key (`<bot>|<chat id>`) that `im_send_card({ test: true })` publishes into instead of the session's chat: a
   * sandbox where the agent can try a card and click it without spamming the real conversation. Unset, `test` only
   * dry-runs the card.
   */
  testChat?: string
  /**
   * Resends one card may make per 5 minutes on a platform that cannot edit a sent message (QQ): each click that
   * changes the card recalls the old message and answers with a new one, and the platform grants few replies per event.
   * A click beyond the bound changes the card's state without republishing it. Unset: 5.
   */
  replaceLimit?: number
  /**
   * What a `card.toast()` becomes on a platform that cannot answer a click with a toast (QQ): `ignore` (default) drops
   * it, `text` sends it as a one-line reply to the click (which spends one of the click's few replies).
   */
  toastFallback?: 'ignore' | 'text'
  /**
   * Text of the quick-reply guidance the model reads in its system prompt (the prebuilt components and when to use
   * them). Unset ships the built-in text; an empty string leaves the section out.
   */
  guidance?: string
}

/** Validated operator configuration. */
export const Config = z.object({
  maxLive: z.natural().min(1).default(32),
  memoryBytes: z.natural().min(1 << 20).default(16 << 20),
  cpuMs: z.natural().min(10).default(1000),
  editIntervalMs: z.natural().min(200).default(1000),
  snapshotDelayMs: z.natural().default(1500),
  wakeOnTimer: z.boolean().default(false),
  maxModules: z.natural().min(1).default(16),
  maxSourceBytes: z.natural().min(1024).default(256 * 1024),
  agentPerMinute: z.natural().default(6),
  agentMaxChars: z.natural().min(1).default(2000),
  maxSlotsPerTurn: z.natural().min(1).default(4),
  dataDir: z.string().default(DEFAULT_DATA_DIR),
  filesMaxBytes: z.natural().min(1024).default(1 << 20),
  fetchTimeoutMs: z.natural().min(100).default(10_000),
  fetchMaxBytes: z.natural().min(1024).default(512 * 1024),
  fetchPerMinute: z.natural().default(20),
  fetchConcurrent: z.natural().min(1).default(3),
  fetchHosts: z.array(z.string()).default([]),
  fetchAllowPrivate: z.boolean().default(false),
  replaceLimit: z.natural().min(1).default(5),
  toastFallback: z.union(['ignore', 'text']).default('ignore'),
  testChat: z.string(),
  guidance: z.string(),
})

/** The resolved configuration. */
export type Config = CardsConfig
