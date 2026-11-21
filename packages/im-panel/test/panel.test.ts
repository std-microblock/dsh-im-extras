/**
 * The panel's host half: the built-in snapshot and commands over structural fakes, and the tab extension API (JSON
 * handlers, raw fetch handlers, lifecycle).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CHRONICLE_PATH, ImPanelService, PANEL_PATH, TAB_PATH, commandOf } from '../src/index.ts'

const ORIGIN = 'http://gui.invalid'

function fakeServices() {
  const stopped: string[] = []
  const notes: string[] = []
  const configured: unknown[] = []
  const im = {
    status: () => ({
      bots: [{ id: 'lark:app', platform: 'lark', status: 1 }],
      sources: [{}],
      sessions: [
        {
          sessionId: 'im-router', key: 'dispatch:chat:lark:app|g1', owner: 'dispatch', generation: 1, createdAt: 1,
          lastActiveAt: 5, bindings: [{ chat: 'lark:app|g1', writable: false, home: true }],
        },
        {
          sessionId: 'im-worker', key: 'task:1', owner: 'task', parent: 'im-router', generation: 1, createdAt: 2,
          lastActiveAt: 9, bindings: [{ chat: 'lark:app|g1', writable: true, thread: 't1' }],
        },
      ],
      pendingDeliveries: 0,
      pendingMessages: 2,
    }),
    sessions: { stop: async (target: string) => { stopped.push(target); return true } },
  }
  const tasks = {
    list: () => [{ id: 1, title: '排查', session: 'im-worker', owner: 'im-router', chat: 'lark:app|g1', createdAt: 2, updatedAt: 9 }],
    get: (id: number) => (id === 1 ? tasks.list()[0] : undefined),
    note: async (_worker: string, note: string) => { notes.push(note) },
  }
  const dispatch = {
    config: {
      main: { agentPreset: 'router', provider: 'p', model: 'm', cwd: '/r' },
      worker: { agentPreset: 'worker', provider: 'p', model: 'm', cwd: '/w' },
      workerOutput: 'summary',
      tools: { main: ['router_reply'], worker: ['task_describe'] },
      maxRouterSteps: 5,
      autoThread: true,
    },
    chats: async () => [{
      chat: 'lark:app|g1', name: '研发群', type: 'group', firstSeenAt: 1, wakeMode: 'mention' as const,
      replyMode: 'mention_only' as const, watchTopics: [],
    }],
    rules: async () => [{ id: 3, task: 1, match: 'im.at_me', mode: 'copy' as const }],
    tasks: () => [{ id: 1 }],
    isRouter: (key: string) => key.startsWith('dispatch:'),
    sessionTitle: (sessionId: string) => (sessionId === 'im-router' ? '[群路由] 研发群' : undefined),
    chatInfo: () => undefined,
    chronicleStatus: async () => ({ entries: 1, chunks: 0, latestId: 1, recent: [{ id: 1, time: 1, kind: 'bot_reply', chat: 'lark:app|g1', subject: 's', summary: 'x', line: 'l' }] }),
    chronicleEntries: async (filter?: { chat?: string }) => ({ entries: filter?.chat === 'none' ? [] : [{ id: 1, time: 1, kind: 'bot_reply', chat: 'lark:app|g1', subject: 's', summary: 'x' }], total: 1 }),
    addRule: async () => ({ id: 4 }),
    updateRule: async (_task: number, id: number) => ({ id }),
    removeRule: async (id: number) => ({ id }),
    configureChat: async (chat: string, patch: unknown) => { configured.push({ chat, patch }) },
  }
  return { im, tasks, dispatch, stopped, notes, configured }
}

async function json(response: Response): Promise<any> {
  return JSON.parse(await response.text())
}

test('the snapshot reads every mounted service and labels routers, workers and chats', async () => {
  const ctx = new Context()
  const fakes = fakeServices()
  ctx.provide('im', fakes.im as never)
  ctx.provide('imTasks', fakes.tasks as never)
  ctx.provide('imDispatch', fakes.dispatch as never)
  const panel = new ImPanelService(ctx)
  const state = await json(await panel.handle(new Request(`${ORIGIN}${PANEL_PATH}`)))
  assert.equal(state.transport.bots[0].platform, 'lark')
  assert.deepEqual(state.sessions.map((s: { role: string }) => s.role), ['task', 'router'])
  assert.equal(state.sessions[1].title, '[群路由] 研发群')
  assert.equal(state.tasks[0].chatName, '研发群')
  assert.equal(state.tasks[0].dispatch, true)
  assert.equal(state.rules[0].errors, 0)
  assert.equal(state.chats[0].platform, 'lark')
  assert.equal(state.dispatch.limits.maxRouterSteps, 5)
  assert.equal(state.chronicle.entries, 1)
  assert.deepEqual(state.notices.filter((n: { level?: string }) => n.level === 'warning'), [])

  const chronicle = await json(await panel.handle(new Request(`${ORIGIN}${CHRONICLE_PATH}?chat=none`)))
  assert.deepEqual(chronicle, { entries: [], total: 1 })
})

test('an empty profile still answers, with notices instead of errors', async () => {
  const panel = new ImPanelService(new Context())
  const state = await json(await panel.handle(new Request(`${ORIGIN}${PANEL_PATH}`)))
  assert.deepEqual(state.tasks, [])
  assert.ok(state.notices.length >= 3)
  const failed = await json(await panel.handle(new Request(`${ORIGIN}${PANEL_PATH}`, {
    method: 'POST', body: JSON.stringify({ action: 'rule-remove', id: 1 }),
  })))
  assert.equal(failed.ok, false)
  assert.match(failed.text, /dsh-im-dispatch/)
})

test('commands stop tasks, write rules and chat configuration, and reject malformed bodies', async () => {
  const ctx = new Context()
  const fakes = fakeServices()
  ctx.provide('im', fakes.im as never)
  ctx.provide('imTasks', fakes.tasks as never)
  ctx.provide('imDispatch', fakes.dispatch as never)
  const panel = new ImPanelService(ctx)
  const post = async (body: unknown): Promise<any> => await json(await panel.handle(new Request(`${ORIGIN}${PANEL_PATH}`, {
    method: 'POST', body: JSON.stringify(body),
  })))
  assert.deepEqual(await post({ action: 'task-stop', id: 1 }), { ok: true, text: '已停止任务 #1' })
  assert.deepEqual(fakes.stopped, ['im-worker'])
  assert.equal(fakes.notes.length, 1)
  assert.equal((await post({ action: 'rule-add', task: 1, match: 'true', mode: 'cut' })).text, '已给任务 #1 加规则 #4')
  assert.equal((await post({ action: 'chat-configure', chat: 'lark:app|g1', patch: { wakeMode: 'watch', watchTopics: ['发版'] } })).ok, true)
  assert.deepEqual(fakes.configured, [{ chat: 'lark:app|g1', patch: { wakeMode: 'watch', watchTopics: ['发版'] } }])
  assert.throws(() => commandOf({ action: 'chat-configure', chat: 'x', patch: { wakeMode: 'loud' } }), /wakeMode/)
  const bad = await panel.handle(new Request(`${ORIGIN}${PANEL_PATH}`, { method: 'POST', body: '{"action":"nope"}' }))
  assert.equal(bad.status, 400)
})

test('extension tabs answer JSON reads and commands, raw fetches, and leave with their plugin', async () => {
  const ctx = new Context()
  const panel = new ImPanelService(ctx)
  const commands: unknown[] = []
  ctx.on('im-panel/command', (tab, path, body) => { commands.push({ tab, path, body }) })

  assert.throws(() => panel.tab({ id: 'rules', title: 'x' }), /reserved/)
  assert.throws(() => panel.tab({ id: 'Bad id', title: 'x' }), /must match/)

  const fiber = ctx.plugin({
    name: 'polish-like',
    apply: (child: Context) => {
      const service = child.get('imPanel') as ImPanelService
      service.tab({
        id: 'polish',
        title: '润色',
        order: 50,
        badge: () => 7,
        read: ({ path, query }) => ({ path, limit: query.get('limit') }),
        command: ({ body }) => {
          if ((body as { action?: string }).action === 'boom') throw new Error('炸了')
          return { ok: true, text: 'done' }
        },
      })
      service.tab({
        id: 'stickers',
        title: '表情',
        fetch: async (request, { path }) => (path === 'file'
          ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
          : Response.json({ method: request.method, fields: [...(await request.formData()).keys()] })),
      })
    },
  })
  await fiber

  assert.deepEqual(panel.tabs().map(tab => [tab.id, tab.order, tab.badge]), [['polish', 50, 7], ['stickers', 100, undefined]])
  const state = await panel.snapshot()
  assert.equal(state.tabs.length, 2)

  assert.deepEqual(await json(await panel.handle(new Request(`${ORIGIN}${TAB_PATH}?id=polish&path=records&limit=5`))),
    { path: 'records', limit: '5' })
  assert.deepEqual(await json(await panel.handle(new Request(`${ORIGIN}${TAB_PATH}?id=polish`, {
    method: 'POST', body: JSON.stringify({ action: 'go' }),
  }))), { ok: true, text: 'done' })
  assert.deepEqual(await json(await panel.handle(new Request(`${ORIGIN}${TAB_PATH}?id=polish`, {
    method: 'POST', body: JSON.stringify({ action: 'boom' }),
  }))), { ok: false, text: '炸了' })
  assert.deepEqual(commands, [{ tab: 'polish', path: '', body: { action: 'go' } }])

  const image = await panel.handle(new Request(`${ORIGIN}${TAB_PATH}?id=stickers&path=file&sticker=1`))
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [1, 2, 3])
  const form = new FormData()
  form.append('file', new Blob(['x']), 'a.png')
  assert.deepEqual(await json(await panel.handle(new Request(`${ORIGIN}${TAB_PATH}?id=stickers&path=upload`, {
    method: 'POST', body: form,
  }))), { method: 'POST', fields: ['file'] })

  assert.equal((await panel.handle(new Request(`${ORIGIN}${TAB_PATH}?id=missing`))).status, 404)

  await fiber.dispose()
  assert.deepEqual(panel.tabs(), [])
})
