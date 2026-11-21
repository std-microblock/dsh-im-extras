/**
 * The plugin row config and its mount through cordis: the config cordis validates, and the listener, tools, prompt
 * section and `ctx.imDispatch` the service registers once every service it waits for is provided.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  Config, DISPATCHER_CHAT_PREFIX, DISPATCHER_TOOLS, ImDispatchService, TOOL_NAMES, WORKER_TOOLS,
} from '../src/index.ts'
import type { PromptSectionLike, SystemPromptLike } from '../src/types.ts'
import { CHAT_KEY, COMPOSITION, FakeIm, FakeStorage, FakeTasks, FakeTools } from './dispatch-fakes.ts'

/** Validate one row config the way cordis does (Standard Schema). */
function resolve(config: unknown): unknown {
  const result = Config['~standard'].validate(config)
  if (result instanceof Promise) throw new Error('async validation')
  if (result.issues !== undefined) throw new Error(result.issues.map(issue => issue.message).join('; '))
  return result.value
}

test('the config gets the shipped defaults and refuses an incomplete composition', () => {
  const resolved = resolve({ main: COMPOSITION, worker: COMPOSITION, workerOutput: 'summary' })
  assert.deepEqual(resolved, {
    main: COMPOSITION,
    worker: COMPOSITION,
    workerOutput: 'summary',
    prompts: {},
    tools: { main: DISPATCHER_TOOLS, worker: WORKER_TOOLS },
    ruleTimeoutMs: 50,
    ruleMemoryBytes: 16777216,
    maxRuleChars: 2000,
    maxRulesPerTask: 10,
    maxTaskMessages: 20,
    contextMessages: 5,
    maxSearchPages: 10,
    searchPageSize: 20,
    autoThread: true,
    threadlessPlatforms: ['qq', 'onebot', 'chronocat'],
    maxRouterSteps: 5,
    maxRouterDeltaMessages: 200,
    freshContextMessages: 20,
    chatNames: {},
    ambientDebounceMs: 3000,
    maxAutoRepliesPerHour: 6,
    chronicle: {
      enabled: true,
      reasoningEffort: 'off',
      compactMaxTokens: 256,
      queryMaxTokens: 1200,
      chunkSize: 32,
      maxEntries: 8000,
      timeoutMs: 20000,
    },
  })
  assert.throws(() => resolve(undefined))
  assert.throws(() => resolve({ main: COMPOSITION }))
  assert.throws(() => resolve({ main: COMPOSITION, worker: COMPOSITION, ruleTimeoutMs: 0 }))
})

test('the strategy mounts once its services exist, and routes the im/message waterfall', async () => {
  const ctx = new Context()
  const im = new FakeIm()
  const tools = new FakeTools()
  const sections: PromptSectionLike[] = []
  const systemPrompt: SystemPromptLike = { section: (section) => { sections.push(section); return () => {} } }
  ctx.provide('im', im as never)
  ctx.plugin(ImDispatchService, { main: COMPOSITION, worker: COMPOSITION, ambientDebounceMs: 15 } as never)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(tools.tools.size, 0)

  ctx.provide('imTasks', new FakeTasks(im))
  ctx.provide('storageDomain', new FakeStorage())
  ctx.provide('tools', tools)
  ctx.provide('systemPrompt', systemPrompt)
  // The service registers its listeners and tools once the rule engine and the stores are open.
  for (let waited = 0; tools.tools.size === 0 && waited < 20_000; waited += 20) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.deepEqual([...tools.tools.keys()].sort(), [...TOOL_NAMES].sort())
  assert.equal(sections[0]?.name, 'tool:im-dispatch')
  assert.ok(ctx.get('imDispatch') instanceof ImDispatchService)

  const message = im.store('hello')
  const outcome = await ctx.waterfall('im/message', {
    message,
    deliver: (target, options) => im.sessions.deliver(target, {
      ...options, id: options.id ?? message.key, content: options.content ?? [message],
    }),
  }, () => Promise.resolve({ kind: 'ignored' as const }))
  const routerKey = `${DISPATCHER_CHAT_PREFIX}${CHAT_KEY}`
  const routerId = `im-${routerKey}`
  assert.deepEqual(outcome, { kind: 'handled', by: 'dispatch', sessions: [routerId] })
  assert.match(im.texts(routerKey).join('\n'), /hello/)

  const botMsg = im.store('bot reply', {
    sender: { id: 'bot-user', name: 'Bot', isBot: true, self: true },
    addressed: false,
    mentions: { self: false, all: false, users: [] },
  })
  // Default wakeMode is 'mention', so reactions stay ignored until watch/auto is configured.
  ctx.emit('im/reaction', {
    action: 'added',
    emoji: 'THUMBSUP',
    chat: botMsg.chat,
    user: { id: 'u-1', name: 'Alice' },
    bot: { id: botMsg.chat.bot, selfId: 'bot-user' },
    message: botMsg,
    time: 2000,
    id: 'ev-plugin-0',
  })
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.doesNotMatch(im.texts(routerKey).join('\n'), /emoji="THUMBSUP"/)

  await tools.tools.get('configure_chat')!.execute(
    { wakeMode: 'watch' },
    { agent: { session: { id: routerId } } } as never,
  )
  ctx.emit('im/reaction', {
    action: 'added',
    emoji: 'THUMBSUP',
    chat: botMsg.chat,
    user: { id: 'u-1', name: 'Alice' },
    bot: { id: botMsg.chat.bot, selfId: 'bot-user' },
    message: botMsg,
    time: 2001,
    id: 'ev-plugin-1',
  })
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.match(im.texts(routerKey).join('\n'), /emoji="THUMBSUP"/)

  const text = sections[0]?.text
  assert.ok(typeof text === 'function')
  assert.match(text({ agent: { session: { id: routerId } } }), /前台 Router 会话/)

  // A guidance contribution is appended to the role's prompt and leaves with its disposer.
  const service = ctx.get('imDispatch') as ImDispatchService
  const dispose = service.prompt('router', '额外的路由规矩')
  assert.match(text({ agent: { session: { id: routerId } } }), /额外的路由规矩/)
  dispose()
  assert.doesNotMatch(text({ agent: { session: { id: routerId } } }), /额外的路由规矩/)

  // Operator chat configuration emits im-dispatch/chat and shows in chats().
  const seen: unknown[] = []
  ctx.on('im-dispatch/chat', (view) => { seen.push(view) })
  const view = await service.configureChat(CHAT_KEY, { replyMode: 'proactive' })
  assert.equal(view.replyMode, 'proactive')
  assert.equal(seen.length, 1)
  assert.equal((await service.chats()).find(chat => chat.chat === CHAT_KEY)?.replyMode, 'proactive')
})
