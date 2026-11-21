/**
 * Automatic human-readable session titling for per-chat routers and background task workers.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  DISPATCHER_CHAT_PREFIX, DISPATCHER_KEY, DISPATCHER_TOPIC_PREFIX, DispatchHost, SessionTitleSynchronizer,
  ImDispatchService, cleanTitleText, formatRouterSessionTitle, formatTaskSessionTitle, shortPlatformId,
  shouldApplyAutoTitle,
} from '../src/index.ts'
import { DispatchConfig } from '../src/config.ts'
import type {
  ImTaskLike, LiveSessionLike, PromptSectionLike, SessionQueryLike, SessionStoreLike, SessionTitleServiceLike,
  SessionTitleSnapshotLike, SystemPromptLike,
} from '../src/types.ts'
import {
  BOT, CHAT_KEY, COMPOSITION, FakeIm, FakeLogger, FakeStorage, FakeTasks, FakeTools, boot,
} from './dispatch-fakes.ts'

class FakeSessionInfra {
  readonly live = new Map<string, LiveSessionLike>()
  readonly persisted = new Map<string, Array<{ type: string; data?: unknown }>>()
  readonly flushed: string[] = []
  readonly openedAgents: string[] = []
  readonly renameCalls: Array<{ id: string; title: string }> = []
  readonly disposedObservations: string[] = []
  inSynchronousAnnouncement = false

  readonly store: SessionStoreLike = {
    get: id => this.live.get(id),
    list: () => [...this.live.values()],
    flush: async (session) => {
      this.flushed.push(session.id)
      return true
    },
  }

  readonly titleService: SessionTitleServiceLike = {
    get: (session) => {
      const events = this.persisted.get(session.id) ?? []
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i]
        if (ev?.type === 'session/title') {
          return ev.data as SessionTitleSnapshotLike
        }
      }
      return undefined
    },
    rename: (session, title) => {
      if (this.inSynchronousAnnouncement) {
        throw new Error(`session "${session.id}" is read-only during session/created announcement`)
      }
      if (this.live.get(session.id) !== session) {
        throw new Error(`session "${session.id}" is not live in this store`)
      }
      this.renameCalls.push({ id: session.id, title })
      const snapshot: SessionTitleSnapshotLike = { title, source: { kind: 'user' } }
      const events = this.persisted.get(session.id) ?? []
      events.push({ type: 'session/title', data: snapshot })
      this.persisted.set(session.id, events)
      return snapshot
    },
  }

  readonly query: SessionQueryLike = {
    observeSession: async (id) => {
      const events = this.persisted.get(id)
      if (events === undefined) {
        throw new Error(`session "${id}" not found`)
      }
      return {
        events,
        [Symbol.dispose]: () => {
          this.disposedObservations.push(id)
        },
      }
    },
  }

  attachAgentSupport(im: FakeIm): void {
    const infra = this
    const sessionsObj = im.sessions as FakeIm['sessions'] & { agent?: (target: string) => Promise<{ session: LiveSessionLike }> }
    sessionsObj.agent = async function (this: unknown, target: string) {
      if (this !== sessionsObj) {
        throw new TypeError("Cannot read properties of undefined (reading 'retired')")
      }
      const record = im.sessions.get(target)
      if (record === undefined) throw new Error(`unknown IM session ${target}`)
      infra.openedAgents.push(record.sessionId)
      const session: LiveSessionLike = infra.live.get(record.sessionId) ?? { id: record.sessionId }
      infra.live.set(record.sessionId, session)
      return { session }
    }
  }
}

test('formatRouterSessionTitle and formatTaskSessionTitle format group, DM, topic, legacy, and task titles cleanly', () => {
  const longGroupKey = `${BOT}|oc_0a1b2c3d4e5f60718293a4b5c6d7e8f9`
  assert.equal(shortPlatformId('oc_0a1b2c3d4e5f60718293a4b5c6d7e8f9'), 'oc_0a1b2c…e8f9')
  assert.equal(cleanTitleText('  hello   world \n line  ', 11), 'hello worl…')

  assert.equal(formatRouterSessionTitle(DISPATCHER_KEY, () => undefined), '[全局路由 · 旧]')
  assert.equal(
    formatRouterSessionTitle(`${DISPATCHER_CHAT_PREFIX}${longGroupKey}`, () => undefined),
    '[群路由] oc_0a1b2c…e8f9',
  )
  assert.equal(
    formatRouterSessionTitle(`${DISPATCHER_CHAT_PREFIX}${longGroupKey}`, () => ({ name: 'test group', type: 'group' })),
    '[群路由] test group',
  )
  assert.equal(
    formatRouterSessionTitle(`${DISPATCHER_CHAT_PREFIX}${BOT}|dm_1`, () => ({ name: 'Alice', type: 'direct' })),
    '[私聊] Alice',
  )
  assert.equal(
    formatRouterSessionTitle(
      `${DISPATCHER_TOPIC_PREFIX}${longGroupKey}:om_1234567890abcdef1234`,
      () => ({ name: '研发大群', type: 'topic' }),
    ),
    '[话题路由] 研发大群 · #om_123456…1234',
  )

  const task: ImTaskLike = {
    id: 5,
    title: '做一个好玩的  自包含像素风\n小游戏（HTML）',
    session: 'im-task:5',
    owner: 'im-dispatch:chat:x',
    chat: longGroupKey,
    createdAt: 1,
    updatedAt: 1,
  }
  assert.equal(formatTaskSessionTitle(task), '#5 做一个好玩的 自包含像素风 小游戏（HTML）')
  assert.equal(
    formatTaskSessionTitle(task, () => ({ name: 'test group', type: 'group' })),
    '#5 做一个好玩的 自包含像素风 小游戏（HTML） · test group',
  )
})

test('shouldApplyAutoTitle allows initial and auto-generated upgrades while preserving manual edits', () => {
  assert.equal(shouldApplyAutoTitle(undefined, '[群路由] test group', undefined), true)
  assert.equal(shouldApplyAutoTitle('[群路由] test group', '[群路由] test group', undefined), false)
  assert.equal(shouldApplyAutoTitle('[群路由] oc_0a1b2c…e8f9', '[群路由] test group', undefined), true)
  assert.equal(shouldApplyAutoTitle('#5 像素游戏', '#5 像素游戏 · test group', '#5 像素游戏'), true)
  assert.equal(shouldApplyAutoTitle('我的自定义名字', '[群路由] test group', '[群路由] oc_0a1b2c…e8f9'), false)
})

test('SessionTitleSynchronizer defers past synchronous session/created window and upgrades on chat name discovery', async () => {
  const infra = new FakeSessionInfra()
  const harness = boot({ chatNames: { oc_known: '配置群名' } })
  infra.attachAgentSupport(harness.im)

  let getChatCalls = 0
  let releaseDynChat!: (name: string | undefined) => void
  const dynChatLookup = new Promise<{ name?: string }>((resolve) => {
    releaseDynChat = name => resolve(name === undefined ? {} : { name })
  })
  harness.im.bot = () => ({
    api: {
      getChat: async (chatId) => {
        getChatCalls += 1
        if (chatId === 'dynamic') return await dynChatLookup
        return {}
      },
    },
  })

  let syncRef: SessionTitleSynchronizer | undefined
  const host = new DispatchHost({
    im: harness.im,
    tasks: harness.tasks,
    storage: harness.storage,
    logger: harness.logger,
    config: harness.config,
    chronicle: harness.chronicle,
    ephemeral: harness.ephemeral,
    onChatUpdated: (chatKey) => { void syncRef?.syncChat(chatKey) },
  })
  const sync = new SessionTitleSynchronizer({
    host,
    im: harness.im,
    sessions: () => infra.store,
    sessionTitle: () => infra.titleService,
    sessionQuery: () => infra.query,
    logger: harness.logger,
  })
  syncRef = sync

  // 1. Configured chatNames overrides right away on deferred session/created
  const knownChat = `${BOT}|oc_known`
  const knownMsg = harness.im.store('hi', { chatKey: knownChat })
  await host.handle({
    message: knownMsg,
    deliver: (target, opts) => harness.im.sessions.deliver(target, { ...opts, id: knownMsg.key, content: [knownMsg] }),
  }, async () => ({ kind: 'ignored' }))
  const knownRouter = host.routerFor(knownChat)!
  const liveKnown: LiveSessionLike = { id: knownRouter.sessionId }
  infra.live.set(liveKnown.id, liveKnown)
  infra.persisted.set(liveKnown.id, [])

  // Simulate SessionStore.announce read-only synchronous phase
  infra.inSynchronousAnnouncement = true
  sync.onSessionCreated(liveKnown)
  infra.inSynchronousAnnouncement = false
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(infra.titleService.get(liveKnown)?.title, '[群路由] 配置群名')
  assert.ok(infra.flushed.includes(liveKnown.id))

  // 2. Dynamic bot.api.getChat learns name asynchronously and upgrades the fallback auto-title
  const dynChat = `${BOT}|dynamic`
  const dynMsg = harness.im.store('ping', { chatKey: dynChat })
  await host.handle({
    message: dynMsg,
    deliver: (target, opts) => harness.im.sessions.deliver(target, { ...opts, id: dynMsg.key, content: [dynMsg] }),
  }, async () => ({ kind: 'ignored' }))
  const dynRouter = host.routerFor(dynChat)!
  const liveDyn: LiveSessionLike = { id: dynRouter.sessionId }
  infra.live.set(liveDyn.id, liveDyn)
  infra.persisted.set(liveDyn.id, [])
  sync.onSessionCreated(liveDyn)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(infra.titleService.get(liveDyn)?.title, '[群路由] dynamic')

  releaseDynChat('动态群名')
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(getChatCalls, 1)
  assert.equal(infra.titleService.get(liveDyn)?.title, '[群路由] 动态群名')

  // 3. Manual operator rename is preserved even when chat updates again
  infra.titleService.rename(liveDyn, '我的自定义群名')
  await sync.syncChat(dynChat)
  assert.equal(infra.titleService.get(liveDyn)?.title, '我的自定义群名')

  // 4. DM sender name updates title automatically
  const dmChat = `${BOT}|p2p_1`
  const dmMsg = harness.im.store('dm hello', {
    chatKey: dmChat,
    chat: { key: dmChat, bot: BOT, ref: { id: 'p2p_1', type: 'direct' }, source: 'team' },
    sender: { id: 'u-bob', name: 'Bob', self: false },
  })
  await host.handle({
    message: dmMsg,
    deliver: (target, opts) => harness.im.sessions.deliver(target, { ...opts, id: dmMsg.key, content: [dmMsg] }),
  }, async () => ({ kind: 'ignored' }))
  const dmRouter = host.routerFor(dmChat)!
  const liveDm: LiveSessionLike = { id: dmRouter.sessionId }
  infra.live.set(liveDm.id, liveDm)
  infra.persisted.set(liveDm.id, [])
  await sync.syncSession(liveDm.id)
  assert.equal(infra.titleService.get(liveDm)?.title, '[私聊] Bob')

  sync.dispose()
  await host.dispose()
})

test('SessionTitleSynchronizer.backfill titles persisted cold sessions without opening unused or custom-named sessions', async () => {
  const infra = new FakeSessionInfra()
  const im = new FakeIm()
  infra.attachAgentSupport(im)
  const tasks = new FakeTasks(im)
  const storage = new FakeStorage()
  const logger = new FakeLogger()
  const config = DispatchConfig.parse({
    main: COMPOSITION,
    worker: COMPOSITION,
    chatNames: { oc_cold: '冷启动群' },
  })

  // Ensure routers + start one cold task
  const router1 = await im.sessions.ensure({
    key: `${DISPATCHER_CHAT_PREFIX}${BOT}|oc_cold`,
    owner: 'dispatch',
    composition: COMPOSITION,
    bindings: [{ chat: `${BOT}|oc_cold`, writable: false, home: true }],
  })
  const unusedRouter = await im.sessions.ensure({
    key: `${DISPATCHER_CHAT_PREFIX}${BOT}|oc_unused`,
    owner: 'dispatch',
    composition: COMPOSITION,
    bindings: [{ chat: `${BOT}|oc_unused`, writable: false, home: true }],
  })
  const customRouter = await im.sessions.ensure({
    key: `${DISPATCHER_CHAT_PREFIX}${BOT}|oc_custom`,
    owner: 'dispatch',
    composition: COMPOSITION,
    bindings: [{ chat: `${BOT}|oc_custom`, writable: false, home: true }],
  })
  const alreadyTitledRouter = await im.sessions.ensure({
    key: `${DISPATCHER_CHAT_PREFIX}${BOT}|oc_done`,
    owner: 'dispatch',
    composition: COMPOSITION,
    bindings: [{ chat: `${BOT}|oc_done`, writable: false, home: true }],
  })
  const task1 = await tasks.start({
    owner: router1.sessionId,
    title: '历史任务回填',
    brief: 'brief',
    placement: { bindings: [{ chat: `${BOT}|oc_cold`, writable: true, home: true }] },
  })

  // Persisted on disk (not live in infra.store):
  // - router1: untitled -> should open agent & rename
  // - task1: untitled -> should open agent & rename
  // - unusedRouter: absent from persisted -> MUST NOT open agent
  // - customRouter: custom human title -> MUST NOT open agent
  // - alreadyTitledRouter: already matches desired -> MUST NOT open agent
  infra.persisted.set(router1.sessionId, [])
  infra.persisted.set(task1.session, [])
  infra.persisted.set(customRouter.sessionId, [{ type: 'session/title', data: { title: '人工改名', source: { kind: 'user' } } }])
  infra.persisted.set(alreadyTitledRouter.sessionId, [{ type: 'session/title', data: { title: '[群路由] oc_done', source: { kind: 'user' } } }])

  const host = new DispatchHost({ im, tasks, storage, logger, config })
  const sync = new SessionTitleSynchronizer({
    host,
    im,
    sessions: () => infra.store,
    sessionTitle: () => infra.titleService,
    sessionQuery: () => infra.query,
    logger,
  })

  await sync.backfill()

  assert.deepEqual(infra.openedAgents.sort(), [router1.sessionId, task1.session].sort())
  assert.equal(infra.live.has(unusedRouter.sessionId), false)
  assert.equal(infra.live.has(customRouter.sessionId), false)
  assert.equal(infra.live.has(alreadyTitledRouter.sessionId), false)
  assert.equal(infra.titleService.get({ id: router1.sessionId })?.title, '[群路由] 冷启动群')
  assert.equal(infra.titleService.get({ id: task1.session })?.title, '#1 历史任务回填 · 冷启动群')
  // Verify every observation lease was disposed
  assert.equal(infra.disposedObservations.length, 4)

  sync.dispose()
  await host.dispose()
})

test('the plugin renames task worker sessions automatically on im/task/started and im/task/updated', async () => {
  const ctx = new Context()
  const infra = new FakeSessionInfra()
  const im = new FakeIm()
  const tasks = new FakeTasks(im)
  const tools = new FakeTools()
  const sections: PromptSectionLike[] = []
  const systemPrompt: SystemPromptLike = { section: (section) => { sections.push(section); return () => {} } }

  ctx.provide('im', im as never)
  ctx.provide('imTasks', tasks)
  ctx.provide('storageDomain', new FakeStorage())
  ctx.provide('tools', tools)
  ctx.provide('systemPrompt', systemPrompt)
  ctx.provide('sessions' as never, infra.store as never)
  ctx.provide('sessionTitle' as never, infra.titleService as never)
  ctx.provide('sessionQuery' as never, infra.query as never)

  ctx.plugin(ImDispatchService, { main: COMPOSITION, worker: COMPOSITION, chatNames: { chat: '测试群' } } as never)
  for (let waited = 0; tools.tools.size === 0 && waited < 20_000; waited += 20) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  const msg = im.store('帮我查日志')
  await ctx.waterfall('im/message', {
    message: msg,
    deliver: (target, opts) => im.sessions.deliver(target, { ...opts, id: msg.key, content: [msg] }),
  }, async () => ({ kind: 'ignored' as const }))

  const router = im.sessions.get(`${DISPATCHER_CHAT_PREFIX}${CHAT_KEY}`)!
  const routerLive: LiveSessionLike = { id: router.sessionId }
  infra.live.set(routerLive.id, routerLive)
  infra.persisted.set(routerLive.id, [])
  ctx.emit('session/created', routerLive)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(infra.titleService.get(routerLive)?.title, '[群路由] 测试群')

  const createTaskTool = tools.tools.get('create_task')!
  const created = await createTaskTool.execute(
    { title: '排查报错日志', messages: ['#1'] },
    { callId: 'c1', agent: { session: { id: router.sessionId } }, signal: new AbortController().signal },
  ) as { id: number }

  const taskObj = tasks.get(created.id)!
  const workerLive: LiveSessionLike = { id: taskObj.session }
  infra.live.set(workerLive.id, workerLive)
  infra.persisted.set(workerLive.id, [])
  ctx.emit('im/task/started', taskObj)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(infra.titleService.get(workerLive)?.title, `#${created.id} 排查报错日志 · 测试群`)

  taskObj.title = '排查报错日志（已更新）'
  ctx.emit('im/task/updated', taskObj)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(infra.titleService.get(workerLive)?.title, `#${created.id} 排查报错日志（已更新） · 测试群`)
})
