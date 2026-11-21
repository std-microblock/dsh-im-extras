import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionAuthHost } from '../src/host.ts'
import type { CapabilityAcquireContext, CapabilityProvider } from '../src/api.ts'
import { applyTools } from '../src/tools.ts'

const CHAT = 'lark:test|oc_1'

function fakeHarness() {
  const listeners = new Map<string, { fn: (...args: any[]) => any; prepend?: boolean }[]>()
  const tables = new Map<string, Map<string, unknown>>()
  const domain = {
    table: (name: string) => {
      let t = tables.get(name)
      if (!t) tables.set(name, (t = new Map()))
      return {
        get: (k: string) => structuredClone(t!.get(k)),
        put: async (k: string, v: unknown) => { t!.set(k, structuredClone(v)) },
        delete: async (k: string) => t!.delete(k),
        keys: () => t!.keys(),
        entries: () => [...t!.entries()].map(([k, v]) => [k, structuredClone(v)] as [string, unknown]),
      }
    },
    close: async () => {},
  }

  const tools = new Map<string, { def: any; opts: any }>()
  const execEnvContributors = new Map<string, any>()
  const promptSections: any[] = []
  const cardActions = new Map<string, (ctx: any) => unknown>()
  const cardGuards: ((ctx: any) => any)[] = []
  const pushedEvents: { cardId: string; channel: string; data: unknown }[] = []

  const sessions = new Map<string, any>()
  const triggers = new Map<string, any>()
  const messages = new Map<string, any>()
  const deliveries: { session: string; delivery: any }[] = []

  const imCards = {
    registerAction: (name: string, handler: (ctx: any) => unknown) => {
      cardActions.set(name, handler)
      return () => { cardActions.delete(name) }
    },
    registerGuard: (guard: (ctx: any) => any) => {
      cardGuards.push(guard)
      return () => {
        const i = cardGuards.indexOf(guard)
        if (i >= 0) cardGuards.splice(i, 1)
      }
    },
    pushEvent: async (cardId: string, channel: string, data: unknown) => {
      pushedEvents.push({ cardId, channel, data })
      return true
    },
  }

  const execEnv = {
    register: (contributor: any) => {
      execEnvContributors.set(contributor.name, contributor)
      return () => { execEnvContributors.delete(contributor.name) }
    },
  }

  const toolsService = {
    register: (def: any, opts: any = {}) => {
      tools.set(def.name, { def, opts })
      return () => { tools.delete(def.name) }
    },
  }

  const systemPrompt = {
    section: (sec: any) => {
      promptSections.push(sec)
      return () => {}
    },
  }

  const services: Record<string, any> = { imCards, execEnv, tools: toolsService, systemPrompt }

  const ctx: any = {
    storageDomain: { open: async () => domain },
    logger: { info() {}, warn() {}, error() {} },
    get: (name: string) => services[name],
    on: (name: string, fn: any, opts?: boolean | { prepend?: boolean }) => {
      const prepend = typeof opts === 'boolean' ? opts : opts?.prepend === true
      const list = listeners.get(name) ?? []
      if (prepend) list.unshift({ fn, prepend })
      else list.push({ fn, prepend })
      listeners.set(name, list)
      return () => true
    },
    inject: (deps: string[], fn: (scoped: any) => void) => {
      const scoped: any = {
        ...ctx,
        tools: toolsService,
        systemPrompt,
        effect: (eff: () => () => void) => { eff(); return () => {} },
      }
      for (const dep of deps) scoped[dep] = services[dep]
      fn(scoped)
      return () => {}
    },
  }

  const im: any = {
    history: {
      get: (key: string) => messages.get(key),
    },
    sessions: {
      of: (id: string) => {
        const direct = sessions.get(id)
        if (direct !== undefined) return direct
        for (const rec of sessions.values()) {
          if (rec.subagents?.includes(id)) return rec
        }
        return undefined
      },
      get: (id: string) => sessions.get(id),
      forChat: (chat: string) => [...sessions.values()].filter(s => s.bindings?.some((b: any) => b.chat === chat)),
      trigger: (id: string) => triggers.get(id),
      deliver: async (session: string, delivery: any) => { deliveries.push({ session, delivery }) },
    },
  }

  const emit = async (name: string, ...args: any[]) => {
    for (const entry of listeners.get(name) ?? []) {
      await entry.fn(...args)
    }
  }

  const runWaterfall = async (name: string, ...args: any[]) => {
    const list = listeners.get(name) ?? []
    let i = 0
    const next = async (): Promise<any> => {
      if (i < list.length) {
        const entry = list[i++]!
        return await entry.fn(...args, next)
      }
      return undefined
    }
    return await next()
  }

  const runSyncWaterfall = (name: string, seed: any, ...args: any[]) => {
    const list = listeners.get(name) ?? []
    let i = 0
    const next = (): any => {
      if (i < list.length) {
        const entry = list[i++]!
        return entry.fn(...args, next)
      }
      return seed
    }
    return next()
  }

  return {
    ctx, im, tables, sessions, triggers, messages, deliveries, tools, execEnvContributors,
    promptSections, cardActions, cardGuards, pushedEvents, emit, runWaterfall, runSyncWaterfall,
  }
}

test('exclusivity, collaborator delegation by owner & collaborator, schedule-turn guard, and owner unkickable', async () => {
  const h = fakeHarness()
  h.sessions.set('im-disp', { sessionId: 'im-disp', key: 'dispatch:main', owner: 'dispatch', bindings: [{ chat: CHAT, writable: false }] })
  h.sessions.set('im-task-1', {
    sessionId: 'im-task-1', key: 'task:1', owner: 'dispatch', parent: 'im-disp',
    bindings: [{ chat: CHAT, writable: true, home: true, thread: 'om_root1' }],
    subagents: ['sub-1'],
  })

  const host = new SessionAuthHost(h.ctx, h.im, { refusalThrottleMs: 15_000 })
  await host.open()

  // Before exclusivity anyone may interact.
  assert.equal(host.isExclusive('im-task-1'), false)
  assert.equal(host.canInteract('im-task-1', 'ou_stranger'), true)

  const grantTool = h.tools.get('grant_session_access')!
  const revokeTool = h.tools.get('revoke_session_access')!
  const getTool = h.tools.get('get_session_access')!

  // Tools are active for task worker (and subagents), hidden for dispatcher.
  assert.equal(grantTool.opts.when({ agent: { session: { id: 'im-disp' } } }), false)
  assert.equal(grantTool.opts.when({ agent: { session: { id: 'im-task-1' } } }), true)
  assert.equal(grantTool.opts.when({ agent: { session: { id: 'sub-1' } } }), true)

  // Scheduled turn without a human trigger MUST be refused even if an earlier trigger exists.
  h.triggers.set('im-task-1', { sender: { id: 'ou_owner', name: '张三', self: false } })
  await h.emit('session/event', { id: 'im-task-1' }, { type: 'user/message', data: { source: { kind: 'schedule' } } })
  await h.emit('im/activity', { session: { sessionId: 'im-task-1' }, turn: 1 }, 'start')

  const execAs = (sessionId: string) => ({ agent: { session: { id: sessionId } }, callId: 'c1', signal: new AbortController().signal })
  const scheduleDenied = await grantTool.def.execute({ users: [{ id: 'ou_collab', name: '李四' }] }, execAs('im-task-1'))
  assert.equal(scheduleDenied.status, 'error')
  assert.equal(scheduleDenied.code, 'access')
  await h.emit('im/activity', { session: { sessionId: 'im-task-1' }, turn: 1 }, 'end')

  // Human turn from 张三 -> can claim exclusivity & grant 李四.
  await h.emit('session/event', { id: 'im-task-1' }, { type: 'user/message', data: { source: { kind: 'im' } } })
  await h.emit('im/activity', {
    session: { sessionId: 'im-task-1' }, turn: 2, trigger: { sender: { id: 'ou_owner', name: '张三', self: false } },
  }, 'start')

  const granted1 = await grantTool.def.execute({ users: [{ id: 'ou_collab', name: '李四' }] }, execAs('im-task-1'))
  assert.equal(granted1.exclusive, true)
  assert.equal(granted1.owner.id, 'ou_owner')
  assert.deepEqual(granted1.allowedUsers.map((u: any) => u.id), ['ou_owner', 'ou_collab'])
  assert.equal(host.canInteract('im-task-1', 'ou_owner'), true)
  assert.equal(host.canInteract('im-task-1', 'ou_collab'), true)
  assert.equal(host.canInteract('im-task-1', 'ou_stranger'), false)
  assert.equal(host.canInteract('sub-1', 'ou_stranger'), false)
  await h.emit('im/activity', { session: { sessionId: 'im-task-1' }, turn: 2 }, 'end')

  // Collaborator 李四 can also grant 王五 (per Q4 decision).
  await h.emit('im/activity', {
    session: { sessionId: 'im-task-1' }, turn: 3, trigger: { sender: { id: 'ou_collab', name: '李四', self: false } },
  }, 'start')
  const granted2 = await grantTool.def.execute({ users: [{ id: 'ou_third', name: '王五' }] }, execAs('im-task-1'))
  assert.deepEqual(granted2.allowedUsers.map((u: any) => u.id), ['ou_owner', 'ou_collab', 'ou_third'])

  // Nobody can kick owner 张三!
  const kickOwner = await revokeTool.def.execute({ userIds: ['ou_owner'] }, execAs('im-task-1'))
  assert.equal(kickOwner.status, 'error')
  assert.equal(kickOwner.code, 'access')

  // Collaborator 王五 can be removed.
  const kickThird = await revokeTool.def.execute({ userIds: ['ou_third'] }, execAs('im-task-1'))
  assert.deepEqual(kickThird.allowedUsers.map((u: any) => u.id), ['ou_owner', 'ou_collab'])
  assert.equal(host.canInteract('im-task-1', 'ou_third'), false)

  const inspected = await getTool.def.execute({}, execAs('im-task-1'))
  assert.equal(inspected.exclusive, true)
  assert.equal(inspected.allowedUsers.length, 2)

  // Card guard rejects stranger and admits owner/collaborator.
  assert.equal(h.cardGuards[0]!({ cardId: 'c1', session: 'im-task-1', chat: CHAT, user: { id: 'ou_stranger' }, kind: 'button' }).ok, false)
  assert.equal(h.cardGuards[0]!({ cardId: 'c1', session: 'im-task-1', chat: CHAT, user: { id: 'ou_collab' }, kind: 'button' }).ok, true)

  await host.dispose()
})

test('capability acquire (sync + async pending -> pushEvent + steer), revocation keeps exclusivity, pre-step reauth & recovery', async () => {
  const h = fakeHarness()
  h.sessions.set('im-task-1', {
    sessionId: 'im-task-1', key: 'task:1', owner: 'dispatch', parent: 'im-disp',
    bindings: [{ chat: CHAT, writable: true, home: true, thread: 'om_root1' }],
    subagents: ['sub-1'],
  })

  const host = new SessionAuthHost(h.ctx, h.im, { refusalThrottleMs: 15_000 })
  await host.open()

  let pendingComplete: CapabilityAcquireContext['complete'] | undefined
  let revokedCount = 0
  let readyOutcome: any = { status: 'ready' }
  const tokenByUser = new Map<string, string>([['ou_owner', 'tok_initial']])

  const provider: CapabilityProvider = {
    id: 'demo-cap',
    title: '演示能力',
    description: '需要登录才能使用',
    requestGuidance: '请使用 <AuthRequest capabilities={["demo-cap"]} /> 申请。',
    activeGuidance: '可以直接调用演示工具。',
    execEnv: {
      variables: { DEMO_TOKEN: { description: 'Demo capability token' } },
      resolve: (grant) => ({ DEMO_TOKEN: tokenByUser.get(grant.grantor.id) }),
    },
    tools: [{
      name: 'demo_secret_tool',
      description: 'Only visible when demo-cap is active',
      parameters: {},
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({ ok: true }),
    }],
    acquire: (ctx) => {
      pendingComplete = ctx.complete
      return { status: 'pending', message: '请在私聊完成登录' }
    },
    ensureReady: async () => readyOutcome,
    onRevoke: () => { revokedCount++ },
  }

  host.registerProvider(provider)
  assert.ok(h.tools.has('demo_secret_tool'))
  assert.equal(h.tools.get('demo_secret_tool')!.opts.when({ agent: { session: { id: 'im-task-1' } } }), false)

  // Trigger auth:grant from card
  const describe = h.cardActions.get('auth:describe')!({
    cardId: 'card_1', session: 'im-task-1', chat: CHAT, preview: true, payload: { capabilities: ['demo-cap'] },
  }) as any
  assert.equal(describe.capabilities[0].title, '演示能力')

  // Explicit sender="requester" rejects stranger when requester is ou_owner
  const rejected = h.cardActions.get('auth:grant')!({
    cardId: 'card_1', session: 'im-task-1', chat: CHAT, requester: { id: 'ou_owner', name: '张三' },
    user: { id: 'ou_stranger', name: '路人' }, preview: false, payload: { capabilities: ['demo-cap'], sender: 'requester' },
  }) as any
  assert.equal(rejected.ok, false)

  // Requester clicks -> pending + session claimed exclusive immediately
  h.messages.set('lark:test|om_card1', { key: 'lark:test|om_card1', thread: { id: 'omt_card1' }, chat: { key: CHAT } })
  const grantReply = h.cardActions.get('auth:grant')!({
    cardId: 'card_1', session: 'im-task-1', chat: CHAT, message: 'lark:test|om_card1',
    requester: { id: 'ou_owner', name: '张三' },
    user: { id: 'ou_owner', name: '张三' }, preview: false, payload: { capabilities: ['demo-cap'], reason: '查单' },
  }) as any
  assert.equal(grantReply.ok, true)
  assert.equal(grantReply.state.status, 'pending')
  assert.equal(host.isExclusive('im-task-1'), true)
  assert.equal(host.canInteract('im-task-1', 'ou_stranger'), false)

  // Async login settles -> active, card pushed, steer delivered with card trigger, execEnv & gated tool active (including subagent!)
  assert.ok(pendingComplete)
  await pendingComplete!({ ok: true })
  assert.equal(h.pushedEvents.at(-1)?.cardId, 'card_1')
  assert.equal((h.pushedEvents.at(-1)?.data as any).status, 'granted')
  assert.equal(h.deliveries.at(-1)?.delivery.mode, 'steer')
  assert.equal(h.deliveries.at(-1)?.delivery.trigger?.key, 'lark:test|om_card1')
  assert.equal(h.tools.get('demo_secret_tool')!.opts.when({ agent: { session: { id: 'sub-1' } } }), true)

  const envContributor = h.execEnvContributors.get('im-session-auth:demo-cap')!
  assert.deepEqual(envContributor.resolve({ session: { id: 'sub-1' } }), { DEMO_TOKEN: 'tok_initial' })

  // Pre-step sees reauth_required -> grant suspended, execEnv stops injecting, card pushed
  readyOutcome = { status: 'reauth_required', message: '登录态已过期，请重登' }
  await h.runWaterfall('agent/pre-step', {
    agent: { session: { id: 'sub-1' } }, messages: [], turn: 1, step: 1,
    signal: new AbortController().signal, modelSelection: {},
  })
  assert.equal(host.grantFor('im-task-1', 'demo-cap')?.status, 'reauth_required')
  assert.deepEqual(envContributor.resolve({ session: { id: 'sub-1' } }), {})
  assert.equal(h.tools.get('demo_secret_tool')!.opts.when({ agent: { session: { id: 'sub-1' } } }), false)

  // Reauthenticated in DM -> restores active and wakes session
  tokenByUser.set('ou_owner', 'tok_refreshed')
  const restored = await host.notifyUserReauthenticated('demo-cap', 'ou_owner')
  assert.equal(restored, 1)
  assert.equal(h.deliveries.at(-1)?.delivery.trigger?.key, 'lark:test|om_card1')
  assert.equal(host.grantFor('im-task-1', 'demo-cap')?.status, 'active')
  assert.deepEqual(envContributor.resolve({ session: { id: 'im-task-1' } }), { DEMO_TOKEN: 'tok_refreshed' })

  // Revoke from card keeps exclusivity ("撤权保独占")
  const revokeReply = h.cardActions.get('auth:revoke')!({
    cardId: 'card_1', session: 'im-task-1', chat: CHAT,
    user: { id: 'ou_owner', name: '张三' }, preview: false, payload: { capabilities: ['demo-cap'] },
  }) as any
  assert.equal(revokeReply.ok, true)
  assert.equal(revokeReply.state.status, 'revoked')
  assert.equal(revokedCount, 1)
  assert.equal(host.isExclusive('im-task-1'), true)
  assert.equal(host.canInteract('im-task-1', 'ou_stranger'), false)
  assert.deepEqual(envContributor.resolve({ session: { id: 'im-task-1' } }), {})

  await host.dispose()
})

test('slash command prepend guard, operatorUnlock, and restart settling pending grants', async () => {
  const h = fakeHarness()
  h.sessions.set('im-task-1', {
    sessionId: 'im-task-1', key: 'task:1', owner: 'dispatch', parent: 'im-disp',
    bindings: [{ chat: CHAT, writable: true, home: true, thread: 'om_root1' }],
  })

  // Seed a pending grant from a crashed process before open().
  await h.ctx.storageDomain.open().then(async (dom: any) => {
    await dom.table('sessions').put('im-task-1', {
      sessionId: 'im-task-1', exclusive: true, owner: { id: 'ou_owner', name: '张三' },
      allowedUsers: [{ id: 'ou_owner', name: '张三', addedAt: 1 }], createdAt: 1, updatedAt: 1,
    })
    await dom.table('grants').put('im-task-1\u0000demo-cap', {
      key: 'im-task-1\u0000demo-cap', sessionId: 'im-task-1', capabilityId: 'demo-cap',
      status: 'pending', grantor: { id: 'ou_owner', name: '张三' }, cardId: 'card_old', createdAt: 1, updatedAt: 1,
    })
  })

  const host = new SessionAuthHost(h.ctx, h.im, { refusalThrottleMs: 15_000 })
  await host.open()
  assert.equal(host.grantFor('im-task-1', 'demo-cap')?.status, 'revoked', 'interrupted pending settled to revoked')
  assert.equal(host.isExclusive('im-task-1'), true)

  // Register prepend command guard ahead of a downstream command listener.
  let downstreamCalled = false
  h.ctx.on('im/message', async (_ev: any, next: any) => {
    downstreamCalled = true
    return { kind: 'handled', by: 'session-commands' }
  }, { prepend: true })
  h.ctx.on('im/message', (ev: any, next: any) => host.handleCommandMessage(ev, next), { prepend: true })

  const replies: any[] = []
  const strangerCmdEvent = {
    message: {
      key: 'lark:test|om_2',
      chat: { key: CHAT },
      thread: { id: 'om_root1' },
      sender: { id: 'ou_stranger', name: '路人', self: false },
      addressed: true,
      command: { name: 'stop', rawInput: '' },
    },
    reply: async (content: any) => { replies.push(content) },
  }
  const outcome1 = await h.runWaterfall('im/message', strangerCmdEvent)
  assert.equal(outcome1.by, 'im-session-auth')
  assert.equal(downstreamCalled, false)
  assert.equal(replies.length, 1)

  // Owner passes through to downstream command handler.
  const ownerCmdEvent = {
    ...strangerCmdEvent,
    message: { ...strangerCmdEvent.message, key: 'lark:test|om_3', sender: { id: 'ou_owner', name: '张三', self: false } },
  }
  const outcome2 = await h.runWaterfall('im/message', ownerCmdEvent)
  assert.equal(outcome2.by, 'session-commands')
  assert.equal(downstreamCalled, true)

  // Operator unlock clears exclusivity.
  assert.equal(await host.operatorUnlock('im-task-1'), true)
  assert.equal(host.isExclusive('im-task-1'), false)
  assert.equal(host.canInteract('im-task-1', 'ou_stranger'), true)

  await host.dispose()
})

test('any non-requester can authorize by default using their own identity, and requestCapabilities posts an AuthRequest card', async () => {
  const h = fakeHarness()
  h.sessions.set('im-task-1', {
    sessionId: 'im-task-1',
    key: 'task:1',
    owner: 'session-tasks',
    parent: 'im-router-1',
    bindings: [{ chat: CHAT, writable: true, home: true, thread: 'om_root1' }],
  })
  const published: any[] = []
  h.ctx.get('imCards').publishInline = async (req: any) => {
    published.push(req)
    return { id: 'card_auto_1', status: 'confirmed', message: 'lark:test|om_auto1' }
  }

  const host = new SessionAuthHost(h.ctx, h.im, { refusalThrottleMs: 15_000 })
  await host.open()

  const acquiredBy: string[] = []
  host.registerProvider({
    id: 'feishu-project',
    title: '飞书项目',
    description: 'Meegle CLI',
    acquire(ctx) {
      acquiredBy.push(ctx.grantor.id)
      return { status: 'granted', message: `granted for ${ctx.grantor.id}` }
    },
  })

  // Proactively request capabilities via requestCapabilities.
  const reqRes = await host.requestCapabilities({
    sessionId: 'im-task-1',
    chat: CHAT,
    capabilities: ['feishu-project'],
    reason: '自动申请飞书项目权限',
    quote: 'lark:test|om_root1' as any,
    thread: 'om_root1',
    requester: { id: 'ou_initiator', name: '发起人A' },
  })
  assert.equal(reqRes.ok, true)
  assert.equal(reqRes.ok && reqRes.cardId, 'card_auto_1')
  assert.equal(published.length, 1)
  assert.deepEqual(published[0].props.capabilities, ['feishu-project'])
  assert.equal(published[0].props.reason, '自动申请飞书项目权限')

  // Explicit sender="requester" still restricts to requester.
  const grantAction = h.cardActions.get('auth:grant')!
  const blocked = grantAction({
    cardId: 'card_auto_1',
    session: 'im-task-1',
    chat: CHAT,
    requester: { id: 'ou_initiator', name: '发起人A' },
    user: { id: 'ou_grantor_b', name: '授权人B' },
    preview: false,
    payload: { capabilities: ['feishu-project'], sender: 'requester' },
  }) as any
  assert.equal(blocked.ok, false)

  // Default (no sender specified) allows any user to authorize with their own identity.
  const allowed = grantAction({
    cardId: 'card_auto_1',
    session: 'im-task-1',
    chat: CHAT,
    requester: { id: 'ou_initiator', name: '发起人A' },
    user: { id: 'ou_grantor_b', name: '授权人B' },
    preview: false,
    payload: { capabilities: ['feishu-project'] },
  }) as any
  assert.equal(allowed.ok, true)
  assert.deepEqual(acquiredBy, ['ou_grantor_b'])
  assert.equal(host.aclOf('im-task-1')?.owner?.id, 'ou_grantor_b')
  assert.equal(host.grantFor('im-task-1', 'feishu-project')?.grantor.id, 'ou_grantor_b')

  // Requesting again when already active skips publishing a duplicate card.
  const again = await host.requestCapabilities({
    sessionId: 'im-task-1',
    chat: CHAT,
    capabilities: ['feishu-project'],
  })
  assert.deepEqual(again, { ok: true, alreadyActive: true })
  assert.equal(published.length, 1)

  await host.dispose()
})

test('requestCapabilities silently auto-grants when requester already has valid capability credentials and appends summary notice', async () => {
  const h = fakeHarness()
  h.sessions.set('im-task-2', {
    sessionId: 'im-task-2',
    key: 'task:2',
    owner: 'session-tasks',
    parent: 'im-router-1',
    bindings: [{ chat: CHAT, writable: true, home: true, thread: 'om_root2' }],
  })
  const published: any[] = []
  h.ctx.get('imCards').publishInline = async (req: any) => {
    published.push(req)
    return { id: 'card_should_not_send', status: 'confirmed' }
  }

  const host = new SessionAuthHost(h.ctx, h.im, { refusalThrottleMs: 15_000 })
  await host.open()

  host.registerProvider({
    id: 'feishu-project',
    title: '飞书项目 (Meegle)',
    description: 'Meegle CLI',
    acquire: () => ({ status: 'pending' }),
    tryAutoAcquire: ({ grantor }) => (
      grantor.id === 'ou_has_token'
        ? { status: 'granted', message: '已复用飞书项目凭据' }
        : undefined
    ),
  })

  // Requester WITH valid credentials -> auto-granted without publishing an AuthRequest card.
  const res = await host.requestCapabilities({
    sessionId: 'im-task-2',
    chat: CHAT,
    capabilities: ['feishu-project'],
    requester: { id: 'ou_has_token', name: '张三' },
  })
  assert.equal(res.ok, true)
  assert.equal(res.ok && res.alreadyActive, true)
  assert.equal(res.ok && res.autoGranted?.length, 1)
  assert.equal(published.length, 0, 'no AuthRequest card sent when silently auto-granted')
  assert.equal(host.isExclusive('im-task-2'), true)
  assert.equal(host.aclOf('im-task-2')?.owner?.id, 'ou_has_token')
  assert.equal(host.grantFor('im-task-2', 'feishu-project')?.status, 'active')
  assert.equal(host.grantFor('im-task-2', 'feishu-project')?.grantor.id, 'ou_has_token')

  // Summary card waterfall on turn 1 receives "已自动授权" line; suppressed when hasProcessMessage=true; cleared on turn end.
  const streamOut1 = h.runSyncWaterfall('im/streaming-message', [], {
    activity: { session: { sessionId: 'im-task-2' }, turn: 1 },
    part: 'progress',
  })
  const lastNode1 = streamOut1[streamOut1.length - 1]
  assert.match(JSON.stringify(lastNode1), /已自动授权：飞书项目 \(Meegle\)（张三）/)

  const streamOutSettledDup = h.runSyncWaterfall('im/streaming-message', [], {
    activity: { session: { sessionId: 'im-task-2' }, turn: 1 },
    part: 'settled',
    hasProcessMessage: true,
  })
  assert.equal(streamOutSettledDup.length, 0, 'not duplicated on separate settled message when process card stayed')

  await h.emit('im/activity', { session: { sessionId: 'im-task-2' }, turn: 1 }, 'end')
  const streamOutTurn2 = h.runSyncWaterfall('im/streaming-message', [], {
    activity: { session: { sessionId: 'im-task-2' }, turn: 2 },
    part: 'progress',
  })
  assert.equal(streamOutTurn2.length, 0, 'notice cleared after turn 1 finishes')

  await host.dispose()
})
