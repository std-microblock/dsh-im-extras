import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Bot, ChatRef, MembersPage, Session } from '@deepseek-ai/cordis-plugin-im-core'
import type { ImChatKey, ImMessage, ImMessageEvent, ImMessageKey, ImOutcome } from '@deepseek-ai/dsh-im'
import {
  Config,
  ImUserNamesHost,
  ImUserNamesService,
  formatUserName,
  isPermissionError,
  isUsableName,
  stripIdSuffix,
  type ImHostLike,
  type ImUserNamesDomain,
  type StoredUserName,
} from '../src/index.ts'

const BOT_ID = 'lark:cli_test'
const BOT_SELF_ID = 'ou_bot_self'
const GROUP_CHAT = `${BOT_ID}|oc_group_1` as ImChatKey
const DM_CHAT = `${BOT_ID}|oc_dm_1` as ImChatKey

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    includeId: true,
    syncChatMembers: true,
    contactFallback: true,
    enrichQuotes: true,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    negativeTtlMs: 10 * 60 * 1000,
    chatSyncCooldownMs: 10 * 60 * 1000,
    contactForbiddenCooldownMs: 6 * 60 * 60 * 1000,
    lookupTimeoutMs: 500,
    maxMemberPages: 10,
    maxEntries: 10_000,
    aliases: {},
    ...overrides,
  }
}

function makeMemoryStorage(initial: Record<string, StoredUserName> = {}) {
  const users = new Map<string, StoredUserName>(Object.entries(initial))
  let puts = 0
  let deletes = 0
  const storage = {
    open: async (): Promise<ImUserNamesDomain> => ({
      name: 'im_user_names',
      global: undefined as never,
      table: () => ({
        get: (k: string) => users.get(k),
        entries: () => users.entries(),
        keys: () => users.keys(),
        get size() { return users.size },
        put: async (k: string, v: StoredUserName) => {
          puts += 1
          users.set(k, v)
        },
        delete: async (k: string) => {
          const had = users.delete(k)
          if (had) deletes += 1
          return had
        },
        deleteMany: async (keys: readonly string[]) => {
          let count = 0
          for (const k of keys) {
            if (users.delete(k)) count += 1
          }
          deletes += count
          return count
        },
        update: async (k: string, fn: (current: StoredUserName) => StoredUserName) => {
          const cur = users.get(k)
          if (!cur) throw new Error(`missing key ${k}`)
          const next = fn(cur)
          puts += 1
          users.set(k, next)
          return next
        },
      }),
      close: async () => {},
    }),
  }
  return {
    storage,
    users,
    stats: () => ({ puts, deletes }),
  }
}

function makeLogger() {
  const logs: { level: string; args: unknown[] }[] = []
  return {
    logs,
    debug: (...args: unknown[]) => { logs.push({ level: 'debug', args }) },
    info: (...args: unknown[]) => { logs.push({ level: 'info', args }) },
    warn: (...args: unknown[]) => { logs.push({ level: 'warn', args }) },
  }
}

function makeMessage(options: {
  id?: string
  seq?: number
  chat?: ImChatKey
  chatType?: ChatRef['type']
  senderId: string
  senderName?: string
  self?: boolean
  isBot?: boolean
  mentions?: { id: string; name?: string }[]
  quote?: { key: ImMessageKey; sender?: { id: string; name?: string; isBot?: boolean }; text?: string }
  text?: string
}): ImMessage {
  const chat = options.chat ?? GROUP_CHAT
  const chatId = chat.slice(chat.indexOf('|') + 1)
  const msgId = options.id ?? `om_${options.seq ?? 1}`
  return {
    key: `${BOT_ID}|${msgId}` as ImMessageKey,
    seq: options.seq ?? 1,
    chat: {
      key: chat,
      bot: BOT_ID,
      ref: { id: chatId, type: options.chatType ?? 'group' },
      source: 'team' as ImMessage['chat']['source'],
    },
    sender: {
      id: options.senderId,
      ...options.senderName === undefined ? {} : { name: options.senderName },
      ...options.isBot === undefined ? {} : { isBot: options.isBot },
      self: options.self ?? false,
    },
    content: { type: 'message', attrs: {}, children: [] },
    text: options.text ?? 'hello',
    ...options.quote === undefined ? {} : { quote: options.quote },
    mentions: {
      self: false,
      all: false,
      users: options.mentions ?? [],
    },
    addressed: true,
    time: 1_700_000_000_000,
    via: options.self ? 'self' : 'platform',
  }
}

function makeImHost(options: {
  messages?: ImMessage[]
  members?: ImHostLike['members']
  bot?: Bot
} = {}): ImHostLike & { add(msg: ImMessage): void } {
  const list = [...options.messages ?? []]
  const byKey = new Map<ImMessageKey, ImMessage>(list.map(m => [m.key, m]))
  return {
    add(msg: ImMessage) {
      list.push(msg)
      byKey.set(msg.key, msg)
    },
    history: {
      get: key => byKey.get(key),
      before: (chat, seq, limit) => list
        .filter(m => m.chat.key === chat && m.seq < seq)
        .sort((a, b) => a.seq - b.seq)
        .slice(-limit),
    },
    ...options.members === undefined ? {} : { members: options.members },
    ...options.bot === undefined ? {} : { bot: () => options.bot! },
  }
}

function makeBot(contactGet?: (userId: string, query?: { user_id_type?: string }) => Promise<unknown>): Bot {
  return {
    id: BOT_ID,
    platform: 'feishu',
    selfId: BOT_SELF_ID,
    ...contactGet === undefined ? {} : { internal: { contact: { user: { get: contactGet } } } },
  } as unknown as Bot
}

function makeEvent(message: ImMessage, bot: Bot): ImMessageEvent {
  return {
    message,
    source: { id: 'team', bot: BOT_ID, writable: true, store: 'all' },
    bot,
    reply: async () => ({ status: 'confirmed' }),
    send: async () => ({ status: 'confirmed' }),
    deliver: async () => {},
  } as unknown as ImMessageEvent
}

const okOutcome: ImOutcome = { kind: 'handled', by: 'test' }

test('pure helpers: stripIdSuffix, isUsableName, formatUserName, isPermissionError', () => {
  assert.equal(stripIdSuffix('张三(ou_1)', 'ou_1'), '张三')
  assert.equal(stripIdSuffix('  张三 (ou_1)  ', 'ou_1'), '张三')
  assert.equal(stripIdSuffix('Alice (Team A)(ou_1)', 'ou_1'), 'Alice (Team A)')
  assert.equal(stripIdSuffix('张三', 'ou_1'), '张三')

  assert.equal(isUsableName('张三', 'ou_1'), true)
  assert.equal(isUsableName('张三(ou_1)', 'ou_1'), true)
  assert.equal(isUsableName('ou_1', 'ou_1'), false)
  assert.equal(isUsableName('@_user_1', 'ou_1'), false)
  assert.equal(isUsableName('@_all', 'ou_1'), false)
  assert.equal(isUsableName('   ', 'ou_1'), false)
  assert.equal(isUsableName(undefined, 'ou_1'), false)

  assert.equal(formatUserName('张三', 'ou_1', true), '张三(ou_1)')
  assert.equal(formatUserName('张三(ou_1)', 'ou_1', true), '张三(ou_1)')
  assert.equal(formatUserName('张三', 'ou_1', false), '张三')
  assert.equal(formatUserName('张三(ou_1)', 'ou_1', false), '张三')
  assert.equal(formatUserName('ou_1', 'ou_1', true), 'ou_1')

  assert.equal(isPermissionError({ code: 99991672, message: 'Access denied' }), true)
  assert.equal(isPermissionError({ status: 403 }), true)
  assert.equal(isPermissionError(new Error('GET /contact/v3/users answered code 41050: no user authority')), true)
  assert.equal(isPermissionError(new Error('network timeout')), false)
})

test('group roster sync: paginates, deduplicates single-flight, respects cooldown, and backfills recent history', async () => {
  let memberCalls = 0
  let currentNow = 10_000
  const oldMsg1 = makeMessage({ id: 'om_1', seq: 1, senderId: 'ou_alice' })
  const oldMsg2 = makeMessage({ id: 'om_2', seq: 2, senderId: BOT_SELF_ID, senderName: 'TestBot', self: true })
  const newMsg = makeMessage({ id: 'om_3', seq: 3, senderId: 'ou_bob' })
  const im = makeImHost({
    messages: [oldMsg1, oldMsg2, newMsg],
    members: async (_chat, cursor): Promise<MembersPage> => {
      memberCalls += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      if (cursor === undefined) {
        return { data: [{ id: 'ou_alice', name: 'Alice' }], next: 'p2' }
      }
      return { data: [{ id: 'ou_bob', name: 'Bob' }] }
    },
  })
  const mem = makeMemoryStorage()
  const bot = makeBot()
  const host = new ImUserNamesHost({
    im,
    storage: mem.storage,
    logger: makeLogger(),
    config: makeConfig(),
    now: () => currentNow,
  })
  await host.open()

  // Concurrent resolve calls for the same chat share a single paginated roster fetch (2 pages total).
  const [r1, r2] = await Promise.all([
    host.resolve(BOT_ID, 'ou_bob', { chatKey: GROUP_CHAT, chatType: 'group', bot }),
    host.resolve(BOT_ID, 'ou_alice', { chatKey: GROUP_CHAT, chatType: 'group', bot }),
  ])
  assert.equal(r1, 'Bob')
  assert.equal(r2, 'Alice')
  assert.equal(memberCalls, 2)

  // Recent in-memory history was backfilled with Name(id), while bot self message kept its bare name.
  assert.equal(oldMsg1.sender.name, 'Alice(ou_alice)')
  assert.equal(oldMsg2.sender.name, 'TestBot')

  // Subsequent handleMessage hits memory cache with zero additional member calls.
  let nextCalled = false
  const outcome = await host.handleMessage(makeEvent(newMsg, bot), async () => {
    nextCalled = true
    assert.equal(newMsg.sender.name, 'Bob(ou_bob)')
    return okOutcome
  })
  assert.equal(nextCalled, true)
  assert.deepEqual(outcome, okOutcome)
  assert.equal(memberCalls, 2)

  // Missing user inside cooldown window does not re-trigger roster fetch.
  const ghost = makeMessage({ id: 'om_4', seq: 4, senderId: 'ou_ghost' })
  await host.handleMessage(makeEvent(ghost, bot), async () => okOutcome)
  assert.equal(ghost.sender.name, undefined)
  assert.equal(memberCalls, 2)

  await host.flush()
  assert.equal(mem.users.get(`${BOT_ID}|ou_alice`)?.name, 'Alice')
  assert.equal(mem.users.get(`${BOT_ID}|ou_bob`)?.name, 'Bob')
  await host.dispose()
})

test('passive mention learning resolves later sender with zero API calls and keeps satori/receive payload clean', async () => {
  let memberCalls = 0
  const im = makeImHost({
    members: async () => {
      memberCalls += 1
      return { data: [] }
    },
  })
  const mem = makeMemoryStorage()
  const bot = makeBot()
  const host = new ImUserNamesHost({
    im,
    storage: mem.storage,
    logger: makeLogger(),
    config: makeConfig(),
  })
  await host.open()

  const rawInbound = {
    id: 'om_10',
    chat: { id: 'oc_group_1', type: 'group' },
    sender: { id: 'ou_other' },
    content: { type: 'message', attrs: {}, children: [] },
    mentions: { self: false, all: false, users: [{ id: 'ou_zhang', name: '张三' }] },
    time: 1_700_000_000_000,
  }
  await host.onReceive({ type: 'message', bot, message: rawInbound } as unknown as Session)
  // satori/receive must not mutate sender before dsh-im computes intake digest.
  assert.equal((rawInbound.sender as { name?: string }).name, undefined)

  // Now ou_zhang sends a message -> resolved straight from mention cache without hitting members API.
  const msg = makeMessage({ id: 'om_11', seq: 11, senderId: 'ou_zhang' })
  await host.handleMessage(makeEvent(msg, bot), async () => okOutcome)
  assert.equal(msg.sender.name, '张三(ou_zhang)')
  assert.equal(memberCalls, 0)
  await host.dispose()
})

test('DM contact fallback resolves human user, skips bots, and circuit-breaks on permission error', async () => {
  let contactCalls = 0
  let failWithPermission = false
  const bot = makeBot(async (userId) => {
    contactCalls += 1
    if (failWithPermission) {
      throw Object.assign(new Error('GET /contact/v3/users answered code 99991672: Access denied'), { code: 99991672 })
    }
    if (userId === 'ou_dm_user') return { user: { name: '李四', en_name: 'Li Si' } }
    return {}
  })
  const im = makeImHost({ bot })
  const mem = makeMemoryStorage()
  const host = new ImUserNamesHost({
    im,
    storage: mem.storage,
    logger: makeLogger(),
    config: makeConfig(),
  })
  await host.open()

  // Human DM sender resolves via contact.user.get.
  const dmMsg = makeMessage({ id: 'om_20', seq: 1, chat: DM_CHAT, chatType: 'direct', senderId: 'ou_dm_user' })
  await host.handleMessage(makeEvent(dmMsg, bot), async () => okOutcome)
  assert.equal(dmMsg.sender.name, '李四(ou_dm_user)')
  assert.equal(contactCalls, 1)

  // Bot sender skips contact.user.get.
  const botMsg = makeMessage({ id: 'om_21', seq: 2, chat: DM_CHAT, chatType: 'direct', senderId: 'ou_alert_bot', isBot: true })
  await host.handleMessage(makeEvent(botMsg, bot), async () => okOutcome)
  assert.equal(botMsg.sender.name, undefined)
  assert.equal(contactCalls, 1)

  // Permission error trips circuit breaker so second unknown user skips contact API completely.
  failWithPermission = true
  const dmMsg2 = makeMessage({ id: 'om_22', seq: 3, chat: DM_CHAT, chatType: 'direct', senderId: 'ou_no_perm_1' })
  await host.handleMessage(makeEvent(dmMsg2, bot), async () => okOutcome)
  assert.equal(contactCalls, 2)
  assert.equal(dmMsg2.sender.name, undefined)

  const dmMsg3 = makeMessage({ id: 'om_23', seq: 4, chat: DM_CHAT, chatType: 'direct', senderId: 'ou_no_perm_2' })
  await host.handleMessage(makeEvent(dmMsg3, bot), async () => okOutcome)
  assert.equal(contactCalls, 2)
  await host.dispose()
})

test('static aliases override names (including bots) and support both scoped and bare keys', async () => {
  const bot = makeBot()
  const im = makeImHost({ bot })
  const mem = makeMemoryStorage()
  const host = new ImUserNamesHost({
    im,
    storage: mem.storage,
    logger: makeLogger(),
    config: makeConfig({
      aliases: {
        [`${BOT_ID}|ou_scoped_bot`]: '值班告警机器人',
        ou_bare_user: '管理员',
      },
    }),
  })
  await host.open()

  const m1 = makeMessage({ id: 'om_30', seq: 1, senderId: 'ou_scoped_bot', isBot: true })
  const m2 = makeMessage({ id: 'om_31', seq: 2, senderId: 'ou_bare_user', senderName: '旧名' })
  await host.handleMessage(makeEvent(m1, bot), async () => okOutcome)
  await host.handleMessage(makeEvent(m2, bot), async () => okOutcome)
  assert.equal(m1.sender.name, '值班告警机器人(ou_scoped_bot)')
  assert.equal(m2.sender.name, '管理员(ou_bare_user)')
  await host.dispose()
})

test('quote backfill copies quoted sender from same chat and formats non-self quoted sender', async () => {
  const bot = makeBot()
  const quotedUser = makeMessage({ id: 'om_40', seq: 1, senderId: 'ou_alice', senderName: 'Alice(ou_alice)' })
  const quotedSelf = makeMessage({ id: 'om_41', seq: 2, senderId: BOT_SELF_ID, senderName: 'TestBot', self: true })
  const otherChatMsg = makeMessage({ id: 'om_42', seq: 1, chat: DM_CHAT, chatType: 'direct', senderId: 'ou_secret', senderName: 'Secret(ou_secret)' })
  const im = makeImHost({ messages: [quotedUser, quotedSelf, otherChatMsg], bot })
  const mem = makeMemoryStorage({
    [`${BOT_ID}|ou_bob`]: { name: 'Bob', source: 'member', updatedAt: Date.now() },
  })
  const host = new ImUserNamesHost({
    im,
    storage: mem.storage,
    logger: makeLogger(),
    config: makeConfig(),
  })
  await host.open()

  // Reply to human message in same chat -> quote.sender backfilled.
  const reply1 = makeMessage({
    id: 'om_43', seq: 3, senderId: 'ou_bob',
    quote: { key: quotedUser.key, text: 'original' },
  })
  await host.handleMessage(makeEvent(reply1, bot), async () => okOutcome)
  assert.equal(reply1.sender.name, 'Bob(ou_bob)')
  assert.deepEqual(reply1.quote?.sender, { id: 'ou_alice', name: 'Alice(ou_alice)' })

  // Reply to bot's own message -> quote.sender keeps bare bot name without (id).
  const reply2 = makeMessage({
    id: 'om_44', seq: 4, senderId: 'ou_bob',
    quote: { key: quotedSelf.key, text: 'bot reply' },
  })
  await host.handleMessage(makeEvent(reply2, bot), async () => okOutcome)
  assert.deepEqual(reply2.quote?.sender, { id: BOT_SELF_ID, name: 'TestBot' })

  // Cross-chat quote key must not leak sender from another chat.
  const reply3 = makeMessage({
    id: 'om_45', seq: 5, senderId: 'ou_bob',
    quote: { key: otherChatMsg.key },
  })
  await host.handleMessage(makeEvent(reply3, bot), async () => okOutcome)
  assert.equal(reply3.quote?.sender, undefined)
  await host.dispose()
})

test('satori/receive enriches reactions (resolving chat from history) and keeps card interactions strictly cache-only', async () => {
  let memberCalls = 0
  const bot = makeBot()
  const targetMsg = makeMessage({ id: 'om_50', seq: 1, senderId: BOT_SELF_ID, senderName: 'TestBot', self: true })
  const im = makeImHost({
    messages: [targetMsg],
    bot,
    members: async (): Promise<MembersPage> => {
      memberCalls += 1
      return { data: [{ id: 'ou_reactor', name: '王五' }] }
    },
  })
  const mem = makeMemoryStorage()
  const host = new ImUserNamesHost({
    im,
    storage: mem.storage,
    logger: makeLogger(),
    config: makeConfig(),
  })
  await host.open()

  // Card button click for unknown user must NOT call live APIs (protecting 3s card callback budget).
  const clickSession = {
    type: 'interaction/button',
    bot,
    button: { id: 'btn_1', user: { id: 'ou_reactor' }, chat: { id: 'oc_group_1', type: 'group' } },
  } as unknown as Session
  await host.onReceive(clickSession)
  assert.equal(memberCalls, 0)
  assert.equal(clickSession.button?.user.name, undefined)

  // Reaction event omits chat_id (like Feishu); host resolves chat from stored message and syncs roster.
  const reactionSession = {
    type: 'reaction-added',
    bot,
    reaction: { message: { id: 'om_50' }, emoji: 'THUMBSUP', user: { id: 'ou_reactor' } },
  } as unknown as Session
  await host.onReceive(reactionSession)
  assert.equal(memberCalls, 1)
  assert.equal(reactionSession.reaction?.user?.name, '王五(ou_reactor)')

  // Now that ou_reactor is cached, card button clicks enrich synchronously with 0 API calls.
  const clickSession2 = {
    type: 'interaction/button',
    bot,
    button: { id: 'btn_2', user: { id: 'ou_reactor' }, chat: { id: 'oc_group_1', type: 'group' } },
  } as unknown as Session
  await host.onReceive(clickSession2)
  assert.equal(memberCalls, 1)
  assert.equal(clickSession2.button?.user.name, '王五(ou_reactor)')
  await host.dispose()
})

test('im/stored enriches on-demand im_read messages and includeId:false emits bare names', async () => {
  const bot = makeBot()
  const im = makeImHost({ bot })
  const mem = makeMemoryStorage({
    [`${BOT_ID}|ou_cached`]: { name: '赵六', source: 'member', updatedAt: Date.now() },
  })
  const host = new ImUserNamesHost({
    im,
    storage: mem.storage,
    logger: makeLogger(),
    config: makeConfig({ includeId: false }),
  })
  await host.open()

  const fetched = makeMessage({ id: 'om_60', seq: 60, senderId: 'ou_cached' })
  host.onStored(fetched)
  assert.equal(fetched.sender.name, '赵六')

  // Already-named sender (e.g. QQ) with includeId:true formats cleanly without double-wrapping.
  const hostWithId = new ImUserNamesHost({
    im,
    storage: mem.storage,
    logger: makeLogger(),
    config: makeConfig({ includeId: true }),
  })
  await hostWithId.open()
  const qqLike = makeMessage({ id: 'om_61', seq: 61, senderId: 'u_qq_1', senderName: '小明' })
  await hostWithId.handleMessage(makeEvent(qqLike, bot), async () => okOutcome)
  assert.equal(qqLike.sender.name, '小明(u_qq_1)')
  // Re-running handleMessage on the same already-formatted message is idempotent.
  await hostWithId.handleMessage(makeEvent(qqLike, bot), async () => okOutcome)
  assert.equal(qqLike.sender.name, '小明(u_qq_1)')

  await host.dispose()
  await hostWithId.dispose()
})

test('durable persistence, stale-while-error, LRU eviction, negative cache reset on mention, and fault isolation', async () => {
  let currentNow = 100_000
  let membersShouldHang = false
  const bot = makeBot()
  const im = makeImHost({
    bot,
    members: async (_chat, _cursor, _limit, signal): Promise<MembersPage> => {
      if (membersShouldHang) {
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      throw new Error('upstream 500')
    },
  })
  const mem = makeMemoryStorage({
    [`${BOT_ID}|ou_stale`]: { name: '老陈', source: 'member', updatedAt: 1_000 },
  })
  const host = new ImUserNamesHost({
    im,
    storage: mem.storage,
    logger: makeLogger(),
    config: makeConfig({
      ttlMs: 10_000,
      maxEntries: 2,
      lookupTimeoutMs: 100,
      chatSyncCooldownMs: 60_000,
    }),
    now: () => currentNow,
  })
  await host.open()

  // Stale entry (age 99s > ttl 10s): live lookup fails -> degrades gracefully to stale name instead of bare ID.
  const mStale = makeMessage({ id: 'om_70', seq: 1, senderId: 'ou_stale' })
  let nextCalls = 0
  await host.handleMessage(makeEvent(mStale, bot), async () => {
    nextCalls += 1
    return okOutcome
  })
  assert.equal(nextCalls, 1)
  assert.equal(mStale.sender.name, '老陈(ou_stale)')

  // Timeout never blocks or rejects handleMessage.
  currentNow += 120_000
  membersShouldHang = true
  const mHang = makeMessage({ id: 'om_71', seq: 2, senderId: 'ou_unknown' })
  await host.handleMessage(makeEvent(mHang, bot), async () => {
    nextCalls += 1
    return okOutcome
  })
  assert.equal(nextCalls, 2)
  assert.equal(mHang.sender.name, undefined)

  // Even while negative-cached, passive mention immediately populates and clears negative cache.
  host.remember(BOT_ID, 'ou_unknown', '新同事', 'mention')
  assert.equal(host.format(BOT_ID, 'ou_unknown'), '新同事(ou_unknown)')

  // LRU eviction caps storage at maxEntries (2).
  host.remember(BOT_ID, 'ou_third', '第三人', 'mention')
  await host.flush()
  assert.equal(mem.users.size, 2)
  assert.equal(mem.users.has(`${BOT_ID}|ou_stale`), false)
  assert.equal(mem.users.get(`${BOT_ID}|ou_unknown`)?.name, '新同事')
  assert.equal(mem.users.get(`${BOT_ID}|ou_third`)?.name, '第三人')

  // Redundant remember with same name within half TTL skips durable write.
  const beforePuts = mem.stats().puts
  host.remember(BOT_ID, 'ou_third', '第三人', 'mention')
  await host.flush()
  assert.equal(mem.stats().puts, beforePuts)

  await host.dispose()
})

test('Cordis integration: ImUserNamesService mounts via Service.init, prepends im/message, and exposes ctx.imUserNames', async () => {
  const ctx = new Context()
  const bot = makeBot()
  const im = makeImHost({
    bot,
    members: async (): Promise<MembersPage> => ({
      data: [{ id: 'ou_cordis_user', name: '陈七' }],
    }),
  })
  const mem = makeMemoryStorage()

  ctx.provide('im', im as never)
  ctx.provide('storageDomain', mem.storage as never)

  // Register a downstream listener (simulating im-dispatch) BEFORE mounting ImUserNamesService.
  let downstreamSeenSender: string | undefined
  ctx.on('im/message', async (event, next) => {
    downstreamSeenSender = event.message.sender.name
    return await next()
  })

  const cfg = Config({})
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.includeId, true)

  const fork = ctx.plugin(ImUserNamesService, cfg)
  for (let waited = 0; ctx.get('imUserNames') === undefined && waited < 5_000; waited += 10) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  const service = ctx.get('imUserNames') as ImUserNamesService
  assert.ok(service instanceof ImUserNamesService)
  const msg = makeMessage({ id: 'om_cordis_1', seq: 1, senderId: 'ou_cordis_user' })
  const outcome = await ctx.waterfall(
    'im/message',
    makeEvent(msg, bot),
    async (): Promise<ImOutcome> => okOutcome,
  )
  assert.deepEqual(outcome, okOutcome)
  assert.equal(downstreamSeenSender, '陈七(ou_cordis_user)')
  assert.equal(service.lookup(BOT_ID, 'ou_cordis_user'), '陈七')
  assert.equal(service.format(BOT_ID, 'ou_cordis_user'), '陈七(ou_cordis_user)')

  await fork.dispose()
})

