# dsh-im-user-names

Standalone Cordis plugin for `@deepseek-ai/dsh-im` that resolves and caches platform user display names (for example Feishu `open_id` → `张三(ou_…)`) across inbound messages, quotes, reactions, and card interactions without modifying `dsh-im` or platform adapters.

## Why

Platforms such as Feishu/Lark omit sender display names from `im.message.receive_v1` and `GET /im/v1/messages`, so `dsh-im` formats `<im-message from="ou_…">` with bare opaque IDs. Mounting this plugin prepends an enrichment pass ahead of `im-dispatch`, `im-session-auth`, and `im-session-commands`:

- **`im/message` (`prepend: true`)**: enriches `event.message.sender.name` (and optionally `event.message.quote.sender`) before downstream routing and before `ImStore.settle()` persists the settled record.
- **`satori/receive` (`prepend: true`)**: passively harvests `mentions.users` (without mutating the raw message before `dsh-im` hashes its dedupe digest), enriches reaction operators with a bounded lookup, and enriches card interactions strictly from memory cache (0 ms I/O).
- **`im/stored` (`prepend: true`)**: synchronously fills names from cache for historical messages read on demand via `im_read`.

## Resolution tiers

1. **Static `aliases`**: exact `${botId}|${userId}` or bare `${userId}` overrides (handy for webhook/alert bots that are absent from chat member rosters).
2. **Durable cache (`im_user_names`) + memory LRU**: stores pure display names without the `(${id})` suffix, hydrated on startup, with configurable TTL (`ttlMs`, default 7 days) and stale-while-error fallback.
3. **Passive harvesting**: zero-API learning from `message.mentions.users` and any pre-populated `sender.name`.
4. **Group roster sync (`ctx.im.members`)**: single-flight per chat with cooldown (`chatSyncCooldownMs`, default 10 minutes), batch-caching up to `maxMemberPages × 100` members using the same scope `im_members` already holds.
5. **Contact fallback (optional)**: duck-typed `bot.internal.contact.user.get(openId, { user_id_type: 'open_id' })` for direct chats or non-roster human users; automatically circuit-breaks per bot on permission errors (`99991672` / `403`).

## Output format

With the default `includeId: true`, resolved display names are formatted idempotently as `Name(userId)` (for example `<im-message seq="12" from="张三(ou_abc)" time="14:07">`), so the model sees both who spoke and the platform ID needed for `<at user_id="…">` mentions or session access grants. Set `includeId: false` for bare names (`张三`).

## Mounting

Mount after `im-session-auth` (so `prepend: true` places this plugin first on `im/message`) and route `im_user_names` to your preferred `storage-domain` backend (e.g. `sqlite`):

```yaml
- insert:
    - id: im-user-names
      name: dsh-im-user-names
      config:
        includeId: true
```
