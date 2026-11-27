/** Configuration of `dsh-im-user-names`. */
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Whether user display-name resolution and enrichment is enabled. */
  enabled: boolean
  /**
   * Append the platform user ID to resolved display names (`Name(userId)` instead of bare `Name`), so agents keep both
   * the human name and the mentionable/authorizable platform ID in `<im-message from="…">`.
   */
  includeId: boolean
  /** Batch-sync group/topic rosters through `ctx.im.members` on cache miss. */
  syncChatMembers: boolean
  /**
   * Fallback to platform single-user lookup (for example Lark `bot.internal.contact.user.get`) for direct chats or
   * users absent from the group roster. Automatically circuit-breaks per bot when the app lacks contact scope.
   */
  contactFallback: boolean
  /** Backfill `message.quote.sender` from local history and enrich quoted sender display names. */
  enrichQuotes: boolean
  /** Freshness TTL (ms) for cached user names before a live refresh may be attempted. */
  ttlMs: number
  /** Per-user negative cache cooldown (ms) after an unresolved lookup. */
  negativeTtlMs: number
  /** Per-chat cooldown (ms) between consecutive `ctx.im.members` roster syncs. */
  chatSyncCooldownMs: number
  /** Per-bot circuit-breaker cooldown (ms) after contact lookup reports missing permission/scope. */
  contactForbiddenCooldownMs: number
  /** Wall-clock timeout (ms) for one live lookup (roster sync or contact fetch) before degrading gracefully. */
  lookupTimeoutMs: number
  /** Maximum pages (100 members per page) read during a single chat roster sync. */
  maxMemberPages: number
  /** Maximum cached user records retained in memory and durable storage. */
  maxEntries: number
  /**
   * Static display-name overrides keyed by `${botId}|${userId}` or bare `${userId}` (useful for webhook/alert bots that
   * do not appear in chat member lists).
   */
  aliases: Record<string, string>
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Enable IM user display-name resolution and enrichment.'),
  includeId: Schema.boolean().default(true)
    .description('Format resolved display names as `Name(userId)` so agents retain both name and platform user ID.'),
  syncChatMembers: Schema.boolean().default(true)
    .description('Batch-sync group/topic member lists via ctx.im.members on cache miss.'),
  contactFallback: Schema.boolean().default(true)
    .description('Fallback to platform single-user contact lookup (e.g. Lark contact.user.get) when absent from roster; auto-disables on permission errors.'),
  enrichQuotes: Schema.boolean().default(true)
    .description('Backfill quote.sender from local history and enrich quoted sender names.'),
  ttlMs: Schema.natural().default(7 * 24 * 60 * 60 * 1000)
    .description('Cache freshness TTL in milliseconds (default 7 days).'),
  negativeTtlMs: Schema.natural().default(10 * 60 * 1000)
    .description('Per-user cooldown in milliseconds after an unresolved lookup (default 10 minutes).'),
  chatSyncCooldownMs: Schema.natural().default(10 * 60 * 1000)
    .description('Per-chat cooldown in milliseconds between member roster syncs (default 10 minutes).'),
  contactForbiddenCooldownMs: Schema.natural().default(6 * 60 * 60 * 1000)
    .description('Per-bot circuit-breaker duration in milliseconds when contact API denies permission (default 6 hours).'),
  lookupTimeoutMs: Schema.natural().min(100).default(3_000)
    .description('Maximum wait in milliseconds for one live name lookup before falling back.'),
  maxMemberPages: Schema.natural().min(1).default(10)
    .description('Maximum pages (100 members/page) fetched during a chat roster sync.'),
  maxEntries: Schema.natural().min(1).default(10_000)
    .description('Maximum cached user entries retained.'),
  aliases: Schema.dict(Schema.string()).default({})
    .description('Static display-name overrides keyed by `${botId}|${userId}` or bare `${userId}`.'),
})
