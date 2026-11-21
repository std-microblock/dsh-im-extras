import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { ImError, type ImApi, type ImBinding, type ImChatKey, type ImSessionRecord } from '@deepseek-ai/dsh-im'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Config, ImTaskHost, imTasksDomain, type SessionTasksConfig } from '../src/index.ts'
import { applyTools } from '../src/tools.ts'

interface ToolEntry {
  name: string
  execute: (args: unknown, exec: { callId: string; signal: AbortSignal; agent?: { session: { id: SessionId } } }) => Promise<unknown>
}

function makeHarness(configPatch: Partial<SessionTasksConfig> = {}) {
  const config: SessionTasksConfig = {
    owners: ['conversation', 'dispatcher', 'dispatch'],
    sharedOwners: ['dispatch', 'dispatcher'],
    tools: {
      owner: ['task_start', 'task_list', 'task_message'],
      worker: ['task_note', 'task_describe'],
    },
    maxTextChars: 20000,
    locale: 'zh',
    ...configPatch,
  }
  const tables = new Map<string, Map<string, unknown>>()
  const domain = {
    table: (name: string) => {
      const store = tables.get(name) ?? new Map<string, unknown>()
      tables.set(name, store)
      return {
        get: (key: string) => store.get(key),
        entries: () => new Map(store).entries(),
        get size() { return store.size },
        put: async (key: string, value: unknown) => { store.set(key, value) },
        delete: async (key: string) => store.delete(key),
      }
    },
    close: async () => {},
  }
  const sessions = new Map<string, ImSessionRecord>()
  const byKey = new Map<string, ImSessionRecord>()
  const deliveries: Array<{ session: SessionId; mode: string; id: string }> = []
  let seq = 1
  const emitted: Array<{ event: string; taskId: number }> = []
  const registeredTools = new Map<string, ToolEntry>()

  const im = {
    sessions: {
      get: (idOrKey: string) => sessions.get(idOrKey) ?? byKey.get(idOrKey),
      of: (id: SessionId) => sessions.get(id),
      ensure: async (spec: {
        key: string
        owner: string
        composition: ImSessionRecord['composition']
        bindings: ImBinding[]
        parent?: SessionId
        output?: string
        meta?: Record<string, unknown>
      }) => {
        const existing = byKey.get(spec.key)
        if (existing !== undefined) {
          const updated: ImSessionRecord = { ...existing, bindings: spec.bindings }
          sessions.set(updated.sessionId, updated)
          byKey.set(updated.key, updated)
          return updated
        }
        const sessionId = `sess-${seq++}` as SessionId
        const created: ImSessionRecord = {
          sessionId,
          key: spec.key,
          owner: spec.owner,
          composition: spec.composition,
          bindings: spec.bindings,
          ...spec.parent === undefined ? {} : { parent: spec.parent },
          ...spec.output === undefined ? {} : { output: spec.output },
          ...spec.meta === undefined ? {} : { meta: spec.meta },
        } as ImSessionRecord
        sessions.set(sessionId, created)
        byKey.set(created.key, created)
        return created
      },
      deliver: async (id: SessionId, item: { id: string; mode: string }) => {
        deliveries.push({ session: id, mode: item.mode, id: item.id })
        return { accepted: true }
      },
      trigger: () => undefined,
    },
    format: async () => [{ type: 'text' as const, text: 'formatted' }],
  } as unknown as ImApi

  const ctx = {
    storageDomain: {
      open: async () => domain,
    },
    emit: (event: string, task: { id: number }) => {
      emitted.push({ event, taskId: task.id })
    },
  } as unknown as Context

  const toolsCtx = {
    tools: {
      register: (def: ToolEntry) => {
        registeredTools.set(def.name, def)
        return () => { registeredTools.delete(def.name) }
      },
    },
  } as unknown as Context

  const host = new ImTaskHost(ctx, im, config)
  return {
    config,
    host,
    im,
    sessions,
    byKey,
    deliveries,
    emitted,
    tables,
    registeredTools,
    open: async () => {
      await host.open()
      applyTools(toolsCtx, im, host, config)
    },
  }
}

const COMP = { agentPreset: 'worker', provider: 'deepseek', model: 'deepseek-chat' } as ImSessionRecord['composition']

describe('ImTaskHost describe & shared router ownership', () => {
  it('Config includes task_describe and sharedOwners defaults', () => {
    const parsed = Config({})
    assert.ok(parsed.tools.worker.includes('task_describe'))
    assert.deepEqual(parsed.sharedOwners, ['dispatch', 'dispatcher'])
  })

  it('describe() updates task profile fields without injecting into owner session', async () => {
    const env = makeHarness()
    await env.open()
    const router = await env.im.sessions.ensure({
      key: 'dispatch:chat:c1',
      owner: 'dispatch',
      composition: COMP,
      bindings: [{ chat: 'c1' as ImChatKey, writable: false, home: true }],
    })
    const task = await env.host.start({
      owner: router.sessionId,
      title: '发版卡片',
      brief: '每次发版生成一个卡片',
    })
    const deliveriesBefore = env.deliveries.length
    const updated = await env.host.describe(task.session, {
      description: '负责 ddswitch 每次发版卡片生成与模板维护',
      wantedTopics: ['发版卡片', 'release card'],
      topicScope: 'all',
      followThread: false,
      note: '已完成初版卡片模板',
    })

    assert.equal(updated.description, '负责 ddswitch 每次发版卡片生成与模板维护')
    assert.deepEqual(updated.wantedTopics, ['发版卡片', 'release card'])
    assert.equal(updated.topicScope, 'all')
    assert.equal(updated.followThread, false)
    assert.equal(updated.note, '已完成初版卡片模板')
    assert.equal(env.deliveries.length, deliveriesBefore)
    assert.equal(env.emitted.filter(entry => entry.event === 'im/task/updated').length, 1)

    // Reloading through imTasksDomain preserves all new fields and loads legacy rows cleanly.
    const tasksTable = env.tables.get('tasks')!
    tasksTable.set('sess-legacy', {
      session: 'sess-legacy',
      id: 99,
      owner: router.sessionId,
      title: 'Legacy Task',
      chat: 'c1',
      seq: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    for (const value of tasksTable.values()) {
      const parsed = imTasksDomain.tables.tasks.valueSchema.parse(value)
      assert.ok(parsed.id >= 1)
    }
  })

  it('task_describe tool enforces worker role and clears wantedTopics with []', async () => {
    const env = makeHarness()
    await env.open()
    const router = await env.im.sessions.ensure({
      key: 'dispatch:chat:c1',
      owner: 'dispatch',
      composition: COMP,
      bindings: [{ chat: 'c1' as ImChatKey, writable: false, home: true }],
    })
    const task = await env.host.start({ owner: router.sessionId, title: 'Feature X', brief: 'Implement X' })
    const tool = env.registeredTools.get('task_describe')!
    const call = (sessionId: SessionId, args: unknown) => tool.execute(args, {
      callId: 'c-1',
      signal: new AbortController().signal,
      agent: { session: { id: sessionId } },
    }) as Promise<Record<string, unknown>>

    const denied = await call(router.sessionId, { description: 'nope' })
    assert.equal(denied['status'], 'error')
    assert.equal(denied['code'], 'access')

    const ok = await call(task.session, {
      description: 'Handling Feature X PR #42',
      wantedTopics: ['Feature X'],
      topicScope: 'chat',
    })
    assert.equal(ok['description'], 'Handling Feature X PR #42')
    assert.deepEqual(ok['wantedTopics'], ['Feature X'])
    assert.equal(ok['topicScope'], 'chat')

    const cleared = await call(task.session, { wantedTopics: [], followThread: false })
    assert.deepEqual(cleared['wantedTopics'], [])
    assert.equal(cleared['followThread'], false)
  })

  it('allows shared router fleet to steer cross-chat or post-reset tasks while isolating conversation tasks', async () => {
    const env = makeHarness()
    await env.open()
    const routerA = await env.im.sessions.ensure({
      key: 'dispatch:chat:c1',
      owner: 'dispatch',
      composition: COMP,
      bindings: [{ chat: 'c1' as ImChatKey, writable: false, home: true }],
    })
    const routerB = await env.im.sessions.ensure({
      key: 'dispatch:chat:c2',
      owner: 'dispatch',
      composition: COMP,
      bindings: [{ chat: 'c2' as ImChatKey, writable: false, home: true }],
    })
    const convA = await env.im.sessions.ensure({
      key: 'conv:1',
      owner: 'conversation',
      composition: COMP,
      bindings: [{ chat: 'c3' as ImChatKey, writable: true, home: true }],
    })
    const convB = await env.im.sessions.ensure({
      key: 'conv:2',
      owner: 'conversation',
      composition: COMP,
      bindings: [{ chat: 'c4' as ImChatKey, writable: true, home: true }],
    })

    const sharedTask = await env.host.start({ owner: routerA.sessionId, title: 'Shared', brief: 'Work' })
    const convTask = await env.host.start({ owner: convA.sessionId, title: 'Private', brief: 'Work' })

    // Router B steers task started by Router A.
    const steered = await env.host.message(routerB.sessionId, sharedTask.id, 'From group B')
    assert.equal(steered.id, sharedTask.id)

    // Even after Router A is disposed/reset, Router B still steers the shared task.
    env.sessions.delete(routerA.sessionId)
    env.byKey.delete(routerA.key)
    await env.host.message(routerB.sessionId, sharedTask.id, 'After reset')

    // Conversation B cannot steer Conversation A's task or Router's shared task.
    await assert.rejects(
      () => env.host.message(convB.sessionId, convTask.id, 'steal'),
      (error: unknown) => error instanceof ImError && error.code === 'access',
    )
    await assert.rejects(
      () => env.host.message(convB.sessionId, sharedTask.id, 'steal shared'),
      (error: unknown) => error instanceof ImError && error.code === 'access',
    )
    // Shared router B cannot steer Conversation A's private task either.
    await assert.rejects(
      () => env.host.message(routerB.sessionId, convTask.id, 'steal conv'),
      (error: unknown) => error instanceof ImError && error.code === 'access',
    )
  })
})
